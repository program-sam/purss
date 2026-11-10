import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { newId } from "@purss/domain";
import type { OpmlImportDestination, OpmlImportDTO, OpmlImportEntryDTO, OpmlImportRequest } from "@purss/domain";
import { discover } from "@purss/connectors";
import type { DiscoveryDraft } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { bridgeClient } from "./bridge.ts";
import { emit } from "../app.ts";
import { HttpError, badRequest, consumeRateLimit, notFound, nowIso } from "../http.ts";
import { readSecret, removeSecret, writeSecret } from "../secrets.ts";
import { createCollection } from "./collections.ts";
import { isAccountUsable } from "./deletion.ts";
import { canonicalFeedKey, looksPrivateFeed, OPML_MAX_FEEDS } from "./opml.ts";
import { assertRoom, PlanLimit } from "./plans.ts";
import { followedSource, followSource, presentCandidates } from "./sources.ts";
import { newsCandidate } from "./news-address.ts";
import { httpUrlOrNull } from "./text-safety.ts";

/*
 * Following a list of feeds (OPML) on the server, one feed after the other. The person picks feeds in the
 * preview and the server keeps the list: closing the tab, signing out or restarting the server doesn't stop it,
 * and the progress is there when they come back. Each feed is looked up and followed exactly as Add source
 * would (discovery, the address rules, the candidate's token), with the title the file gave it, and each lookup is
 * counted against the account's discovery budget. Lists take turns, one feed each. A feed whose link carries a
 * secret has no address in the database; it waits in the secrets folder until it has been followed or the list ends.
 */

type EntryRow = { import_id: string; position: number; title: string; host: string; feed_url: string | null; folder: string | null; looks_private: number; state: OpmlImportEntryDTO["state"]; message: string | null; source_id: string | null };
type ImportRow = { id: string; account_id: string; workspace_id: string; file_name: string; destination: OpmlImportDestination["kind"]; collection_id: string | null; collection_name: string | null; status: OpmlImportDTO["status"]; created_at: string; finished_at: string | null };

/** Imports that have an entry in hand in this process: a list is followed one feed at a time. */
const inFlight = new Set<string>();
/** Lookups made for lists at this moment, across all lists. */
let workers = 0;
/** How many lookups run for lists at once, whatever the number of lists. */
const MAX_WORKERS = 2;
/**
 * How much of an account's lookups per ten minutes (the budget Add source draws on: 120) a list may use. The rest is
 * left for what the person does themselves, so a long list never locks them out of Add source.
 */
const BUDGET_SHARE = 100;
/** When an account's lookup budget is back, and when the engine of an account that has none yet is asked again. */
const blockedUntil = new Map<string, number>();
const ENGINE_WAIT_MS = 30_000;
/** Who was served last: lists take turns, one feed each. */
const lastTurn = new Map<string, number>();
let turn = 0;
const KEEP_FINISHED_DAYS = 30;

const secretName = (importId: string, position: number) => `opml-imports/${importId}/${position}`;

function removeImportSecrets(app: App, importId: string): void {
  rmSync(path.join(app.config.secretsDir, "opml-imports", importId), { recursive: true, force: true });
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function toDTO(app: App, row: ImportRow, withEntries: boolean): OpmlImportDTO {
  const counts = app.db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM opml_import_entries WHERE import_id = ? GROUP BY state", row.id);
  const n = (...states: string[]) => counts.filter((c) => states.includes(c.state)).reduce((sum, c) => sum + c.n, 0);
  const dto: OpmlImportDTO = {
    id: row.id, fileName: row.file_name, status: row.status, createdAt: row.created_at, finishedAt: row.finished_at,
    total: n("waiting", "working", "followed", "already", "failed"), followed: n("followed"), already: n("already"), failed: n("failed"), waiting: n("waiting", "working"),
  };
  if (!withEntries) return dto;
  dto.entries = app.db.all<EntryRow>("SELECT * FROM opml_import_entries WHERE import_id = ? ORDER BY position", row.id).map((e) => ({
    position: e.position, title: e.title, host: e.host, folder: e.folder, state: e.state, message: e.message, sourceId: e.source_id, looksPrivate: e.looks_private === 1,
  }));
  return dto;
}

function ownImport(app: App, p: Principal, id: string): ImportRow {
  const row = app.db.get<ImportRow>("SELECT * FROM opml_imports WHERE id = ? AND account_id = ? AND workspace_id = ?", id, p.accountId, p.workspaceId);
  if (!row) throw notFound("That import");
  return row;
}

/** Record the chosen feeds as a list to follow (`runOpmlImports` follows it). One list at a time per account. */
export function startOpmlImport(app: App, p: Principal, input: OpmlImportRequest): OpmlImportDTO {
  if (app.db.get("SELECT 1 FROM opml_imports WHERE account_id = ? AND status = 'running'", p.accountId)) {
    throw new HttpError(409, "import_running", "A list is already being followed. Wait for it to finish, or stop it first.");
  }
  const d = input.destination;
  if (d.kind === "collection" && !app.db.get("SELECT 1 FROM collections WHERE id = ? AND workspace_id = ? AND mode = 'sources'", d.id, p.workspaceId)) throw notFound("That collection");
  if (d.kind === "new" && !d.name.trim()) throw badRequest("Name the new collection first.");
  const seen = new Set<string>();
  const feeds: { title: string; feedUrl: string; folder: string | null; private: boolean }[] = [];
  for (const f of input.feeds) {
    const feedUrl = httpUrlOrNull(f.feedUrl);
    if (!feedUrl) continue;
    const key = canonicalFeedKey(feedUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    feeds.push({ title: f.title.trim().slice(0, 200) || hostOf(feedUrl), feedUrl, folder: f.folder?.trim().slice(0, 80) || null, private: looksPrivateFeed(feedUrl) });
  }
  if (!feeds.length) throw badRequest("None of those feeds has a web address to follow.");
  if (feeds.length > OPML_MAX_FEEDS) throw badRequest("That list is too long to follow at once.");

  const id = newId("opl");
  try {
    app.db.tx(() => {
      app.db.run("INSERT INTO opml_imports (id, account_id, workspace_id, file_name, destination, collection_id, collection_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)",
        id, p.accountId, p.workspaceId, input.fileName.slice(0, 200), d.kind, d.kind === "collection" ? d.id : null, d.kind === "new" ? d.name.trim().slice(0, 80) : null, nowIso());
      feeds.forEach((f, position) => {
        // A secret link never enters the database: it waits in the secrets folder, apart from the rest.
        if (f.private) writeSecret(app.config.secretsDir, secretName(id, position), f.feedUrl);
        app.db.run("INSERT INTO opml_import_entries (import_id, position, title, host, feed_url, folder, looks_private) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, position, f.title, hostOf(f.feedUrl), f.private ? null : f.feedUrl, f.folder, f.private ? 1 : 0);
      });
    });
  } catch (err) {
    removeImportSecrets(app, id);
    throw err;
  }
  return toDTO(app, ownImport(app, p, id), true);
}

export function listOpmlImports(app: App, p: Principal): OpmlImportDTO[] {
  return app.db.all<ImportRow>("SELECT * FROM opml_imports WHERE account_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 10", p.accountId, p.workspaceId).map((r) => toDTO(app, r, false));
}

export function getOpmlImport(app: App, p: Principal, id: string): OpmlImportDTO {
  return toDTO(app, ownImport(app, p, id), true);
}

/** End a running list after the feed being followed now; what is left stays unfollowed. */
export function stopOpmlImport(app: App, p: Principal, id: string): OpmlImportDTO {
  const row = ownImport(app, p, id);
  if (row.status === "running") {
    app.db.run("UPDATE opml_imports SET status = 'stopped', finished_at = ? WHERE id = ? AND status = 'running'", nowIso(), id);
    // A feed in hand finishes first and takes the links with it; with none in hand they go now.
    if (!inFlight.has(id)) removeImportSecrets(app, id);
  }
  return toDTO(app, ownImport(app, p, id), true);
}

/** Forget a finished list (its record only; the sources it followed stay). */
export function dismissOpmlImport(app: App, p: Principal, id: string): void {
  const row = ownImport(app, p, id);
  if (row.status === "running") throw badRequest("Stop the list first.", "import_running");
  // The folder first: if that fails the record stays, and forgetting it can be tried again.
  removeImportSecrets(app, id);
  app.db.tx(() => {
    app.db.run("DELETE FROM opml_import_entries WHERE import_id = ?", id);
    app.db.run("DELETE FROM opml_imports WHERE id = ?", id);
  });
}

export type OpmlImportDeps = {
  discover?: (url: string) => Promise<DiscoveryDraft>;
  /** Counts one lookup against the account's budget; tests replace it. */
  consume?: (key: string, max: number) => { allowed: boolean; resetAt: number };
  now?: () => number;
  /** How many feeds are looked up at once. */
  workers?: number;
};

/**
 * Follow the running lists a few feeds at a time. Lists take turns, one feed each, so a long list never holds the others
 * back; every lookup is counted against its account's discovery budget, and an account whose budget is used up waits for
 * it instead of failing its feeds. Called after a list is started and by the maintenance tick, which also picks lists
 * up again after a restart. Resolves when nothing is left that can be done now.
 */
export function runOpmlImports(app: App, deps: OpmlImportDeps = {}): Promise<void> {
  expireHistory(app);
  sweepLinkFolders(app);
  const started: Promise<void>[] = [];
  const limit = deps.workers ?? MAX_WORKERS;
  while (workers < limit) {
    workers++;
    started.push(work(app, deps).catch((err) => {
      console.error("[api] following a list of feeds failed; it will be tried again:", err instanceof Error ? err.message : err);
    }).finally(() => { workers--; }));
  }
  return Promise.all(started).then(() => undefined);
}

/** Finished lists are kept for a while; the record and anything left in the secrets folder go together. */
function expireHistory(app: App): void {
  const before = new Date(Date.now() - KEEP_FINISHED_DAYS * 86_400_000).toISOString();
  const old = app.db.all<{ id: string }>("SELECT id FROM opml_imports WHERE status <> 'running' AND finished_at < ?", before);
  for (const { id } of old) {
    removeImportSecrets(app, id);
    app.db.tx(() => {
      app.db.run("DELETE FROM opml_import_entries WHERE import_id = ?", id);
      app.db.run("DELETE FROM opml_imports WHERE id = ?", id);
    });
    lastTurn.delete(id);
  }
}

/**
 * Link folders that no running list can need: those of lists that are over (a stop or a crash can leave one) with no feed in hand,
 * and those no list owns (a crash while a list was being made). A running list's folder is never touched.
 */
function sweepLinkFolders(app: App): void {
  let names: string[];
  try { names = readdirSync(path.join(app.config.secretsDir, "opml-imports")); } catch { return; }
  for (const id of names) {
    const row = app.db.get<{ status: string }>("SELECT status FROM opml_imports WHERE id = ?", id);
    if (row?.status === "running" || inFlight.has(id)) continue;
    removeImportSecrets(app, id);
  }
}

const settleRow = (app: App, importId: string, position: number, state: OpmlImportEntryDTO["state"], message: string | null, sourceId: string | null = null): void => {
  app.db.run("UPDATE opml_import_entries SET state = ?, message = ?, source_id = ? WHERE import_id = ? AND position = ?", state, message, sourceId, importId, position);
};

/** Why the account's plan has no room for another followed source, or null when it has (always null when self-hosted or unlimited). */
function noRoomFor(app: App, accountId: string): string | null {
  try {
    assertRoom(app, accountId, "sources");
    return null;
  } catch (err) {
    if (err instanceof PlanLimit) return err.message;
    throw err;
  }
}

function principalOf(row: ImportRow): Principal {
  return { accountId: row.account_id, workspaceId: row.workspace_id, isAdmin: false, sessionId: "opml-import", csrf: "", authAt: nowIso() };
}

async function work(app: App, deps: OpmlImportDeps): Promise<void> {
  for (;;) {
    const next = takeTurn(app, deps);
    if (!next) return;
    try {
      await followEntry(app, next.row, next.entry, deps);
    } finally {
      inFlight.delete(next.row.id);
      // A list stopped while this feed was in hand: nothing of it is looked at again, so its private links go.
      if (app.db.get<{ status: string }>("SELECT status FROM opml_imports WHERE id = ?", next.row.id)?.status !== "running") removeImportSecrets(app, next.row.id);
    }
  }
}

/**
 * The next feed to look up: the list that was served longest ago, if its account may look something up now. Settles lists
 * that have nothing left, and entries that already have their source (a replay after a restart). Marks the feed in hand.
 */
function takeTurn(app: App, deps: OpmlImportDeps): { row: ImportRow; entry: EntryRow } | null {
  const now = deps.now?.() ?? Date.now();
  const consume = deps.consume ?? ((key: string, max: number) => consumeRateLimit(key, max));
  const rows = app.db.all<ImportRow>("SELECT * FROM opml_imports WHERE status = 'running' ORDER BY created_at")
    .sort((a, b) => (lastTurn.get(a.id) ?? 0) - (lastTurn.get(b.id) ?? 0));
  for (const row of rows) {
    if (inFlight.has(row.id) || !isAccountUsable(app, row.account_id) || (blockedUntil.get(row.account_id) ?? 0) > now) continue;
    for (;;) {
      const entry = app.db.get<EntryRow>("SELECT * FROM opml_import_entries WHERE import_id = ? AND state IN ('waiting', 'working') ORDER BY position LIMIT 1", row.id);
      if (!entry) {
        app.db.run("UPDATE opml_imports SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running'", nowIso(), row.id);
        removeImportSecrets(app, row.id);
        emit(app, row.account_id, { type: "source", sourceId: "" });
        break;
      }
      // Its source was made before the process stopped: the entry says so, nothing is looked up or followed again.
      if (entry.source_id && app.db.get("SELECT 1 FROM sources WHERE id = ? AND followed = 1", entry.source_id)) {
        app.db.run("UPDATE opml_import_entries SET state = 'followed' WHERE import_id = ? AND position = ?", row.id, entry.position);
        if (entry.looks_private) removeSecret(app.config.secretsDir, secretName(row.id, entry.position));
        continue;
      }
      // A PURSS that is not connected to the engine yet can't follow anything: ask again shortly, without spending lookups.
      if (!app.db.get("SELECT 1 FROM engine_users WHERE account_id = ?", row.account_id)) { blockedUntil.set(row.account_id, now + ENGINE_WAIT_MS); break; }
      // The plan's limit is checked before every follow, as Add source does: a feed that can't be followed costs no lookup. One the
      // account already follows is still recognised, from its own address, and counted as followed once.
      const full = noRoomFor(app, row.account_id);
      if (full) {
        const link = entry.feed_url ?? readSecret(app.config.secretsDir, secretName(row.id, entry.position));
        const have = link ? followedSource(app, principalOf(row), link) : undefined;
        settleRow(app, row.id, entry.position, have ? "already" : "failed", have ? null : full, have?.id ?? null);
        if (entry.looks_private) removeSecret(app.config.secretsDir, secretName(row.id, entry.position));
        continue;
      }
      const budget = consume(`discover:${row.account_id}`, BUDGET_SHARE);
      if (!budget.allowed) { blockedUntil.set(row.account_id, budget.resetAt); break; }
      inFlight.add(row.id);
      lastTurn.set(row.id, ++turn);
      app.db.run("UPDATE opml_import_entries SET state = 'working' WHERE import_id = ? AND position = ?", row.id, entry.position);
      return { row, entry };
    }
  }
  return null;
}

/** Where a followed feed goes: an existing collection, a new one made together with the follow, or none (with a note when it can't be). */
type Target = { target: { id: string } | { name: string } | null; note: string | null };

/**
 * The collection a feed goes into. A folder or a new collection that doesn't exist yet is not made here: its name goes with the
 * follow, which makes it in the same step as the source, so a follow the plan refuses leaves no empty collection behind (and the next
 * feed of that folder finds the one the first follow made).
 */
function collectionFor(app: App, row: ImportRow, p: Principal, entry: EntryRow): Target {
  const named = (name: string): Target => {
    const existing = app.db.get<{ id: string; mode: string }>("SELECT id, mode FROM collections WHERE workspace_id = ? AND lower(name) = lower(?)", p.workspaceId, name);
    if (!existing) return { target: { name: name.trim() }, note: null };
    return existing.mode === "sources" ? { target: { id: existing.id }, note: null } : { target: null, note: `Not put in “${name}”: a filter collection has that name.` };
  };
  switch (row.destination) {
    case "none": return { target: null, note: null };
    case "collection": return { target: row.collection_id ? { id: row.collection_id } : null, note: null };
    case "new": return named(row.collection_name!);
    case "folders": return entry.folder ? named(entry.folder) : { target: null, note: null };
  }
}

async function followEntry(app: App, row: ImportRow, entry: EntryRow, deps: OpmlImportDeps): Promise<void> {
  const look = deps.discover ?? ((url: string) => discover(url, { bridge: bridgeClient(app) }));
  const dropLink = () => { if (entry.looks_private) removeSecret(app.config.secretsDir, secretName(row.id, entry.position)); };
  const settle = (state: OpmlImportEntryDTO["state"], message: string | null, sourceId: string | null = null) => settleRow(app, row.id, entry.position, state, message, sourceId);
  const p = principalOf(row);
  try {
    const feedUrl = entry.feed_url ?? readSecret(app.config.secretsDir, secretName(row.id, entry.position));
    if (!feedUrl) { settle("failed", "This feed's private link is no longer here. Import the list again."); return; }
    // This installation's own news is recognised without asking the site (services/news.ts).
    const news = newsCandidate(app, feedUrl);
    const found = news ? { ok: true as const, url: feedUrl, candidates: [news] } : await look(feedUrl);
    // Stopped while the site was being asked: this one is left as it was.
    if (app.db.get<{ status: string }>("SELECT status FROM opml_imports WHERE id = ?", row.id)?.status !== "running") {
      app.db.run("UPDATE opml_import_entries SET state = 'waiting' WHERE import_id = ? AND position = ?", row.id, entry.position);
      return;
    }
    if (!found.ok) { settle("failed", found.message || "That address couldn't be followed."); dropLink(); return; }
    const key = canonicalFeedKey(feedUrl);
    const exact = found.candidates.find((c) => { try { return canonicalFeedKey(c.feedUrl) === key; } catch { return false; } });
    const chosen = exact ?? (found.candidates.length === 1 ? found.candidates[0] : undefined);
    if (!chosen) {
      settle("failed", found.candidates.length ? "More than one feed was found there. Add it from Add source to choose the right one." : "No feed was found at that address.");
      dropLink();
      return;
    }
    const [held] = presentCandidates(app, p, [chosen]);
    if (held!.alreadyFollowingSourceId) { settle("already", null, held!.alreadyFollowingSourceId); dropLink(); return; }
    const where = collectionFor(app, row, p, entry);
    // The file's title is the person's own name for it; without one, what the feed calls itself.
    const named = entry.title !== entry.host;
    // The source and the entry's settlement are one step: a stop in between can't leave a source the list doesn't know of
    // (a private feed has no address to find it by, and would be followed a second time).
    let made: string | null = null;
    try {
      app.db.tx(() => {
        const source = followSource(app, p, {
          token: held!.token, collectionId: where.target && "id" in where.target ? where.target.id : null, newCollectionName: where.target && "name" in where.target ? where.target.name : null,
          showOnHome: true, markPrivate: entry.looks_private === 1 || !!chosen.privateWarning,
          fullText: false, ...(named ? { title: entry.title } : {}),
        });
        made = source.id;
        settle("followed", where.note, source.id);
      });
    } catch (err) {
      // The source was made and then the settlement failed: all of it was rolled back, but not the file followSource wrote for a private link.
      if (made && !app.db.get("SELECT 1 FROM sources WHERE id = ?", made)) removeSecret(app.config.secretsDir, `source-urls/${made}`);
      throw err;
    }
    dropLink();
  } catch (err) {
    // The collection engine is not ready yet (a new PURSS): this feed and the rest wait for the next pass.
    if (err instanceof HttpError && err.code === "engine_pending") {
      app.db.run("UPDATE opml_import_entries SET state = 'waiting' WHERE import_id = ? AND position = ?", row.id, entry.position);
      blockedUntil.set(row.account_id, (deps.now?.() ?? Date.now()) + ENGINE_WAIT_MS);
      return;
    }
    settle("failed", err instanceof HttpError ? err.message : "Something went wrong while following this feed.");
    dropLink();
  }
}
