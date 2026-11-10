import { newId } from "@purss/domain";
import type { SyncBatch, SyncEntry } from "@purss/domain";
import type { App } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, nowIso } from "../http.ts";
import { admitObject, markPaused, releaseObject, StorageFull } from "./storage.ts";
import { contentHash, detectKind, excerpt, findDoi, sanitize, toText } from "./content.ts";
import { insertItem, reindex, versionBytes } from "./items.ts";
import { urlKey } from "./url-key.ts";
import { notifyArrivals } from "./notifications.ts";
import { fullTextAvailable, queueAutoCapture } from "./captures.ts";
import { queueNewPosts } from "./ai-filters.ts";

type EngineUser = { id: string; account_id: string; workspace_id: string; engine_identity: string | null };

export type BatchResult = { accepted: number; updated: number; duplicates: number; unknownStreams: number; queuedForReview: number; skippedPaused: number };

/**
 * Apply one engine sync batch atomically with its checkpoint (plan/06). Replays of
 * the same idempotency key return the original result. Absence of an entry never
 * deletes anything. A changed engine identity routes entries to reconciliation.
 */
export function applySyncBatch(app: App, engineUserId: string, batch: SyncBatch): BatchResult {
  const eu = app.db.get<EngineUser>("SELECT id, account_id, workspace_id, engine_identity FROM engine_users WHERE id = ?", engineUserId);
  if (!eu) throw new HttpError(404, "not_found", "Unknown engine user.");
  const prior = app.db.get<{ result: string }>("SELECT result FROM applied_batches WHERE idempotency_key = ?", batch.idempotencyKey);
  if (prior) return { ...(JSON.parse(prior.result) as BatchResult), duplicates: batch.entries.length };

  const result: BatchResult = { accepted: 0, updated: 0, duplicates: 0, unknownStreams: 0, queuedForReview: 0, skippedPaused: 0 };
  const touchedSources = new Map<string, number>();
  // New items per source, for notifications: a source's back catalogue is not New and tells no one.
  const freshArrivals = new Map<string, number>();
  // New posts, for Smart filters (plan/36).
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
      const source = app.db.get<{ id: string; kind: string; followed: number; curator: string | null; paused: number; is_private: number; full_text: number; created_at: string; backlog_settled_at: string | null }>(
        "SELECT id, kind, followed, curator, paused, is_private, full_text, created_at, backlog_settled_at FROM sources WHERE workspace_id = ? AND engine_stream_id = ? AND followed = 1", eu.workspace_id, entry.streamId);
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
        app.db.run("INSERT INTO reconciliation_queue (id, workspace_id, engine_user_id, entry, candidate_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          newId("rec"), eu.workspace_id, eu.id, JSON.stringify(entry), matchByGuid(app, eu.workspace_id, source.id, entry), now);
        result.queuedForReview++;
        continue;
      }

      const mapped = app.db.get<{ item_id: string }>("SELECT item_id FROM external_ids WHERE engine_user_id = ? AND external_id = ?", eu.id, entry.externalId);
      if (mapped) {
        if (updateItem(app, eu, mapped.item_id, entry)) result.updated++;
        else result.duplicates++;
        continue;
      }
      // Same source + original GUID already known (e.g. reconnect), or an imported item with
      // the same link that this engine never delivered: attach a mapping instead of a duplicate.
      const guidMatch = matchByGuid(app, eu.workspace_id, source.id, entry) ?? matchUnmapped(app, eu, source.id, entry) ?? matchSameLink(app, eu.workspace_id, source.id, entry);
      if (guidMatch) {
        addMapping(app, eu, guidMatch, entry);
        result.duplicates++;
        continue;
      }
      const fresh = !isBackCatalogue(source, entry);
      const created = createFromEntry(app, eu, source, entry, fresh);
      addMapping(app, eu, created, entry);
      if (source.full_text && fullTextAvailable(source)) queueAutoCapture(app, { accountId: eu.account_id, workspaceId: eu.workspace_id, itemId: created, url: app.db.get<{ url: string | null }>("SELECT url FROM items WHERE id = ?", created)!.url });
      result.accepted++;
      touchedSources.set(source.id, (touchedSources.get(source.id) ?? 0) + 1);
      if (fresh) {
        freshArrivals.set(source.id, (freshArrivals.get(source.id) ?? 0) + 1);
        freshPosts.push({ itemId: created, sourceId: source.id });
      }
    }

    // A walk that began after a source was ready in the engine has now enumerated everything the source had, even
    // when that was nothing: from now on what it brings is New. A walk begins after the previous one ended, so the
    // boundary is that moment; a source that became ready during this walk is settled by the next. The boundary is
    // stored with the checkpoint, so it holds across batches, retries and restarts.
    if (batch.done && !replacement && checkpoint?.last_walk_done_at) {
      app.db.run(
        `UPDATE sources SET backlog_settled_at = ? WHERE workspace_id = ? AND followed = 1 AND engine_stream_id IS NOT NULL
           AND backlog_settled_at IS NULL AND subscribed_at IS NOT NULL AND subscribed_at <= ?`, now, eu.workspace_id, checkpoint.last_walk_done_at);
    }

    for (const [sourceId] of touchedSources) {
      // The newest item is the first in the source's own index order: one row, not every item the source has.
      app.db.run("UPDATE sources SET last_item_at = (SELECT COALESCE(published_at, discovered_at) FROM items WHERE workspace_id = ? AND source_id = ? ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT 1), health = CASE WHEN health IN ('pending', 'quiet') THEN 'ok' ELSE health END, health_text = CASE WHEN health IN ('pending', 'quiet') THEN NULL ELSE health_text END, last_success_at = ? WHERE id = ?",
        eu.workspace_id, sourceId, now, sourceId);
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
    for (const sourceId of queueNewPosts(app, { accountId: eu.account_id, workspaceId: eu.workspace_id }, freshPosts)) freshArrivals.delete(sourceId);
    if (freshArrivals.size) notifyArrivals(app, eu.workspace_id, [...freshArrivals.entries()], batch.idempotencyKey);
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

function matchByGuid(app: App, workspaceId: string, sourceId: string, entry: SyncEntry): string | null {
  if (!entry.originalGuid) return null;
  const rows = app.db.all<{ item_id: string }>(
    `SELECT DISTINCT e.item_id FROM external_ids e JOIN items i ON i.id = e.item_id
     WHERE e.workspace_id = ? AND i.source_id = ? AND e.original_guid = ?`, workspaceId, sourceId, entry.originalGuid);
  return rows.length === 1 ? rows[0]!.item_id : null; // ambiguous (reused GUID) -> no automatic match
}

/** An item of this source (e.g. from an import) with the same link, or title and date, and no mapping from this engine user. */
function matchUnmapped(app: App, eu: EngineUser, sourceId: string, entry: SyncEntry): string | null {
  const unmapped = "NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.item_id = i.id AND e.engine_user_id = ?)";
  const rows = entry.url
    ? app.db.all<{ id: string }>(`SELECT i.id FROM items i WHERE i.source_id = ? AND i.url = ? AND ${unmapped} LIMIT 2`, sourceId, entry.url, eu.id)
    : entry.publishedAt
      ? app.db.all<{ id: string }>(`SELECT i.id FROM items i WHERE i.source_id = ? AND i.title = ? AND i.published_at = ? AND ${unmapped} LIMIT 2`, sourceId, entry.title.trim(), entry.publishedAt, eu.id)
      : [];
  return rows.length === 1 ? rows[0]!.id : null;
}

function addMapping(app: App, eu: EngineUser, itemId: string, entry: SyncEntry): void {
  app.db.run("INSERT OR IGNORE INTO external_ids (id, workspace_id, item_id, engine_user_id, external_id, stream_id, original_guid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId("ext"), eu.workspace_id, itemId, eu.id, entry.externalId, entry.streamId, entry.originalGuid, nowIso());
}

/**
 * Entries a source already had when it was followed are its back catalogue, not New. Until the source is settled (see
 * the end of applySyncBatch), an entry published before the follow time is back catalogue; so is every undated entry
 * (it was already there the first time anyone looked). Later entries are New.
 */
export function isBackCatalogue(source: { created_at: string; backlog_settled_at: string | null }, entry: Pick<SyncEntry, "publishedAt">): boolean {
  if (source.backlog_settled_at) return false;
  if (!entry.publishedAt) return true;
  const published = Date.parse(entry.publishedAt);
  return Number.isFinite(published) && published < Date.parse(source.created_at);
}

/** The same address in a form that doesn't depend on the scheme, "www.", tracking parameters or a trailing slash. */
export function linkKey(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|ref$)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${query}`;
}

const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The same source delivering the same link again under another id (a feed that reissues posts) is one item: the new
 * entry is attached to the item it repeats. Conservative: the same source, the same address and the same headline,
 * within 30 days. A feed that gives many posts one address (a link to its home page) keeps them apart by headline.
 */
function matchSameLink(app: App, workspaceId: string, sourceId: string, entry: SyncEntry): string | null {
  const key = entry.url ? linkKey(entry.url) : null;
  const title = titleKey(entry.title);
  if (!key || !title) return null;
  const since = new Date(Date.parse(entry.crawledAt) - 30 * 86_400_000).toISOString();
  const needle = key.split("?")[0]!;
  const rows = app.db.all<{ id: string; url: string; title: string }>(
    "SELECT id, url, title FROM items WHERE workspace_id = ? AND source_id = ? AND discovered_at >= ? AND url IS NOT NULL AND instr(lower(url), ?) > 0 LIMIT 20",
    workspaceId, sourceId, since, needle.toLowerCase());
  return rows.find((r) => linkKey(r.url) === key && titleKey(r.title) === title)?.id ?? null;
}

function createFromEntry(app: App, eu: EngineUser, source: { id: string; kind: string; curator: string | null }, entry: SyncEntry, fresh: boolean): string {
  // A DOI in the link, or in short abstract-like text, marks a paper; a long post that merely cites one is not.
  const text = toText(entry.summaryHtml ?? entry.contentHtml);
  const doi = findDoi(entry.url) ?? (text.length < 3000 ? findDoi(entry.summaryHtml, entry.contentHtml) : null);
  const kind = detectKind({ sourceKind: source.kind, url: entry.url, doi, enclosures: entry.enclosures });
  return insertItem(app, {
    accountId: eu.account_id,
    workspaceId: eu.workspace_id,
    sourceId: source.id,
    kind,
    title: entry.title.trim() || excerpt(toText(entry.summaryHtml ?? entry.contentHtml), 80) || "(untitled)",
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
    enclosures: entry.enclosures,
    contentOmitted: entry.contentOmitted === true,
    fresh,
    reason: "feed item",
  }).id;
}

/**
 * Apply an upstream edit. A kept (pinned) version is never modified: the edit becomes
 * a new current version, admitted as feed growth. When growth is paused the edit is
 * deferred (the batch still commits; the next edit or resync can apply it).
 */
export type ItemRevision = Pick<SyncEntry, "title" | "url" | "author" | "summaryHtml" | "contentHtml" | "imageUrl" | "enclosures" | "publishedAt" | "contentOmitted">;

export function updateItem(app: App, eu: Pick<EngineUser, "account_id" | "workspace_id">, itemId: string, entry: ItemRevision): boolean {
  const cur = app.db.get<{ current_version_id: string; content_hash: string; source_id: string | null }>(
    "SELECT i.current_version_id, v.content_hash, i.source_id FROM items i JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?", itemId);
  if (!cur) return false;
  // An update whose text was too large to send must not replace text the item already has: that stays as it is.
  const held = entry.contentOmitted
    ? app.db.get<{ summary_html: string | null; content_html: string | null; content_omitted: number }>("SELECT summary_html, content_html, content_omitted FROM item_versions WHERE id = ?", cur.current_version_id)
    : undefined;
  const keepText = !!held?.content_html;
  const summaryHtml = keepText ? held!.summary_html : sanitize(entry.summaryHtml);
  const contentHtml = keepText ? held!.content_html : sanitize(entry.contentHtml);
  const contentOmitted = entry.contentOmitted && !keepText ? 1 : 0;
  const title = entry.title.trim() || "(untitled)";
  const hash = contentHash(title, entry.url, summaryHtml, contentHtml);
  if (hash === cur.content_hash) return false;
  const versionId = newId("ver");
  const now = nowIso();
  try {
    app.db.tx(() => {
      app.db.run("INSERT INTO item_versions (id, item_id, workspace_id, title, url, summary_html, content_html, content_hash, content_omitted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        versionId, itemId, eu.workspace_id, title, entry.url, summaryHtml, contentHtml, hash, contentOmitted, now);
      admitObject(app, {
        accountId: eu.account_id, workspaceId: eu.workspace_id, kind: "item_version", refId: versionId, itemId, sourceId: cur.source_id,
        bytes: versionBytes({ title, url: entry.url, author: entry.author, summaryHtml, contentHtml, imageUrl: entry.imageUrl, enclosures: entry.enclosures, publishedAt: entry.publishedAt }),
        reason: "feed item update",
      });
      const text = toText(contentHtml ?? summaryHtml);
      app.db.run("UPDATE items SET title = ?, url = ?, url_key = ?, author = ?, excerpt = ?, image_url = COALESCE(?, image_url), current_version_id = ?, updated_at = ? WHERE id = ?",
        title, entry.url, urlKey(entry.url), entry.author, excerpt(toText(summaryHtml) || text), entry.imageUrl, versionId, now, itemId);
      const pinned = app.db.get("SELECT 1 FROM basket_items WHERE version_id = ?", cur.current_version_id);
      if (!pinned) {
        // The superseded version was never kept: it is replaced, not retained.
        releaseObject(app, "item_version", cur.current_version_id, "replaced by upstream edit");
        app.db.run("DELETE FROM item_versions WHERE id = ?", cur.current_version_id);
      }
      reindex(app, itemId);
    });
    return true;
  } catch (err) {
    if (err instanceof StorageFull) { markPaused(app, err); return false; } // deferred while growth is paused
    throw err;
  }
}

/** Mark a completed sync run: clears the delay warning and schedules the next run normally. */
export function recordSyncSuccess(app: App, engineUserId: string): void {
  const now = nowIso();
  app.db.run(
    `INSERT INTO sync_checkpoints (engine_user_id, last_success_at, last_attempt_at, last_error) VALUES (?, ?, ?, NULL)
     ON CONFLICT(engine_user_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL, consecutive_failures = 0`,
    engineUserId, now, now);
}
