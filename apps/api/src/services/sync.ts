import { newId } from "@purss/domain";
import type { SyncBatch, SyncEntry } from "@purss/domain";
import type { App } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, nowIso } from "../http.ts";
import { markPaused, StorageFull } from "./storage.ts";
import { detectKind, findDoi, toText } from "./content.ts";
import { insertItem, updateItem } from "./item-store.ts";
import { linkKey } from "./url-key.ts";
import { notifyArrivals } from "./notifications.ts";
import { fullTextAvailable, queueAutoCapture } from "./captures.ts";
import { queueNewPosts } from "./ai-filters.ts";

type EngineUser = { id: string; account_id: string; engine_identity: string | null };

export type BatchResult = { accepted: number; updated: number; duplicates: number; unknownStreams: number; queuedForReview: number; skippedPaused: number };

/**
 * Apply one engine sync batch atomically with its checkpoint. Replays of
 * the same idempotency key return the original result. Absence of an entry never
 * deletes anything. A changed engine identity routes entries to reconciliation.
 */
export function applySyncBatch(app: App, engineUserId: string, batch: SyncBatch): BatchResult {
  const eu = app.db.get<EngineUser>("SELECT id, account_id, engine_identity FROM engine_users WHERE id = ?", engineUserId);
  if (!eu) throw new HttpError(404, "not_found", "Unknown engine user.");
  const prior = app.db.get<{ result: string }>("SELECT result FROM applied_batches WHERE idempotency_key = ?", batch.idempotencyKey);
  if (prior) return { ...(JSON.parse(prior.result) as BatchResult), duplicates: batch.entries.length };

  const result: BatchResult = { accepted: 0, updated: 0, duplicates: 0, unknownStreams: 0, queuedForReview: 0, skippedPaused: 0 };
  const touchedSources = new Map<string, number>();
  // New items per source, for notifications: a source's backlog is Ignored, not New, and tells no one.
  const newArrivals = new Map<string, number>();
  // New posts, for Smart filters.
  const freshPosts: { itemId: string; sourceId: string }[] = [];
  const now = nowIso();

  try {
  app.db.tx(() => {
    const checkpoint = app.db.get<{ engine_identity: string | null; pending_engine_identity: string | null; last_walk_done_at: string | null }>(
      "SELECT engine_identity, pending_engine_identity, last_walk_done_at FROM sync_checkpoints WHERE engine_user_id = ?", eu.id);
    let knownIdentity = checkpoint?.engine_identity ?? eu.engine_identity;
    // A replacement engine is adopted once everything it delivered has been reviewed.
    if (checkpoint?.pending_engine_identity === batch.engineIdentity
      && !app.db.get("SELECT 1 FROM reconciliation_queue WHERE engine_user_id = ? AND status = 'open' LIMIT 1", eu.id)) {
      app.db.run("UPDATE sync_checkpoints SET engine_identity = ?, pending_engine_identity = NULL WHERE engine_user_id = ?", batch.engineIdentity, eu.id);
      app.db.run("UPDATE engine_users SET engine_identity = ? WHERE id = ?", batch.engineIdentity, eu.id);
      knownIdentity = batch.engineIdentity;
    }
    const hasHistory = !!app.db.get("SELECT 1 FROM external_ids WHERE engine_user_id = ? LIMIT 1", eu.id);
    const replacement = knownIdentity !== null && knownIdentity !== batch.engineIdentity && hasHistory;

    for (const entry of batch.entries) {
      if (app.db.get("SELECT 1 FROM item_tombstones WHERE engine_user_id = ? AND external_id = ?", eu.id, entry.externalId)) {
        result.duplicates++;
        continue;
      }
      const source = app.db.get<{ id: string; kind: string; followed: number; curator: string | null; paused: number; is_private: number; full_text: number; created_at: string; backlog_settled_at: string | null; start_from: StartFrom }>(
        "SELECT id, kind, followed, curator, paused, is_private, full_text, created_at, backlog_settled_at, start_from FROM sources WHERE account_id = ? AND engine_stream_id = ? AND followed = 1", eu.account_id, entry.streamId);
      if (!source) { result.unknownStreams++; continue; }
      // Paused: nothing new is collected for this source until it is resumed (edits to existing items still apply).
      if (source.paused && !app.db.get("SELECT 1 FROM external_ids WHERE engine_user_id = ? AND external_id = ?", eu.id, entry.externalId)) {
        result.skippedPaused++;
        continue;
      }

      if (replacement) {
        if (app.db.get("SELECT 1 FROM reconciliation_queue WHERE engine_user_id = ? AND status = 'open' AND json_extract(entry, '$.externalId') = ?", eu.id, entry.externalId)) {
          result.duplicates++;
          continue;
        }
        app.db.run("INSERT INTO reconciliation_queue (id, account_id, engine_user_id, entry, candidate_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          newId("rec"), eu.account_id, eu.id, JSON.stringify(entry), matchByGuid(app, eu.account_id, source.id, entry), now);
        result.queuedForReview++;
        continue;
      }

      const mapped = app.db.get<{ item_id: string }>("SELECT item_id FROM external_ids WHERE engine_user_id = ? AND external_id = ?", eu.id, entry.externalId);
      if (mapped) {
        if (updateItem(app, eu.account_id, mapped.item_id, entry)) result.updated++;
        else result.duplicates++;
        continue;
      }
      // Same source + original GUID already known (e.g. reconnect), or an imported item with
      // the same link that this engine never delivered: attach a mapping instead of a duplicate.
      const guidMatch = matchByGuid(app, eu.account_id, source.id, entry) ?? matchUnmapped(app, eu, source.id, entry) ?? matchSameLink(app, eu.account_id, source.id, entry);
      if (guidMatch) {
        addMapping(app, eu, guidMatch, entry);
        result.duplicates++;
        continue;
      }
      const { isNew, ignored } = arrivalOf(source, entry);
      const created = createFromEntry(app, eu, source, entry, isNew, ignored, listedAtOf(source, entry));
      addMapping(app, eu, created, entry);
      // A copy is made by itself only for what the person will see: a source's backlog (a source followed from now) arrives Ignored and
      // stays as it came, and a copy of it is made when the person keeps it or asks for one.
      if (!ignored && source.full_text && fullTextAvailable(source)) queueAutoCapture(app, { accountId: eu.account_id, itemId: created, url: app.db.get<{ url: string | null }>("SELECT url FROM items WHERE id = ?", created)!.url });
      result.accepted++;
      touchedSources.set(source.id, (touchedSources.get(source.id) ?? 0) + 1);
      if (isNew) {
        newArrivals.set(source.id, (newArrivals.get(source.id) ?? 0) + 1);
        freshPosts.push({ itemId: created, sourceId: source.id });
      }
    }

    // A walk that began after a source was ready in the engine has now enumerated everything the source had, even
    // when that was nothing: from now on what it brings is New. A walk begins after the previous one ended, so the
    // boundary is that moment; a source that became ready during this walk is settled by the next. The boundary is
    // stored with the checkpoint, so it holds across batches, retries and restarts.
    if (batch.done && !replacement && checkpoint?.last_walk_done_at) {
      app.db.run(
        `UPDATE sources SET backlog_settled_at = ? WHERE account_id = ? AND followed = 1 AND engine_stream_id IS NOT NULL
           AND backlog_settled_at IS NULL AND subscribed_at IS NOT NULL AND subscribed_at <= ?`, now, eu.account_id, checkpoint.last_walk_done_at);
    }

    for (const [sourceId] of touchedSources) {
      // The newest item is the first in the source's own index order: one row, not every item the source has.
      app.db.run("UPDATE sources SET last_item_at = (SELECT listed_at FROM items WHERE account_id = ? AND source_id = ? ORDER BY listed_at DESC LIMIT 1), health = CASE WHEN health IN ('pending', 'quiet') THEN 'ok' ELSE health END, health_text = CASE WHEN health IN ('pending', 'quiet') THEN NULL ELSE health_text END, last_success_at = ? WHERE id = ?",
        eu.account_id, sourceId, now, sourceId);
    }
    app.db.run(
      `INSERT INTO sync_checkpoints (engine_user_id, engine_identity, continuation, newest_crawl_usec, last_success_at, last_attempt_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(engine_user_id) DO UPDATE SET engine_identity = CASE WHEN ? THEN engine_identity ELSE excluded.engine_identity END,
         continuation = excluded.continuation, newest_crawl_usec = COALESCE(excluded.newest_crawl_usec, newest_crawl_usec),
         last_success_at = CASE WHEN ? THEN excluded.last_success_at ELSE last_success_at END, last_attempt_at = excluded.last_attempt_at, last_error = NULL`,
      eu.id, replacement ? knownIdentity : batch.engineIdentity, batch.checkpoint.continuation, batch.checkpoint.newestCrawlUsec,
      batch.done ? now : null, now, replacement ? 1 : 0, batch.done ? 1 : 0,
    );
    if (batch.done && !replacement) app.db.run("UPDATE sync_checkpoints SET last_walk_done_at = ? WHERE engine_user_id = ?", now, eu.id);
    if (replacement) app.db.run("UPDATE sync_checkpoints SET pending_engine_identity = ? WHERE engine_user_id = ?", batch.engineIdentity, eu.id);
    if (!replacement && !eu.engine_identity) app.db.run("UPDATE engine_users SET engine_identity = ? WHERE id = ?", batch.engineIdentity, eu.id);
    // Posts a Smart filter judges are announced once it has, so a post it drops is never announced.
    for (const sourceId of queueNewPosts(app, { accountId: eu.account_id}, freshPosts)) newArrivals.delete(sourceId);
    if (newArrivals.size) notifyArrivals(app, eu.account_id, [...newArrivals.entries()], batch.idempotencyKey);
    app.db.run("INSERT INTO applied_batches (idempotency_key, engine_user_id, applied_at, result) VALUES (?, ?, ?, ?)",
      batch.idempotencyKey, eu.id, now, JSON.stringify(result));
  });
  } catch (err) {
    // Nothing from this batch committed and the checkpoint did not advance; the worker retries later.
    if (err instanceof StorageFull) markPaused(app, err);
    throw err;
  }

  if (result.accepted || result.updated) {
    emit(app, eu.account_id, { type: "items", sourceIds: [...touchedSources.keys()], count: result.accepted });
    emit(app, eu.account_id, { type: "storage" });
  }
  if (result.queuedForReview) emit(app, eu.account_id, { type: "jobs" });
  return result;
}

function matchByGuid(app: App, accountId: string, sourceId: string, entry: SyncEntry): string | null {
  if (!entry.originalGuid) return null;
  const rows = app.db.all<{ item_id: string }>(
    `SELECT DISTINCT e.item_id FROM external_ids e JOIN items i ON i.id = e.item_id
     WHERE e.account_id = ? AND i.source_id = ? AND e.original_guid = ? LIMIT 2`, accountId, sourceId, entry.originalGuid);
  return rows.length === 1 ? rows[0]!.item_id : null; // ambiguous (reused GUID) -> no automatic match
}

/**
 * An item of this source (e.g. from an import) with the same link, or title and date, and no mapping from this engine user.
 * At most UNMAPPED_CANDIDATES items with that link (or title and date) are looked at: a feed repeating one link thousands
 * of times would otherwise have every new entry walk all the earlier ones. With more than that, the match is ambiguous
 * (some went unseen), so none is made and the entry becomes an item of its own: never a post taken for one it isn't.
 */
const UNMAPPED_CANDIDATES = 200;
function matchUnmapped(app: App, eu: EngineUser, sourceId: string, entry: SyncEntry): string | null {
  const unmapped = "NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.item_id = i.id AND e.engine_user_id = ?)";
  const rows = entry.url
    ? app.db.all<{ id: string; unmapped: number }>(`SELECT i.id, ${unmapped} AS unmapped FROM items i WHERE i.source_id = ? AND i.url = ? LIMIT ${UNMAPPED_CANDIDATES + 1}`, eu.id, sourceId, entry.url)
    : entry.publishedAt
      ? app.db.all<{ id: string; unmapped: number }>(`SELECT i.id, ${unmapped} AS unmapped FROM items i WHERE i.source_id = ? AND i.title = ? AND i.published_at = ? LIMIT ${UNMAPPED_CANDIDATES + 1}`, eu.id, sourceId, entry.title.trim(), entry.publishedAt)
      : [];
  if (rows.length > UNMAPPED_CANDIDATES) return null;
  const free = rows.filter((r) => r.unmapped === 1);
  return free.length === 1 ? free[0]!.id : null;
}

function addMapping(app: App, eu: EngineUser, itemId: string, entry: SyncEntry): void {
  app.db.run("INSERT OR IGNORE INTO external_ids (id, account_id, item_id, engine_user_id, external_id, stream_id, original_guid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId("ext"), eu.account_id, itemId, eu.id, entry.externalId, entry.streamId, entry.originalGuid, nowIso());
}

/**
 * Entries a source already had when it was followed are its backlog, not New. Until the source is settled (see
 * the end of applySyncBatch), an entry published before the follow time is backlog; so is every undated entry
 * (it was already there the first time anyone looked). Later entries are New.
 */
export function isBacklog(source: { created_at: string; backlog_settled_at: string | null }, entry: Pick<SyncEntry, "publishedAt">): boolean {
  if (source.backlog_settled_at) return false;
  if (!entry.publishedAt) return true;
  const published = Date.parse(entry.publishedAt);
  return Number.isFinite(published) && published < Date.parse(source.created_at);
}

/** How a source followed from now (`sources.start_from`) treats its backlog; "all" is every source followed before the choice existed. */
export type StartFrom = "all" | "now" | "week";
/** "Also show the last week" reaches back this far from the moment of the follow. */
const LAST_WEEK_MS = 7 * 86_400_000;

/**
 * What a new entry becomes. A post that comes after the follow is New. A source's backlog is not New, and arrives Ignored
 * (hidden from lists, left out of Home, the counts and the digests, found by search) unless the source was followed with its last
 * week: the posts published in the 7 days before the follow are New, like any post that arrives. A source followed before the
 * choice existed ("all") shows its backlog as ordinary older items.
 */
export function arrivalOf(source: { created_at: string; backlog_settled_at: string | null; start_from: StartFrom }, entry: Pick<SyncEntry, "publishedAt">): { isNew: boolean; ignored: boolean } {
  if (!isBacklog(source, entry)) return { isNew: true, ignored: false };
  if (source.start_from === "all") return { isNew: false, ignored: false };
  if (source.start_from === "week" && entry.publishedAt && Date.parse(entry.publishedAt) >= Date.parse(source.created_at) - LAST_WEEK_MS) return { isNew: true, ignored: false };
  return { isNew: false, ignored: true };
}

/**
 * An entry's time in lists (`items.listed_at`): a post that comes after the follow is listed when it arrived, so it is never listed
 * below posts that came before it because its publisher dated it before putting it in the feed. The backlog is listed at its
 * publication date, else its arrival: everything a source had arrives at once, and it is ordered by when it was published.
 */
export function listedAtOf(source: { created_at: string; backlog_settled_at: string | null }, entry: Pick<SyncEntry, "publishedAt" | "crawledAt">): string {
  return isBacklog(source, entry) ? entry.publishedAt ?? entry.crawledAt : entry.crawledAt;
}

const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The same source delivering the same link again under another id (a feed that reissues posts) is one item: the new
 * entry is attached to the item it repeats. Conservative: the same source, the same address and the same headline,
 * within 30 days. A feed that gives many posts one address (a link to its home page) keeps them apart by headline.
 */
function matchSameLink(app: App, accountId: string, sourceId: string, entry: SyncEntry): string | null {
  const key = entry.url ? linkKey(entry.url) : null;
  const title = titleKey(entry.title);
  if (!key || !title) return null;
  const since = new Date(Date.parse(entry.crawledAt) - 30 * 86_400_000).toISOString();
  // Looked up by the stored key (items.link_key, indexed): a source with many recent items is not scanned row by row.
  const rows = app.db.all<{ id: string; title: string }>(
    "SELECT id, title FROM items WHERE account_id = ? AND source_id = ? AND link_key = ? AND discovered_at >= ? LIMIT 20",
    accountId, sourceId, key, since);
  return rows.find((r) => titleKey(r.title) === title)?.id ?? null;
}

function createFromEntry(app: App, eu: EngineUser, source: { id: string; kind: string; curator: string | null }, entry: SyncEntry, isNew: boolean, ignored: boolean, listedAt: string): string {
  // A DOI in the link, or in short abstract-like text, marks a paper; a long post that merely cites one is not.
  const text = toText(entry.summaryHtml ?? entry.contentHtml);
  const doi = findDoi(entry.url) ?? (text.length < 3000 ? findDoi(entry.summaryHtml, entry.contentHtml) : null);
  const kind = detectKind({ sourceKind: source.kind, url: entry.url, doi, enclosures: entry.enclosures });
  return insertItem(app, {
    accountId: eu.account_id,
    sourceId: source.id,
    kind,
    title: entry.title,
    url: entry.url,
    author: entry.author,
    summaryHtml: entry.summaryHtml,
    contentHtml: entry.contentHtml,
    imageUrl: entry.imageUrl,
    durationSeconds: null,
    doi,
    curatorNote: null,
    publishedAt: entry.publishedAt,
    discoveredAt: entry.crawledAt,
    listedAt,
    enclosures: entry.enclosures,
    contentOmitted: entry.contentOmitted === true,
    isNew,
    ignored,
    reason: "feed item",
  }).id;
}

/** Mark a completed sync run: clears the delay warning and schedules the next run normally. */
export function recordSyncSuccess(app: App, engineUserId: string): void {
  const now = nowIso();
  app.db.run(
    `INSERT INTO sync_checkpoints (engine_user_id, last_success_at, last_attempt_at, last_error) VALUES (?, ?, ?, NULL)
     ON CONFLICT(engine_user_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL, consecutive_failures = 0`,
    engineUserId, now, now);
}
