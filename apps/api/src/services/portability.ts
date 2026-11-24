import { dropCandidate, peekCandidate } from "./discovery-cache.ts";
import type { ImportResult } from "@purss/domain";
export type { ImportResult };
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { ANNOTATIONS_PER_ITEM, DEFAULT_PREFERENCES, ITEM_KINDS, checkQuery, measureBytes, newId } from "@purss/domain";
import type { AnnotationDTO, ImportPreview, WorkflowState } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit, emit } from "../app.ts";
import { HttpError, addSeconds, badRequest, conflict, notFound, nowIso } from "../http.ts";
import { randomToken, removeSecret, writeSecret } from "../secrets.ts";
import { enqueue } from "./jobs.ts";
import { STATE_RECORD_BYTES, checkGrowth, diskInfo, diskOverride, recordObject, reservedBytes, usedBytes, allowance } from "./storage.ts";
import { NO_TITLE, sanitize } from "./content.ts";
import { prepareVersion, restoreItem, restoreVersion, versionBytes } from "./item-store.ts";
import type { RestoredCapture, RestoredVersion } from "./item-store.ts";
import { markMembershipChanged } from "./state.ts";
import { preferencesPatchSchema, setPreferences } from "./preferences.ts";
import { makeSlug } from "./shares.ts";
import { todayFor } from "./item-reminders.ts";
import {
  ARCHIVE_FORMAT, ARCHIVE_OMITTED, ARCHIVE_SCHEMA_VERSION, ArchiveError, countJsonValues, parseArchive, sha256Hex,
} from "./archive-format.ts";
import type { Archive, ArchiveCollection, ArchiveItem, ArchiveSource, SectionName } from "./archive-format.ts";
import { bridgeAddress, feedKey, insertSource, privateFeedKey, reviveSource, sourceIndex } from "./source-identity.ts";
import { hasCredentialShape, httpUrlOrNull, plainText } from "./text-safety.ts";
import { fullTextAvailable } from "./captures.ts";
import { annotationBytes, indexAnnotation } from "./annotations.ts";
import { PlanLimit, assertRoom } from "./plans.ts";
import { IMAGES_PER_ITEM, IMAGE_BYTES_PER_ITEM } from "./images.ts";
import { pictureType } from "@purss/connectors";
import { server } from "@purss/translations/server";

/*
 * PURSS export and import. The archive format is documented
 * in archive-format.ts. Export is a streamed, snapshot-consistent read that never touches the
 * storage ledger, so it works while an account is over its storage allowance. Import runs in one transaction
 * with a single admission check: it either lands completely or not at all.
 */

// ====================================================================== export

export type ExportSink = (chunk: string) => void | Promise<void>;
export type ExportSummary = { counts: Record<SectionName, number>; bytes: number };

const activeExports = new Set<string>();
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

type SourceRow = { id: string; kind: string; title: string; origin: string; site_url: string | null; feed_url: string | null; is_private: number; curator: string | null; hue: number; followed: number; paused: number; notify: string; full_text: number; created_at: string; last_item_at: string | null };

/** A source whose address must not leave the server: flagged private, or its address carries a credential. */
function isPrivateSource(s: { kind: string; feed_url: string | null; is_private: number }): boolean {
  if (s.kind === "manual") return false;
  return s.is_private === 1 || s.kind === "private" || (s.feed_url !== null && hasCredentialShape(s.feed_url));
}

const TEXT_TAGS = ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s", "sub", "sup", "small", "mark",
  "ul", "ol", "li", "dl", "dt", "dd", "a", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "abbr", "cite", "q", "time", "span", "div"];

/** Drop every link and image address from already-sanitized HTML (used for items of private sources). */
function stripAddresses(html: string | null): string | null {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: TEXT_TAGS,
    allowedAttributes: { "*": ["title", "alt", "colspan", "rowspan", "scope", "datetime"] },
  });
}

/**
 * Stream the whole PURSS as one JSON document. `write` receives chunks and may apply
 * back-pressure by returning a promise. Reads use a private read-only connection inside a
 * single read transaction, so the file is a consistent snapshot even while the app keeps writing.
 */
export async function streamExport(app: App, p: Principal, write: ExportSink): Promise<ExportSummary> {
  if (activeExports.has(p.accountId)) throw new HttpError(429, "busy", server.api.portability.exportRunning);
  activeExports.add(p.accountId);
  const snap = new DatabaseSync(app.config.dbFile, { readOnly: true });
  try {
    snap.exec("PRAGMA busy_timeout = 5000");
    snap.exec("BEGIN");
    snap.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); // pin the snapshot
    const all = <T>(sql: string, ...params: (string | number | null)[]) => snap.prepare(sql).all(...params) as T[];
    const iterate = <T>(sql: string, ...params: (string | number | null)[]) => snap.prepare(sql).iterate(...params) as Iterable<T>;
    const ws = p.accountId;

    const sources = all<SourceRow>(
      "SELECT id, kind, title, origin, site_url, feed_url, is_private, curator, hue, followed, paused, notify, full_text, created_at, last_item_at FROM sources WHERE account_id = ? ORDER BY created_at, id", ws);
    const privateIds = new Set(sources.filter(isPrivateSource).map((s) => s.id));
    const pendingCaptures = all<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE account_id = ? AND status = 'pending'", ws)[0]!.n;
    const omitted = [...ARCHIVE_OMITTED];
    if (privateIds.size) omitted.push(server.api.portability.privateSourcesExported(privateIds.size));
    if (pendingCaptures) omitted.push(server.api.portability.capturesNotIncluded(pendingCaptures));

    let buffer = "";
    let bytes = 0;
    const emitText = async (text: string, force = false) => {
      buffer += text;
      if (force || buffer.length >= 64 * 1024) {
        const out = buffer;
        buffer = "";
        bytes += Buffer.byteLength(out);
        await write(out);
      }
    };
    const manifest = {} as Record<SectionName, { count: number; sha256: string }>;

    const array = async (name: SectionName, rows: Iterable<unknown>) => {
      const hash = createHash("sha256");
      let count = 0;
      await emitText(`,${JSON.stringify(name)}:[`);
      hash.update("[");
      for (const row of rows) {
        const piece = (count ? "," : "") + JSON.stringify(row);
        hash.update(piece);
        await emitText(piece);
        if (++count % 200 === 0) await yieldToLoop();
      }
      hash.update("]");
      await emitText("]");
      manifest[name] = { count, sha256: hash.digest("hex") };
    };
    const object = async (name: SectionName, value: unknown) => {
      const json = JSON.stringify(value);
      await emitText(`,${JSON.stringify(name)}:${json}`);
      manifest[name] = { count: 1, sha256: sha256Hex(json) };
    };

    await emitText(`{"format":${JSON.stringify(ARCHIVE_FORMAT)},"schemaVersion":${ARCHIVE_SCHEMA_VERSION},"exportedAt":${JSON.stringify(nowIso())},"omitted":${JSON.stringify(omitted)}`);

    await array("sources", sources.map((s) => {
      const priv = privateIds.has(s.id);
      return {
        id: s.id, kind: priv ? "private" : s.kind, title: s.title, origin: s.origin,
        siteUrl: priv ? null : s.site_url, feedUrl: priv ? null : s.feed_url, isPrivate: priv, reconnectRequired: priv,
        curator: s.curator, hue: s.hue, followed: s.followed === 1, paused: s.paused === 1, notify: s.notify, fullText: !priv && s.full_text === 1, createdAt: s.created_at, lastItemAt: s.last_item_at,
      };
    }));

    await array("collections", (function* () {
      for (const c of iterate<{ id: string; name: string; emoji: string | null; mode: string; view: string; query: string | null; show_on_home: number; position: number; created_at: string }>(
        "SELECT id, name, emoji, mode, view, query, show_on_home, position, created_at FROM collections WHERE account_id = ? ORDER BY position, created_at", ws)) {
        yield {
          id: c.id, name: c.name, emoji: c.emoji, mode: c.mode, view: c.view, query: c.query ? JSON.parse(c.query) : null, showOnHome: c.show_on_home === 1,
          position: c.position, createdAt: c.created_at,
          sourceIds: all<{ source_id: string }>("SELECT source_id FROM collection_sources WHERE collection_id = ? ORDER BY source_id", c.id).map((r) => r.source_id),
        };
      }
    })());

    await array("baskets", all<{ id: string; name: string; capture_mode: string; view: string; position: number; created_at: string }>(
      "SELECT id, name, capture_mode, view, position, created_at FROM baskets WHERE account_id = ? ORDER BY position, created_at", ws)
      .map((b) => ({ id: b.id, name: b.name, captureMode: b.capture_mode, view: b.view, position: b.position, createdAt: b.created_at })));

    await array("memberships", all<{ basket_id: string; item_id: string; version_id: string; kept_at: string }>(
      "SELECT basket_id, item_id, version_id, kept_at FROM basket_items WHERE account_id = ? ORDER BY kept_at, basket_id, item_id", ws)
      .map((m) => ({ basketId: m.basket_id, itemId: m.item_id, versionId: m.version_id, keptAt: m.kept_at })));

    await array("items", (function* () {
      type ItemRow = { id: string; number: number; source_id: string | null; kind: string; title: string; url: string | null; author: string | null; image_url: string | null; duration_seconds: number | null; doi: string | null;
        curator_note: string | null; published_at: string | null; discovered_at: string; listed_at: string; created_at: string; enclosures: string | null; current_version_id: string | null; workflow: string; is_new: number; progress: number; opened_at: string | null };
      for (const i of iterate<ItemRow>(
        `SELECT i.id, i.number, i.source_id, i.kind, i.title, i.url, i.author, i.image_url, i.duration_seconds, i.doi, i.curator_note, i.published_at, i.discovered_at, i.listed_at, i.created_at,
                i.enclosures, i.current_version_id, st.workflow, st.is_new, st.progress, st.opened_at
         FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.account_id = ? ORDER BY i.seq`, ws)) {
        const priv = i.source_id !== null && privateIds.has(i.source_id);
        const link = (u: string | null) => (u && (priv || hasCredentialShape(u)) ? null : u);
        const html = (h: string | null) => (priv ? stripAddresses(h) : h);
        const versions = all<{ id: string; title: string; url: string | null; summary_html: string | null; content_html: string | null; content_omitted: number; created_at: string }>(
          "SELECT id, title, url, summary_html, content_html, content_omitted, created_at FROM item_versions WHERE item_id = ? ORDER BY created_at, id", i.id);
        const captures = all<{ id: string; kind: string; status: string; title: string | null; text: string | null; html: string | null; final_url: string | null; error: string | null; quality: string | null; partial_reason: string | null; created_at: string; completed_at: string | null }>(
          "SELECT id, kind, status, title, text, html, final_url, error, quality, partial_reason, created_at, completed_at FROM captures WHERE item_id = ? AND status IN ('done', 'failed') ORDER BY created_at, id", i.id);
        const guids = priv ? [] : all<{ original_guid: string }>("SELECT DISTINCT original_guid FROM external_ids WHERE item_id = ? AND original_guid IS NOT NULL ORDER BY original_guid LIMIT 5", i.id)
          .map((g) => g.original_guid).filter((g) => !hasCredentialShape(g));
        const enclosures = (JSON.parse(i.enclosures ?? "[]") as { url: string; type: string | null; length?: number | null }[])
          .filter((e) => link(e.url)).map((e) => ({ url: e.url, type: e.type, length: e.length ?? null }));
        yield {
          id: i.id, number: i.number, sourceId: i.source_id, kind: i.kind, title: i.title, url: link(i.url), urlRedacted: i.url !== null && link(i.url) === null,
          author: i.author, imageUrl: link(i.image_url), durationSeconds: i.duration_seconds, doi: i.doi, curatorNote: i.curator_note,
          publishedAt: i.published_at, discoveredAt: i.discovered_at, listedAt: i.listed_at, createdAt: i.created_at, enclosures, currentVersionId: i.current_version_id,
          versions: versions.map((v) => ({ id: v.id, title: v.title, url: link(v.url), summaryHtml: html(v.summary_html), contentHtml: html(v.content_html), contentOmitted: v.content_omitted === 1, createdAt: v.created_at })),
          captures: captures.map((c) => ({ id: c.id, kind: c.kind, status: c.status, title: c.title, text: c.text, html: html(c.html), finalUrl: link(c.final_url), error: c.error, quality: c.quality, partialReason: c.partial_reason, createdAt: c.created_at, completedAt: c.completed_at })),
          state: { workflow: i.workflow, isNew: i.is_new === 1, progress: i.progress, openedAt: i.opened_at },
          originalGuids: guids,
        };
      }
    })());

    const prefRow = all<{ value: string }>("SELECT value FROM preferences WHERE account_id = ?", ws)[0];
    const stored = prefRow ? (JSON.parse(prefRow.value) as Record<string, unknown>) : {};
    await object("preferences", { ...DEFAULT_PREFERENCES, ...stored });

    await array("stateLog", (function* () {
      for (const l of iterate<{ item_id: string; from_state: string; to_state: string; at: string }>(
        "SELECT item_id, from_state, to_state, at FROM state_log WHERE account_id = ? ORDER BY seq", ws)) {
        yield { itemId: l.item_id, from: l.from_state, to: l.to_state, at: l.at };
      }
    })());

    await array("annotations", (function* () {
      type Row = { id: string; item_id: string; kind: string; quote_exact: string | null; quote_prefix: string | null; quote_suffix: string | null; pos_start: number | null; pos_end: number | null;
        target_kind: string | null; target_id: string | null; body: string | null; created_at: string; updated_at: string };
      for (const a of iterate<Row>(
        `SELECT id, item_id, kind, quote_exact, quote_prefix, quote_suffix, pos_start, pos_end, target_kind, target_id, body, created_at, updated_at
         FROM annotations WHERE account_id = ? AND deleted_at IS NULL ORDER BY seq`, ws)) {
        yield {
          id: a.id, itemId: a.item_id, kind: a.kind,
          quote: a.quote_exact !== null ? { exact: a.quote_exact, prefix: a.quote_prefix ?? "", suffix: a.quote_suffix ?? "" } : null,
          position: a.pos_start !== null && a.pos_end !== null ? { start: a.pos_start, end: a.pos_end } : null,
          target: a.target_kind && a.target_id ? { kind: a.target_kind, id: a.target_id } : null,
          body: a.body, createdAt: a.created_at, updatedAt: a.updated_at,
        };
      }
    })());

    // The pictures kept with items. Items of private sources keep none, and none of their addresses leave the server.
    if (all("SELECT 1 FROM item_images WHERE account_id = ? LIMIT 1", ws).length) {
      await array("images", (function* () {
        for (const im of iterate<{ item_id: string; source_id: string | null; url: string; role: string; content_type: string; sha256: string; data: Uint8Array }>(
          `SELECT g.item_id, i.source_id, g.url, g.role, g.content_type, g.sha256, g.data FROM item_images g JOIN items i ON i.id = g.item_id
           WHERE g.account_id = ? ORDER BY i.seq, g.created_at, g.id`, ws)) {
          if (im.source_id !== null && privateIds.has(im.source_id)) continue;
          yield { itemId: im.item_id, url: im.url, role: im.role, contentType: im.content_type, sha256: im.sha256, data: Buffer.from(im.data).toString("base64") };
        }
      })());
    }

    // Sharing settings of baskets and collections, with their public notes.
    if (all("SELECT 1 FROM shares WHERE account_id = ? LIMIT 1", ws).length) {
      await array("shares", all<{ id: string; target_kind: string; target_id: string; curator_name: string; description: string | null; listed: number }>(
        "SELECT id, target_kind, target_id, curator_name, description, listed FROM shares WHERE account_id = ? ORDER BY created_at, id", ws)
        .map((sh) => ({
          targetKind: sh.target_kind, targetId: sh.target_id, curatorName: sh.curator_name, description: sh.description, listed: sh.listed === 1,
          notes: all<{ item_id: string; note: string }>("SELECT item_id, note FROM share_notes WHERE share_id = ? ORDER BY item_id", sh.id).map((n) => ({ itemId: n.item_id, note: n.note })),
        })));
    }

    // The days set with "Remind me" on kept items, with their notes.
    if (all("SELECT 1 FROM item_reminders WHERE account_id = ? LIMIT 1", ws).length) {
      await array("itemReminders", (function* () {
        for (const r of iterate<{ item_id: string; remind_on: string; note: string | null }>("SELECT item_id, remind_on, note FROM item_reminders WHERE account_id = ? ORDER BY remind_on, id", ws)) {
          yield { itemId: r.item_id, remindOn: r.remind_on, note: r.note };
        }
      })());
    }

    await emitText(`,"manifest":${JSON.stringify({ algorithm: "sha256", sections: manifest })}}`, true);
    return { counts: Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.count])) as Record<SectionName, number>, bytes };
  } finally {
    try { snap.exec("COMMIT"); } catch { /* the snapshot is read-only; nothing to commit */ }
    snap.close();
    activeExports.delete(p.accountId);
  }
}

// ====================================================================== import

type Version = ArchiveItem["versions"][number];

type PreparedVersion = RestoredVersion & { archiveId: string | null };
type PreparedCapture = RestoredCapture & { archiveId: string };
type PreparedItem = {
  url: string | null; imageUrl: string | null; enclosures: { url: string; type: string | null; length: number | null }[]; kind: string;
  versions: PreparedVersion[]; currentId: string; captures: PreparedCapture[];
  discoveredAt: string; publishedAt: string | null; listedAt: string; createdAt: string; stateBytes: number; bytes: number;
};

type SourceDecision =
  | { action: "reuse"; id: string; refollow: boolean; src: ArchiveSource; feedUrl: string | null }
  | { action: "create"; id: string; mode: "follow" | "reconnect" | "unfollowed" | "manual"; src: ArchiveSource; feedUrl: string | null };
type ItemDecision =
  | { action: "create"; id: string; sourceId: string; item: ArchiveItem; prepared: PreparedItem }
  | { action: "match"; id: string; item: ArchiveItem; prepared: PreparedItem }
  | { action: "alias"; id: string; of: Exclude<ItemDecision, { action: "alias" }> };
type MembershipPlan = { basketId: string; itemId: string; archiveItemId: string; archiveVersionId: string | null; keptAt: string };

type ImportPlan = {
  sources: Map<string, SourceDecision>;
  baskets: Map<string, { id: string; create: Archive["baskets"][number] | null }>;
  collections: Map<string, { id: string; create: ArchiveCollection | null; skip: boolean; src: ArchiveCollection }>;
  items: Map<string, ItemDecision>;
  memberships: MembershipPlan[];
  /** Workflow changes to add, mapped to the item ids this import settles on; rows already present are left out. */
  stateLog: { itemId: string; from: WorkflowState; to: WorkflowState; at: string }[];
  /** Existing items that get history from this import and have no small "state" record yet. */
  stateRecords: string[];
  /** Highlights and notes to add, on the item this import settles on; ones already there are left out. */
  annotations: (AnnotationDTO & { bytes: number })[];
  /** Pictures kept with items, on the item this import settles on; ones already there are left out. */
  pictures: { id: string; itemId: string; url: string; role: "cover" | "inline"; contentType: string; sha256: string; data: Buffer; bytes: number }[];
  /** "Remind me" days that land on the items this import settles on: the day and the note. */
  reminders: { itemId: string; remindOn: string; note: string | null }[];
  conflicts: string[];
  requiredBytes: number;
  counts: Record<string, number>;
  needsEngine: boolean;
};

const ISO_FALLBACK = (v: string | null | undefined, fallback: string): string => {
  if (!v) return fallback;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
};

function safeAddress(raw: string | null): string | null {
  const href = httpUrlOrNull(raw, 4000);
  return href && !hasCredentialShape(href) ? href : null;
}

/**
 * The public address an archive source is followed at, or null when it is a private one: flagged, shaped like one, or without an address to
 * follow it at. A bridged source keeps its descriptor: it is no link, so never private.
 */
function publicAddress(src: ArchiveSource): string | null {
  const href = safeAddress(src.feedUrl) ?? bridgeAddress(src.feedUrl);
  const priv = src.isPrivate || src.reconnectRequired || src.kind === "private" || (src.feedUrl !== null && hasCredentialShape(src.feedUrl));
  return priv ? null : href;
}

function prepareItem(item: ArchiveItem, now: string): PreparedItem {
  const url = item.urlRedacted ? null : safeAddress(item.url);
  const imageUrl = safeAddress(item.imageUrl);
  const enclosures = item.enclosures.flatMap((e) => { const u = safeAddress(e.url); return u ? [{ url: u, type: e.type, length: e.length }] : []; });
  const kind = (ITEM_KINDS as readonly string[]).includes(item.kind) ? item.kind : "article";
  const discoveredAt = ISO_FALLBACK(item.discoveredAt, ISO_FALLBACK(item.createdAt, now));
  const publishedAt = item.publishedAt ? ISO_FALLBACK(item.publishedAt, "") || null : null;
  const createdAt = ISO_FALLBACK(item.createdAt, discoveredAt);
  const listedAt = ISO_FALLBACK(item.listedAt, publishedAt ?? discoveredAt);

  const rawVersions: Version[] = item.versions.length
    ? item.versions
    : [{ id: `${item.id}:v`, title: item.title, url: item.url, summaryHtml: null, contentHtml: null, contentOmitted: false, createdAt: item.createdAt }];
  const versions: PreparedVersion[] = rawVersions.map((v) => {
    const vUrl = item.urlRedacted ? null : safeAddress(v.url);
    const title = v.title.trim() || item.title.trim() || NO_TITLE;
    const { summaryHtml, contentHtml, hash } = prepareVersion({ title, url: vUrl, summaryHtml: v.summaryHtml, contentHtml: v.contentHtml });
    return {
      archiveId: v.id, id: newId("ver"), title, url: vUrl, summaryHtml, contentHtml, hash, contentOmitted: v.contentOmitted, createdAt: ISO_FALLBACK(v.createdAt, createdAt),
      bytes: versionBytes({ title, url: vUrl, author: item.author, summaryHtml, contentHtml, imageUrl, enclosures, publishedAt }),
    };
  });
  const current = versions.find((v) => v.archiveId === item.currentVersionId) ?? versions[versions.length - 1]!;

  // An item has at most one browser capture, and only a finished one: keep the newest.
  const browser = item.captures.filter((c) => c.kind === "browser" && c.status === "done").sort((a, b) => (a.completedAt ?? a.createdAt ?? "").localeCompare(b.completedAt ?? b.createdAt ?? "")).at(-1);
  const captures: PreparedCapture[] = item.captures.filter((c) => c.kind === "fulltext" || c === browser).map((c) => {
    const done = c.status === "done";
    // A copy with no plain text or no markup stays as it was: the reader shows the one with markup, and the reading time follows it.
    const text = done ? c.text : null;
    const html = done && c.html !== null ? sanitize(c.html) ?? "" : null;
    const finalUrl = safeAddress(c.finalUrl);
    return {
      archiveId: c.id, id: newId("cap"), kind: c.kind, status: c.status, title: c.title, text, html, finalUrl, error: done ? null : plainText(c.error, 500) || null,
      quality: done && c.kind === "fulltext" ? c.quality : null, partialReason: done && c.kind === "fulltext" && c.quality === "partial" ? c.partialReason : null,
      createdAt: ISO_FALLBACK(c.createdAt, createdAt), completedAt: c.completedAt ? ISO_FALLBACK(c.completedAt, createdAt) : null,
      bytes: done ? measureBytes({ title: c.title, text, html, finalUrl }) : 0,
    };
  });
  const nonDefault = item.state.workflow !== "undecided" || item.state.progress > 0 || item.state.openedAt !== null;
  const stateBytes = nonDefault ? STATE_RECORD_BYTES : 0;
  return {
    url, imageUrl, enclosures, kind, versions, currentId: current.id, captures,
    discoveredAt, publishedAt, listedAt, createdAt, stateBytes,
    bytes: versions.reduce((n, v) => n + v.bytes, 0) + captures.reduce((n, c) => n + c.bytes, 0) + stateBytes,
  };
}

const lower = (s: string) => s.trim().toLowerCase();
const PRIVATE_NOTE = server.api.portability.reconnectNote;

function planImport(app: App, p: Principal, doc: Archive): ImportPlan {
  const now = nowIso();
  const conflicts: string[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  const ws = p.accountId;

  // ---- sources
  const sources = new Map<string, SourceDecision>();
  const have = sourceIndex(app, ws);
  // A private source's address is not in an archive, so each source in the file is its own (two can share a title), and one already here
  // is found by its title, standing for at most one of them: the one the file names by the id it has here (a file from this very PURSS),
  // else the first of that title not yet taken.
  const existingByTitle = new Map<string, { id: string }[]>();
  for (const e of app.db.all<{ id: string; title: string }>("SELECT id, title FROM sources WHERE account_id = ? AND is_private = 1 ORDER BY created_at, id", ws)) {
    const same = existingByTitle.get(lower(e.title));
    if (same) same.push(e); else existingByTitle.set(lower(e.title), [e]);
  }
  const existingPrivate = new Map<string, string>(); // archive id -> the private source here it stands for
  const taken = new Set<string>();
  const privateInFile = doc.sources.filter((src) => src.kind !== "manual" && !publicAddress(src));
  for (const own of [true, false]) {
    for (const src of privateInFile) {
      if (existingPrivate.has(src.id)) continue;
      const here = (existingByTitle.get(lower(src.title)) ?? []).find((e) => !taken.has(e.id) && (!own || e.id === src.id));
      if (here) { existingPrivate.set(src.id, here.id); taken.add(here.id); }
    }
  }
  const existingManual = app.db.get<{ id: string }>("SELECT id FROM sources WHERE account_id = ? AND kind = 'manual'", ws)?.id ?? null;
  // The source planned for a feed's key: the same feed twice in one archive is one source.
  const plannedFeeds = new Map<string, string>();
  // Existing sources the archive follows again, so that one written two ways is taken up once.
  const followingAgain = new Set<string>();
  let reusedSources = 0;
  let manual: SourceDecision | null = null;
  /** The PURSS's "Saved links" source: reused when present, created once when an import needs it. */
  const manualDecision = (src?: ArchiveSource): SourceDecision => {
    if (manual) return manual;
    const shown: ArchiveSource = src ?? { id: "(manual)", kind: "manual", title: server.api.shared.keptLinks, origin: server.api.portability.keptByHand, siteUrl: null, feedUrl: null, isPrivate: false, reconnectRequired: false, curator: null, hue: 210, followed: true, paused: false, notify: "default", fullText: false, createdAt: null, lastItemAt: null };
    manual = existingManual
      ? { action: "reuse", id: existingManual, refollow: false, src: shown, feedUrl: null }
      : { action: "create", id: newId("src"), mode: "manual", src: shown, feedUrl: null };
    return manual;
  };
  for (const src of doc.sources) {
    if (src.kind === "manual") { sources.set(src.id, manualDecision(src)); continue; }
    const href = publicAddress(src);
    if (!href) {
      const existing = existingPrivate.get(src.id);
      if (existing) { sources.set(src.id, { action: "reuse", id: existing, refollow: false, src, feedUrl: null }); reusedSources++; continue; }
      sources.set(src.id, { action: "create", id: newId("src"), mode: src.followed ? "reconnect" : "unfollowed", src, feedUrl: null });
      continue;
    }
    const key = feedKey(href) ?? href;
    const dup = plannedFeeds.get(key);
    const existing = have.find(href);
    if (dup) { sources.set(src.id, { action: "reuse", id: dup, refollow: false, src, feedUrl: href }); reusedSources++; continue; }
    if (existing) {
      const refollow = src.followed && !existing.followed && !followingAgain.has(existing.id);
      if (refollow) followingAgain.add(existing.id);
      // A source taken up again is subscribed at the address it keeps, not the one the archive wrote.
      sources.set(src.id, { action: "reuse", id: existing.id, refollow, src, feedUrl: existing.feedUrl ?? href });
      reusedSources++;
      continue;
    }
    const id = newId("src");
    plannedFeeds.set(key, id);
    sources.set(src.id, { action: "create", id, mode: src.followed ? "follow" : "unfollowed", src, feedUrl: href });
  }
  let toFollow = 0;
  let toReconnect = 0;
  for (const d of sources.values()) {
    if (d.action === "create" && d.mode === "follow") toFollow++;
    if (d.action === "reuse" && d.refollow) toFollow++;
    if (d.action === "create" && d.mode === "reconnect") toReconnect++;
  }
  if (reusedSources) conflicts.push(server.api.portability.sourcesAlreadyHere(reusedSources));

  // ---- baskets
  const baskets = new Map<string, { id: string; create: Archive["baskets"][number] | null }>();
  const basketByName = new Map(app.db.all<{ id: string; name: string }>("SELECT id, name FROM baskets WHERE account_id = ?", ws).map((b) => [lower(b.name), b.id]));
  const mergedBaskets: string[] = [];
  for (const b of doc.baskets) {
    const existing = basketByName.get(lower(b.name));
    if (existing) {
      baskets.set(b.id, { id: existing, create: null });
      mergedBaskets.push(b.name);
    } else {
      const id = newId("bsk");
      baskets.set(b.id, { id, create: b });
      basketByName.set(lower(b.name), id);
    }
  }
  for (const name of mergedBaskets) conflicts.push(server.api.portability.basketExists(name));

  // ---- collections
  const collections = new Map<string, { id: string; create: ArchiveCollection | null; skip: boolean; src: ArchiveCollection }>();
  const collectionByKey = new Map(app.db.all<{ id: string; name: string; mode: string }>("SELECT id, name, mode FROM collections WHERE account_id = ?", ws).map((c) => [`${c.mode}:${lower(c.name)}`, c.id]));
  const mergedCollections: string[] = [];
  for (const c of doc.collections) {
    const key = `${c.mode}:${lower(c.name)}`;
    const existing = collectionByKey.get(key);
    if (existing) {
      collections.set(c.id, { id: existing, create: null, skip: false, src: c });
      mergedCollections.push(c.name);
    } else {
      const id = newId("col");
      collections.set(c.id, { id, create: c, skip: false, src: c });
      collectionByKey.set(key, id);
    }
  }
  for (const name of mergedCollections) conflicts.push(server.api.portability.collectionExists(name));
  const maps = { sources: new Map([...sources].map(([k, v]) => [k, v.id])), baskets: new Map([...baskets].map(([k, v]) => [k, v.id])), collections: new Map([...collections].map(([k, v]) => [k, v.id])) };
  for (const entry of collections.values()) {
    if (entry.create?.mode !== "filter") continue;
    const q = checkQuery(remapQuery(entry.create.query, maps));
    if (!q.ok) { entry.skip = true; conflicts.push(server.api.portability.filterNotRestored(entry.create.name)); }
  }

  // ---- items
  const items = new Map<string, ItemDecision>();
  const seenKeys = new Map<string, Exclude<ItemDecision, { action: "alias" }>>(); // source|guid / source|url -> first decision
  // Only none, one or several matter (one is matched, several are counted as ambiguous), so each look stops at two.
  const existingMatches = (sourceId: string, it: ArchiveItem, url: string | null): Set<string> => {
    const ids = new Set<string>();
    for (const g of it.originalGuids) {
      for (const r of app.db.all<{ item_id: string }>(
        "SELECT DISTINCT e.item_id FROM external_ids e JOIN items i ON i.id = e.item_id WHERE e.account_id = ? AND i.source_id = ? AND e.original_guid = ? LIMIT 2", ws, sourceId, g)) ids.add(r.item_id);
    }
    if (url) for (const r of app.db.all<{ id: string }>("SELECT id FROM items WHERE account_id = ? AND source_id = ? AND url = ? LIMIT 2", ws, sourceId, url)) ids.add(r.id);
    if (!url && !it.originalGuids.length) {
      for (const r of app.db.all<{ id: string }>("SELECT id FROM items WHERE account_id = ? AND source_id = ? AND url IS NULL AND title = ? AND COALESCE(published_at, '') = ? LIMIT 2", ws, sourceId, it.title, it.publishedAt ?? "")) ids.add(r.id);
    }
    return ids;
  };
  const newSourceIds = new Set([...sources.values()].filter((d) => d.action === "create").map((d) => d.id));
  let ambiguous = 0;
  let orphaned = 0;
  let createdBytes = 0;
  let newItems = 0;
  let matchedItems = 0;
  let repeated = 0;
  for (const it of doc.items) {
    const known = it.sourceId ? sources.get(it.sourceId) : undefined;
    if (!known && it.sourceId) orphaned++;
    const decisionForSource = known ?? manualDecision();
    if (!known) newSourceIds.add(decisionForSource.id);
    const sourceId = decisionForSource.id;
    const prepared = prepareItem(it, now);
    const keys = [...it.originalGuids.map((g) => `${sourceId}|g|${g}`), ...(prepared.url ? [`${sourceId}|u|${prepared.url}`] : [])];
    const first = keys.map((k) => seenKeys.get(k)).find((v) => v !== undefined);
    if (first) { items.set(it.id, { action: "alias", id: first.id, of: first }); repeated++; continue; }
    const found = newSourceIds.has(sourceId) && decisionForSource.action === "create" ? new Set<string>() : existingMatches(sourceId, it, prepared.url);
    if (found.size === 1) {
      const decision: ItemDecision = { action: "match", id: [...found][0]!, item: it, prepared };
      items.set(it.id, decision);
      for (const k of keys) seenKeys.set(k, decision);
      matchedItems++;
      continue;
    }
    if (found.size > 1) ambiguous++;
    const decision: ItemDecision = { action: "create", id: newId("itm"), sourceId, item: it, prepared };
    items.set(it.id, decision);
    for (const k of keys) seenKeys.set(k, decision);
    createdBytes += prepared.bytes;
    newItems++;
  }
  if (manual && !existingManual) sources.set("(manual)", manual); // make sure the executor creates it
  if (matchedItems) conflicts.push(server.api.portability.itemsAlreadyHere(matchedItems));
  if (repeated) conflicts.push(server.api.portability.itemsRepeat(repeated));
  if (ambiguous) conflicts.push(server.api.portability.itemsAmbiguous(ambiguous));
  if (orphaned) conflicts.push(server.api.portability.itemsOrphaned(orphaned));

  // ---- memberships (kept items)
  const memberships: MembershipPlan[] = [];
  const seenMembership = new Set<string>();
  let existingPins = 0;
  let extraVersionBytes = 0;
  let membershipBytes = 0;
  for (const m of doc.memberships) {
    const basket = baskets.get(m.basketId);
    const item = items.get(m.itemId);
    if (!basket || !item) continue;
    const key = `${basket.id}|${item.id}`; // an alias shares its target's id, so duplicates collapse here
    if (seenMembership.has(key)) continue;
    seenMembership.add(key);
    const base = item.action === "alias" ? item.of : item;
    if (base.action === "match" && app.db.get("SELECT 1 FROM basket_items WHERE basket_id = ? AND item_id = ?", basket.id, base.id)) { existingPins++; continue; }
    const keptAt = ISO_FALLBACK(m.keptAt, now);
    memberships.push({ basketId: basket.id, itemId: base.id, archiveItemId: m.itemId, archiveVersionId: m.versionId, keptAt });
    membershipBytes += measureBytes({ basketId: basket.id, itemId: base.id, keptAt });
    if (item.action === "match") {
      const v = resolveKeptVersion(app, item, m.versionId);
      if (v.insert) extraVersionBytes += v.insert.bytes;
    }
  }
  if (existingPins) conflicts.push(server.api.portability.pinsAlreadyHere(existingPins));

  // ---- workflow history: rows land on the item this import settles on; rows already there are not repeated
  const stateLog: ImportPlan["stateLog"] = [];
  const stateRecords: string[] = [];
  let stateRecordBytes = 0;
  const historyOf = new Map<string, Set<string>>(); // item id -> "from|to|at" already present or planned
  const rowKey = (from: string, to: string, at: string) => `${from}|${to}|${at}`;
  const needsRecord = new Set<string>();
  for (const l of doc.stateLog) {
    const decision = items.get(l.itemId);
    const at = Date.parse(l.at);
    if (!decision || Number.isNaN(at)) continue;
    const base = decision.action === "alias" ? decision.of : decision;
    let seen = historyOf.get(base.id);
    if (!seen) {
      seen = new Set(base.action === "match"
        ? app.db.all<{ from_state: string; to_state: string; at: string }>("SELECT from_state, to_state, at FROM state_log WHERE item_id = ?", base.id).map((r) => rowKey(r.from_state, r.to_state, r.at))
        : []);
      historyOf.set(base.id, seen);
    }
    const iso = new Date(at).toISOString();
    if (seen.has(rowKey(l.from, l.to, iso))) continue;
    seen.add(rowKey(l.from, l.to, iso));
    stateLog.push({ itemId: base.id, from: l.from, to: l.to, at: iso });
    needsRecord.add(base.id);
  }
  // The ledger counts one small record per item that has state data; give new history one too.
  const createdItems = new Map<string, Extract<ItemDecision, { action: "create" }>>();
  for (const d of items.values()) if (d.action === "create") createdItems.set(d.id, d);
  for (const id of needsRecord) {
    const created = createdItems.get(id);
    if (created) {
      if (!created.prepared.stateBytes) { created.prepared.stateBytes = STATE_RECORD_BYTES; stateRecordBytes += STATE_RECORD_BYTES; }
    } else if (!app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'record' AND ref_id = ? AND released_at IS NULL", `state:${id}`)) {
      stateRecords.push(id);
      stateRecordBytes += STATE_RECORD_BYTES;
    }
  }

  // ---- highlights and notes: they land on the item this import settles on, and one already there
  // (same kind, passage, words and creation time) is not repeated. Text references are mapped for
  // items this import creates; on an item already here they are dropped and the quote finds the passage.
  const annotations: ImportPlan["annotations"] = [];
  const annotationsOf = new Map<string, { keys: Set<string>; live: number }>();
  const annotationKey = (kind: string, exact: string | null, body: string | null, createdAt: string) => JSON.stringify([kind, exact, body, createdAt]);
  let annotationBytesTotal = 0;
  let overLimit = 0;
  for (const a of doc.annotations) {
    const decision = items.get(a.itemId);
    if (!decision) continue;
    const base = decision.action === "alias" ? decision.of : decision;
    let seen = annotationsOf.get(base.id);
    if (!seen) {
      const rows = base.action === "match"
        ? app.db.all<{ kind: string; quote_exact: string | null; body: string | null; created_at: string }>("SELECT kind, quote_exact, body, created_at FROM annotations WHERE item_id = ? AND deleted_at IS NULL", base.id)
        : [];
      seen = { keys: new Set(rows.map((r) => annotationKey(r.kind, r.quote_exact, r.body, r.created_at))), live: rows.length };
      annotationsOf.set(base.id, seen);
    }
    // Times from the file, never later than the import: a future time would win every later edit.
    const updatedAt = [ISO_FALLBACK(a.updatedAt, now), now].sort()[0]!;
    const createdAt = [ISO_FALLBACK(a.createdAt, updatedAt), updatedAt].sort()[0]!;
    const body = a.body?.trim() ? a.body : null;
    const quote = a.kind === "highlight" ? a.quote : null;
    const key = annotationKey(a.kind, quote?.exact ?? null, body, createdAt);
    if (seen.keys.has(key)) continue;
    if (seen.live >= ANNOTATIONS_PER_ITEM) { overLimit++; continue; }
    seen.keys.add(key);
    seen.live++;
    let target: AnnotationDTO["target"] = null;
    if (a.kind === "highlight" && a.target && base.action === "create") {
      const mapped = a.target.kind === "version"
        ? base.prepared.versions.find((v) => v.archiveId === a.target!.id)?.id
        : base.prepared.captures.find((c) => c.archiveId === a.target!.id && c.status === "done")?.id;
      target = mapped ? { kind: a.target.kind, id: mapped } : null;
    }
    const fields = { kind: a.kind, quote, position: a.kind === "highlight" ? a.position : null, target, body, createdAt, updatedAt };
    const bytes = annotationBytes(fields);
    annotations.push({ id: newId("ann"), itemId: base.id, ...fields, bytes });
    annotationBytesTotal += bytes;
  }
  if (overLimit) conflicts.push(server.api.portability.annotationsOverLimit(overLimit, ANNOTATIONS_PER_ITEM));

  // ---- pictures kept with items: they land on the item this import settles on; one already there (same address) is not
  // repeated, an item keeps no more than it may, and each must really be the picture the file says it is.
  const pictures: ImportPlan["pictures"] = [];
  const picturesOf = new Map<string, { urls: Set<string>; n: number; bytes: number }>();
  let pictureBytesTotal = 0;
  for (const im of doc.images) {
    const decision = items.get(im.itemId);
    if (!decision) continue;
    const base = decision.action === "alias" ? decision.of : decision;
    let held = picturesOf.get(base.id);
    if (!held) {
      const rows = base.action === "match" ? app.db.all<{ url: string; bytes: number }>("SELECT url, bytes FROM item_images WHERE item_id = ?", base.id) : [];
      held = { urls: new Set(rows.map((r) => r.url)), n: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
      picturesOf.set(base.id, held);
    }
    const data = Buffer.from(im.data, "base64");
    if (held.urls.has(im.url) || held.n >= IMAGES_PER_ITEM || held.bytes + data.length > IMAGE_BYTES_PER_ITEM) continue;
    if (pictureType(data) !== im.contentType || createHash("sha256").update(data).digest("hex") !== im.sha256) continue;
    held.urls.add(im.url); held.n++; held.bytes += data.length;
    pictures.push({ id: newId("img"), itemId: base.id, url: im.url, role: im.role, contentType: im.contentType, sha256: im.sha256, data, bytes: data.length });
    pictureBytesTotal += data.length;
  }

  // ---- "Remind me" days: they land on the item this import settles on when it is kept; an item that already has a day
  // keeps it, and days that have gone by are left out.
  const reminders: ImportPlan["reminders"] = [];
  const today = todayFor(app, ws, new Date());
  const keptInFile = new Set(doc.memberships.map((m) => m.itemId));
  const reminded = new Set(app.db.all<{ item_id: string }>("SELECT item_id FROM item_reminders WHERE account_id = ?", ws).map((r) => r.item_id));
  for (const r of doc.itemReminders) {
    const decision = items.get(r.itemId);
    if (!decision) continue;
    const base = decision.action === "alias" ? decision.of : decision;
    if (r.remindOn < today || reminded.has(base.id)) continue;
    if (!keptInFile.has(r.itemId) && !(base.action === "match" && app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", base.id))) continue;
    reminded.add(base.id);
    reminders.push({ itemId: base.id, remindOn: r.remindOn, note: r.note?.trim() ? r.note.trim() : null });
  }

  // ---- sharing, preferences
  if (doc.shares.length) conflicts.push(server.api.portability.sharingSwitchedOff);
  const hasPrefs = !!app.db.get("SELECT 1 FROM preferences WHERE account_id = ?", ws);
  if (hasPrefs) conflicts.push(server.api.portability.settingsKept);

  bump("sources", doc.sources.length); bump("collections", doc.collections.length); bump("baskets", doc.baskets.length);
  bump("items", doc.items.length); bump("keptItems", doc.memberships.length); bump("shares", doc.shares.length);
  bump("captures", doc.items.reduce((n, i) => n + i.captures.filter((c) => c.status === "done").length, 0));
  bump("annotations", doc.annotations.length); bump("itemReminders", doc.itemReminders.length);
  bump("newItems", newItems); bump("existingItems", matchedItems); bump("sourcesToFollow", toFollow); bump("sourcesToReconnect", toReconnect); bump("existingSources", reusedSources);

  return {
    sources, baskets, collections, items, memberships, stateLog, stateRecords, annotations, pictures, reminders,
    conflicts, counts, needsEngine: toFollow > 0,
    requiredBytes: createdBytes + membershipBytes + extraVersionBytes + stateRecordBytes + annotationBytesTotal + pictureBytesTotal,
  };
}

type Maps = { sources: Map<string, string>; baskets: Map<string, string>; collections: Map<string, string> };

/** Re-point the ids inside a saved filter at the ids allocated by this import. */
function remapQuery(node: unknown, maps: Maps): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.all)) return { all: n.all.map((x) => remapQuery(x, maps)) };
  if (Array.isArray(n.any)) return { any: n.any.map((x) => remapQuery(x, maps)) };
  if ("not" in n) return { not: remapQuery(n.not, maps) };
  const table = n.field === "source" ? maps.sources : n.field === "basket" ? maps.baskets : n.field === "collection" ? maps.collections : null;
  if (table && Array.isArray(n.value)) return { ...n, value: n.value.map((v) => table.get(String(v)) ?? v) };
  return n;
}

/** For an item that already exists: the version a kept pin should point at, and a new version row when none matches. */
function resolveKeptVersion(app: App, item: Extract<ItemDecision, { action: "match" }>, archiveVersionId: string | null): { versionId: string | null; insert: PreparedVersion | null } {
  const wanted = item.prepared.versions.find((v) => v.archiveId === archiveVersionId) ?? item.prepared.versions.find((v) => v.id === item.prepared.currentId)!;
  const existing = app.db.get<{ id: string }>("SELECT id FROM item_versions WHERE item_id = ? AND content_hash = ?", item.id, wanted.hash);
  if (existing) return { versionId: existing.id, insert: null };
  return { versionId: null, insert: wanted };
}

export type ImportOutcome = { counts: Record<string, number>; conflicts: string[]; requiredBytes: number };

/** How many followed sources and collections an import adds, for the plan's limits. */
function planGrowth(plan: ImportPlan): { sources: number; collections: number } {
  // Several archive records can land on one source (addresses that normalise alike): count each source once.
  const following = new Set<string>();
  for (const d of plan.sources.values()) {
    if (d.action === "reuse" ? d.refollow && d.feedUrl : d.mode === "follow" || d.mode === "reconnect") following.add(d.id);
  }
  const sources = following.size;
  let collections = 0;
  for (const c of plan.collections.values()) if (c.create && !c.skip) collections++;
  return { sources, collections };
}

/** Refuse an import that would take the account over its plan, before anything is written. */
function assertPlanRoom(app: App, p: Principal, plan: ImportPlan): void {
  const growth = planGrowth(plan);
  assertRoom(app, p.accountId, "sources", growth.sources);
  assertRoom(app, p.accountId, "collections", growth.collections);
}

/** What would an import do right now? Reads only; nothing is written. */
export function previewImportPlan(app: App, p: Principal, doc: Archive): ImportOutcome & { omitted: string[]; overPlan: string | null } {
  const plan = planImport(app, p, doc);
  return { counts: plan.counts, conflicts: plan.conflicts, requiredBytes: plan.requiredBytes, omitted: doc.omitted.length ? doc.omitted : [...ARCHIVE_OMITTED], overPlan: overPlan(app, p, plan) };
}

/** Why the account's plan has no room for an import, or null when it has. */
function overPlan(app: App, p: Principal, plan: ImportPlan): string | null {
  try {
    assertPlanRoom(app, p, plan);
    return null;
  } catch (err) {
    if (err instanceof PlanLimit) return err.message;
    throw err;
  }
}

/** Would `bytes` of new content be admitted? Same rules as the ledger, without pausing the account as a side effect. */
export function wouldFit(app: App, accountId: string, bytes: number): boolean {
  if (bytes <= 0) return true;
  const free = diskOverride.freeBytes ?? diskInfo(app).freeBytes;
  if (free !== null && free - bytes < app.config.diskReserveBytes) return false;
  const alloc = allowance(app, accountId);
  return alloc === null || usedBytes(app, accountId) + reservedBytes(app, accountId) + bytes <= alloc;
}

// ---- staging

const STAGE_TTL_SECONDS = 24 * 3600;

export const stageFile = (app: App, token: string) => path.join(app.config.dataDir, "staging", `import-${token}.json`);
/** Where an upload is written while it arrives (routes/portability.ts); removed when it's done, or by purgeStages after a crash. */
export function uploadFile(app: App): string {
  const dir = path.join(app.config.dataDir, "staging");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `upload-${randomToken(18)}.part`);
}

/** Removes uploads still arriving `olderThanMs` ago: all of them at start-up (none can be arriving), and abandoned ones after that. */
export function purgeUploads(app: App, olderThanMs: number): void {
  const dir = path.join(app.config.dataDir, "staging");
  const before = Date.now() - olderThanMs;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (/^upload-[A-Za-z0-9_-]+\.part$/.test(f) && (olderThanMs === 0 || statSync(path.join(dir, f)).mtimeMs < before)) rmSync(path.join(dir, f), { force: true });
  }
}

export function purgeStages(app: App, accountId?: string): number {
  // Uploads still arriving are written to at least every 20 s (UPLOAD_PACE); one untouched for an hour was abandoned.
  if (!accountId) purgeUploads(app, 3600_000);
  const rows = accountId
    ? app.db.all<{ token: string }>("SELECT token FROM import_stages WHERE account_id = ?", accountId)
    : app.db.all<{ token: string }>("SELECT token FROM import_stages WHERE expires_at < ?", nowIso());
  for (const r of rows) {
    rmSync(stageFile(app, r.token), { force: true });
    app.db.run("DELETE FROM import_stages WHERE token = ?", r.token);
  }
  return rows.length;
}

function fail(err: unknown): never {
  if (err instanceof ArchiveError) throw badRequest(err.message, err.code);
  throw err;
}

export type UploadCheck = ReturnType<typeof previewImportPlan>;

/**
 * Values one export may hold to be imported here (countJsonValues). Parsing takes memory per value, and an export is
 * parsed whole, when it's checked and again when it's applied, so this is what bounds an import's memory.
 */
export const MAX_IMPORT_VALUES = 6_000_000;
/** Deeper than any export goes (preferences and filters nest a few levels): a file nested past this is refused unparsed. */
export const MAX_IMPORT_DEPTH = 64;

function parseExport(text: string): unknown {
  if (countJsonValues(text, MAX_IMPORT_VALUES + 1, MAX_IMPORT_DEPTH) > MAX_IMPORT_VALUES) {
    throw new HttpError(413, "import_too_large", server.api.portability.importTooLarge);
  }
  try { return JSON.parse(text); } catch { throw badRequest(server.api.portability.notJsonExport, "not_archive"); }
}

/** Parse and verify an export (its text, or the parsed document) and work out what importing it would do. Reads only. */
export function checkUpload(app: App, p: Principal, upload: unknown): UploadCheck {
  if (upload === undefined || upload === null) throw badRequest(server.api.shared.chooseExportFile);
  const raw = typeof upload === "string" ? parseExport(upload) : upload;
  let doc: Archive;
  try { doc = parseArchive(raw); } catch (err) { fail(err); }
  return previewImportPlan(app, p, doc);
}

/** Records a checked upload as this PURSS's one staged import; `place` puts the file's text at the path it's given. */
export function stageChecked(app: App, p: Principal, check: UploadCheck, file: { bytes: number; sha256: string; place: (dest: string) => void }): ImportPreview {
  purgeStages(app);
  purgeStages(app, p.accountId); // one staged import per PURSS
  const token = randomToken(18);
  mkdirSync(path.join(app.config.dataDir, "staging"), { recursive: true, mode: 0o700 });
  const dest = stageFile(app, token);
  file.place(dest);
  chmodSync(dest, 0o600);
  const preview: ImportPreview = {
    token, counts: check.counts, conflicts: check.conflicts, omitted: check.omitted, requiredBytes: check.requiredBytes,
    fits: wouldFit(app, p.accountId, check.requiredBytes),
    overPlan: check.overPlan,
  };
  app.db.run("INSERT INTO import_stages (token, account_id, bytes, sha256, summary, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    token, p.accountId, file.bytes, file.sha256, JSON.stringify(preview), nowIso(), addSeconds(STAGE_TTL_SECONDS));
  return preview;
}

/** Verify an export, stage it, and describe what importing it would do, all here (uploads use checkUploadApart instead). */
export function stageImport(app: App, p: Principal, upload: unknown): ImportPreview {
  const check = checkUpload(app, p, upload);
  const json = typeof upload === "string" ? upload : JSON.stringify(upload);
  return stageChecked(app, p, check, { bytes: Buffer.byteLength(json), sha256: sha256Hex(json), place: (dest) => writeFileSync(dest, json, { mode: 0o600 }) });
}

/** A check that takes longer than this is stopped: with the lookups indexed, a real one takes seconds. */
export const IMPORT_CHECK_SECONDS = 120;

/**
 * Checks an uploaded file in a child process (import-check-worker.ts), so neither its memory nor its time holds up the
 * API. Memory goes with how much a file holds, not its size (a file of a million tiny entries is small), so the child
 * runs with a heap of `heapMb` (config importCheckHeapMb) and a file that needs more is refused as too large to import
 * here. A process, not a worker thread: a worker's own heap limit is overruled by the API's --max-old-space-size. The
 * answer comes once the child has exited, so the import turn (oneImportAtATime) is never held by two at once.
 */
export function checkUploadApart(app: App, p: Principal, file: string, heapMb = app.config.importCheckHeapMb, signal?: AbortSignal): Promise<{ check: UploadCheck; sha256: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HttpError(400, "upload_aborted", server.api.shared.uploadCutOff)); return; }
    const child = fork(fileURLToPath(new URL("./import-check-worker.ts", import.meta.url)), [], {
      execArgv: [`--max-old-space-size=${heapMb}`, "--no-warnings"],
      env: { ...process.env, NODE_OPTIONS: "" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    // Its stderr is kept: the child's own notes go to the log, and a crash that isn't running out of memory is logged as is.
    let errText = "";
    child.stderr?.on("data", (d: Buffer) => { errText = (errText + d.toString()).slice(-8000); });
    type Answer = { ok: true; check: UploadCheck; sha256: string } | { ok: false; status: number; code: string; message: string };
    let answer: Answer | null = null;
    let stopped: HttpError | null = null;
    const stop = (err: HttpError) => { if (!answer) { stopped ??= err; if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } };
    child.once("message", (m: Answer) => { answer = m; });
    // Couldn't start (or the pipe broke): no "exit" may follow, but "close" always does.
    child.on("error", (err) => { stopped ??= new HttpError(500, "internal", server.api.shared.wentWrongChecking); console.error("[api] import check could not run:", err.message); });
    const timer = setTimeout(() => stop(new HttpError(413, "import_too_large", server.api.portability.tookTooLong)), IMPORT_CHECK_SECONDS * 1000);
    timer.unref();
    // The person went away: stop checking, so their next upload and everyone else's turn needn't wait for it.
    const onAbort = () => stop(new HttpError(400, "upload_aborted", server.api.shared.uploadCutOff));
    signal?.addEventListener("abort", onAbort, { once: true });
    // "close" comes once the process has ended and its pipes are shut, also when it never started: only then is the turn free.
    child.once("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const line of errText.split("\n")) if (line.startsWith("[api]")) console.error(line);
      const a = answer as Answer | null;
      if (a?.ok) return resolve({ check: a.check, sha256: a.sha256 });
      if (a) return reject(new HttpError(a.status, a.code, a.message));
      if (stopped) return reject(stopped);
      if (/heap out of memory|Reached heap limit/i.test(errText)) {
        console.error(`[api] an import check ran out of its ${heapMb} MB; the file was refused as too large`);
        return reject(new HttpError(413, "import_too_large", server.api.portability.tooLargeToCheck));
      }
      console.error(`[api] an import check ended without an answer (${sig ?? code}):`, errText.trim().split("\n").slice(-12).join("\n") || "no output");
      reject(new HttpError(500, "internal", server.api.shared.wentWrongChecking));
    });
    if (child.connected) child.send({ config: app.config, principal: p, file }, (err) => { if (err) stop(new HttpError(500, "internal", server.api.shared.wentWrongChecking)); });
  });
}

let importTurn: Promise<unknown> = Promise.resolve();
/** Checking an upload and applying one each hold a whole file's worth of memory: they take turns, across all accounts. */
export function oneImportAtATime<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = importTurn.then(fn);
  importTurn = run.catch(() => undefined);
  return run;
}

/** Apply a staged import in one transaction. Over the limit: nothing is written and the staged file stays for a retry. */
export function applyImport(app: App, p: Principal, token: string): ImportResult {
  const stage = app.db.get<{ token: string; sha256: string }>("SELECT token, sha256 FROM import_stages WHERE token = ? AND account_id = ? AND expires_at > ?", token, p.accountId, nowIso());
  const file = stage ? stageFile(app, stage.token) : null;
  if (!stage || !file || !existsSync(file)) throw badRequest(server.api.portability.previewExpired, "expired");
  const json = readFileSync(file, "utf8");
  if (sha256Hex(json) !== stage.sha256) throw badRequest(server.api.portability.fileChanged, "expired");
  let doc: Archive;
  try { doc = parseArchive(parseExport(json)); } catch (err) { fail(err); }

  let result: ImportResult;
  try {
    result = app.db.tx(() => runImport(app, p, doc, token));
  } catch (err) {
    audit(app, p.accountId, "import", null, "failure", err instanceof HttpError ? err.code : "error");
    throw err;
  }
  purgeStages(app, p.accountId);
  audit(app, p.accountId, "import", null, "success", `${result.created.items} items, ${result.created.keptPins} kept`);
  emit(app, p.accountId, { type: "items", sourceIds: [], count: result.created.items });
  emit(app, p.accountId, { type: "storage" });
  emit(app, p.accountId, { type: "source", sourceId: "" });
  emit(app, p.accountId, { type: "jobs" });
  emit(app, p.accountId, { type: "notification" });
  return result;
}

function ledgerInsert(app: App, p: Principal, spec: { kind: "item_version" | "capture" | "record" | "image"; refId: string; itemId: string | null; sourceId: string | null; bytes: number }): void {
  // The whole import was admitted once up front (checkGrowth for the total, inside the same
  // transaction), so each object is recorded without repeating the usage check.
  recordObject(app, { accountId: p.accountId, reason: "import", ...spec });
}

function runImport(app: App, p: Principal, doc: Archive, token: string): ImportResult {
  const plan = planImport(app, p, doc);
  const ws = p.accountId;
  const now = nowIso();
  checkGrowth(app, p.accountId, plan.requiredBytes); // throws a 507 "storage full" before anything is written
  assertPlanRoom(app, p, plan); // and a 403 when it would follow more sources or add more collections than the plan allows

  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (plan.needsEngine && !engineUser) throw badRequest(server.api.shared.notConnectedYet, "engine_pending");

  const result: ImportResult = {
    created: { sources: 0, collections: 0, baskets: 0, items: 0, keptPins: 0, captures: 0, shares: 0, annotations: 0, reminders: 0 },
    alreadyPresent: { items: plan.counts.existingItems ?? 0, sources: plan.counts.existingSources ?? 0 }, following: 0, reconnectRequired: 0,
  };

  // ---- sources
  const subscribe = (sourceId: string, feedUrl: string, title: string) => {
    enqueue(app, "engine.subscribe", { engineUserId: engineUser!.id, sourceId, feedUrl, title }, { accountId: p.accountId, idempotencyKey: `subscribe:${sourceId}` });
    result.following++;
  };
  const created = new Set<string>();
  for (const d of plan.sources.values()) {
    if (d.action === "reuse") {
      // An unfollowed source the archive follows is taken up again, as following its feed again would; this installation's own news has no engine subscription.
      if (d.refollow && d.feedUrl && !reviveSource(app, d.id).news) subscribe(d.id, d.feedUrl, d.src.title);
      continue;
    }
    if (created.has(d.id)) continue;
    created.add(d.id);
    const s = d.src;
    const createdAt = ISO_FALLBACK(s.createdAt, now);
    const lastItemAt = s.lastItemAt ? ISO_FALLBACK(s.lastItemAt, "") || null : null;
    const kept = { id: d.id, accountId: p.accountId, origin: s.origin, hue: s.hue, createdAt };
    if (d.mode === "manual") {
      insertSource(app, { ...kept, kind: "manual", title: server.api.shared.keptLinks, origin: server.api.portability.keptByHand, health: "ok" });
    } else if (d.mode === "reconnect" || (d.mode === "unfollowed" && d.feedUrl === null)) {
      const reconnect = d.mode === "reconnect";
      insertSource(app, {
        ...kept, kind: "private", title: s.title, privateLink: null, curator: s.curator, followed: reconnect, paused: reconnect || s.paused, notify: s.notify,
        health: reconnect ? "reconnect" : "ok", healthText: reconnect ? PRIVATE_NOTE : null, lastItemAt,
      });
      if (reconnect) result.reconnectRequired++;
    } else {
      const follow = d.mode === "follow";
      const { news } = insertSource(app, {
        ...kept, kind: s.kind, title: s.title, siteUrl: safeAddress(s.siteUrl), feedUrl: d.feedUrl, curator: s.curator, followed: follow, paused: follow && s.paused, notify: s.notify,
        fullText: s.fullText && fullTextAvailable({ kind: s.kind, is_private: 0 }), health: follow ? "pending" : "ok", lastItemAt,
      });
      if (follow && !news) subscribe(d.id, d.feedUrl!, s.title);
    }
    result.created.sources++;
  }

  // ---- baskets and collections
  let basketPos = app.db.get<{ n: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM baskets WHERE account_id = ?", ws)!.n;
  for (const b of plan.baskets.values()) {
    if (!b.create) continue;
    app.db.run("INSERT INTO baskets (id, account_id, name, capture_mode, view, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", b.id, ws, b.create.name, b.create.captureMode, b.create.view, basketPos++, ISO_FALLBACK(b.create.createdAt, now));
    result.created.baskets++;
  }
  const maps: Maps = { sources: new Map([...plan.sources].map(([k, v]) => [k, v.id])), baskets: new Map([...plan.baskets].map(([k, v]) => [k, v.id])), collections: new Map([...plan.collections].map(([k, v]) => [k, v.id])) };
  let collectionPos = app.db.get<{ n: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM collections WHERE account_id = ?", ws)!.n;
  for (const c of plan.collections.values()) {
    if (!c.create || c.skip) continue;
    const q = c.create.mode === "filter" ? checkQuery(remapQuery(c.create.query, maps)) : null;
    app.db.run("INSERT INTO collections (id, account_id, name, emoji, mode, view, query, show_on_home, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.id, ws, c.create.name, c.create.emoji, c.create.mode, c.create.view, q?.ok ? JSON.stringify(q.query) : null, c.create.showOnHome ? 1 : 0, collectionPos++, ISO_FALLBACK(c.create.createdAt, now));
    result.created.collections++;
  }
  for (const c of plan.collections.values()) {
    if (c.skip || c.src.mode !== "sources") continue;
    for (const sid of c.src.sourceIds) {
      const target = maps.sources.get(sid);
      if (target) app.db.run("INSERT OR IGNORE INTO collection_sources (collection_id, source_id) VALUES (?, ?)", c.id, target);
    }
  }

  // ---- items
  // An item keeps its number from the file when this account never gave that number (restoring into a new account keeps
  // every short link); otherwise it gets the next one. The counter moves past the kept numbers first, so none is given twice.
  const nextNumber = app.db.get<{ n: number }>("SELECT next_item_number AS n FROM accounts WHERE id = ?", ws)!.n;
  const keptNumbers = new Map<string, number>();
  const taken = new Set<number>();
  let highest = 0;
  for (const d of plan.items.values()) {
    const n = d.action === "create" ? d.item.number : undefined;
    if (n !== undefined && n >= nextNumber && !taken.has(n)) { keptNumbers.set(d.id, n); taken.add(n); highest = Math.max(highest, n); }
  }
  if (highest) app.db.run("UPDATE accounts SET next_item_number = MAX(next_item_number, ?) WHERE id = ?", highest + 1, ws);
  for (const d of plan.items.values()) {
    if (d.action !== "create") continue;
    const { item: it, prepared: pr } = d;
    result.created.captures += restoreItem(app, {
      id: d.id, number: keptNumbers.get(d.id) ?? null, accountId: ws, sourceId: d.sourceId, kind: pr.kind, title: it.title.trim() || NO_TITLE, url: pr.url, author: it.author,
      imageUrl: pr.imageUrl, durationSeconds: it.durationSeconds, doi: it.doi, curatorNote: it.curatorNote, publishedAt: pr.publishedAt, discoveredAt: pr.discoveredAt,
      listedAt: pr.listedAt, createdAt: pr.createdAt, enclosures: pr.enclosures, versions: pr.versions, currentVersionId: pr.currentId,
      state: { workflow: it.state.workflow, isNew: it.state.isNew, progress: it.state.progress, openedAt: it.state.openedAt ? ISO_FALLBACK(it.state.openedAt, "") || null : null },
      stateBytes: pr.stateBytes, captures: pr.captures,
    });
    result.created.items++;
  }
  // ---- workflow history (after the items it refers to exist)
  for (const l of plan.stateLog) {
    app.db.run("INSERT INTO state_log (account_id, item_id, from_state, to_state, at) VALUES (?, ?, ?, ?, ?)", p.accountId, l.itemId, l.from, l.to, l.at);
  }
  for (const id of plan.stateRecords) ledgerInsert(app, p, { kind: "record", refId: `state:${id}`, itemId: null, sourceId: null, bytes: STATE_RECORD_BYTES });
  // ---- highlights and notes
  for (const a of plan.annotations) {
    const seq = app.db.run(`INSERT INTO annotations (id, account_id, item_id, kind, quote_exact, quote_prefix, quote_suffix, pos_start, pos_end,
      target_kind, target_id, body, created_at, updated_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id, p.accountId, a.itemId, a.kind, a.quote?.exact ?? null, a.quote?.prefix ?? null, a.quote?.suffix ?? null, a.position?.start ?? null, a.position?.end ?? null,
      a.target?.kind ?? null, a.target?.id ?? null, a.body, a.createdAt, a.updatedAt, nowIso()).lastInsertRowid;
    indexAnnotation(app, seq, a.quote?.exact ?? null, a.body);
    ledgerInsert(app, p, { kind: "record", refId: `annotation:${a.id}`, itemId: a.itemId, sourceId: null, bytes: a.bytes });
    result.created.annotations++;
  }

  // ---- "Remind me" days
  for (const r of plan.reminders) {
    result.created.reminders += app.db.run("INSERT OR IGNORE INTO item_reminders (id, account_id, item_id, remind_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId("irm"), p.accountId, r.itemId, r.remindOn, r.note, now).changes;
  }

  // ---- pictures kept with items
  for (const g of plan.pictures) {
    app.db.run("INSERT INTO item_images (id, item_id, account_id, url, role, content_type, bytes, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      g.id, g.itemId, ws, g.url, g.role, g.contentType, g.bytes, g.sha256, g.data, now);
    ledgerInsert(app, p, { kind: "image", refId: g.id, itemId: g.itemId, sourceId: null, bytes: g.bytes });
  }

  // Sources that received imported items: refresh their "last item" time.
  for (const sid of new Set([...plan.items.values()].flatMap((d) => (d.action === "create" ? [d.sourceId] : [])))) {
    app.db.run("UPDATE sources SET last_item_at = COALESCE((SELECT MAX(listed_at) FROM items WHERE source_id = ?), last_item_at) WHERE id = ?", sid, sid);
  }

  // ---- kept pins
  for (const m of plan.memberships) {
    const decision = plan.items.get(m.archiveItemId)!;
    const base = decision.action === "alias" ? decision.of : decision;
    let versionId: string | null = null;
    if (base.action === "create") {
      versionId = (decision.action === "create" ? base.prepared.versions.find((v) => v.archiveId === m.archiveVersionId)?.id : null) ?? base.prepared.currentId;
    } else {
      const v = decision.action === "match" ? resolveKeptVersion(app, base, m.archiveVersionId) : { versionId: null, insert: null };
      versionId = v.versionId;
      if (!versionId && v.insert) {
        versionId = newId("ver");
        const owner = app.db.get<{ source_id: string | null }>("SELECT source_id FROM items WHERE id = ?", base.id);
        restoreVersion(app, ws, base.id, owner?.source_id ?? null, { ...v.insert, id: versionId });
      }
      versionId ??= app.db.get<{ current_version_id: string }>("SELECT current_version_id FROM items WHERE id = ?", base.id)?.current_version_id ?? null;
    }
    if (!versionId) continue;
    const r = app.db.run("INSERT OR IGNORE INTO basket_items (basket_id, item_id, account_id, version_id, kept_at) VALUES (?, ?, ?, ?, ?)", m.basketId, m.itemId, ws, versionId, m.keptAt);
    if (r.changes) {
      markMembershipChanged(app, ws, m.itemId);
      ledgerInsert(app, p, { kind: "record", refId: `basket:${m.basketId}:${m.itemId}`, itemId: m.itemId, sourceId: null, bytes: measureBytes({ basketId: m.basketId, itemId: m.itemId, keptAt: m.keptAt }) });
      result.created.keptPins++;
    }
  }

  // ---- preferences (only when the PURSS has none of its own)
  if (!app.db.get("SELECT 1 FROM preferences WHERE account_id = ?", ws)) {
    const prefs = { ...doc.preferences } as Record<string, unknown>;
    if (Array.isArray(prefs.homeCollectionIds)) prefs.homeCollectionIds = prefs.homeCollectionIds.flatMap((id) => { const t = maps.collections.get(String(id)); return t ? [t] : []; });
    const parsed = preferencesPatchSchema.safeParse(prefs);
    if (parsed.success) setPreferences(app, ws, parsed.data);
  }

  // ---- sharing: settings and public notes, never shared on import
  for (const sh of doc.shares) {
    const targetId = (sh.targetKind === "basket" ? maps.baskets : maps.collections).get(sh.targetId);
    if (!targetId || app.db.get("SELECT 1 FROM shares WHERE target_kind = ? AND target_id = ?", sh.targetKind, targetId)) continue;
    const name = app.db.get<{ name: string }>(`SELECT name FROM ${sh.targetKind === "basket" ? "baskets" : "collections"} WHERE id = ?`, targetId)?.name ?? "shared";
    const sid = newId("shr");
    app.db.run("INSERT INTO shares (id, account_id, target_kind, target_id, slug, curator_name, description, listed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sid, ws, sh.targetKind, targetId, makeSlug(name), sh.curatorName, sh.description, sh.listed ? 1 : 0, now, now);
    for (const n of sh.notes) {
      const item = plan.items.get(n.itemId);
      const text = plainText(n.note, 500);
      if (item && text) app.db.run("INSERT OR IGNORE INTO share_notes (share_id, item_id, note, updated_at) VALUES (?, ?, ?, ?)", sid, item.id, text, now);
    }
    result.created.shares++;
  }

  const summaryLine = server.api.portability.importSummary(result.created.items, result.created.keptPins) + (result.reconnectRequired ? server.api.portability.reconnectSuffix(result.reconnectRequired) : "");
  app.db.run("INSERT OR IGNORE INTO notifications (id, account_id, kind, title, body, dedup_key, created_at) VALUES (?, ?, 'system', ?, ?, ?, ?)",
    newId("ntf"), ws, server.api.portability.importFinished, summaryLine, `import:${token}`, now);
  return result;
}

// ====================================================================== reconnect

/** Restore a private source that came back from an export with "Reconnect required": the owner supplies the link again. */
export function reconnectSource(app: App, p: Principal, sourceId: string, discoveryToken: string): { ok: true; sourceId: string } {
  const s = app.db.get<{ id: string; title: string; is_private: number; health: string; followed: number }>("SELECT id, title, is_private, health, followed FROM sources WHERE id = ? AND account_id = ?", sourceId, p.accountId);
  if (!s) throw notFound(server.api.shared.thatSource);
  if (!s.is_private || s.health !== "reconnect" || !s.followed) throw conflict(server.api.portability.noReconnectNeeded);
  const candidate = peekCandidate(discoveryToken, p.accountId);
  if (!candidate) throw badRequest(server.api.shared.lookupExpired, "expired");
  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (!engineUser) throw badRequest(server.api.shared.notConnectedYet, "engine_pending");
  writeSecret(app.config.secretsDir, `source-urls/${s.id}`, candidate.feedUrl);
  try {
    app.db.tx(() => {
      app.db.run("UPDATE sources SET paused = 0, health = 'pending', health_text = NULL, site_url = COALESCE(site_url, ?), feed_key = ? WHERE id = ?", candidate.siteUrl, privateFeedKey(app, p.accountId, candidate.feedUrl), s.id);
      enqueue(app, "engine.subscribe", { engineUserId: engineUser.id, sourceId: s.id, feedUrl: `secret:source-urls/${s.id}`, title: s.title }, { accountId: p.accountId, idempotencyKey: `subscribe:${s.id}` });
    });
    dropCandidate(discoveryToken);
  } catch (err) {
    removeSecret(app.config.secretsDir, `source-urls/${s.id}`);
    throw err;
  }
  audit(app, p.accountId, "source_reconnect", s.id, "success");
  emit(app, p.accountId, { type: "source", sourceId: s.id });
  return { ok: true, sourceId: s.id };
}
