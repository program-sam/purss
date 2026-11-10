import { FULL_TEXT_BACKFILL, newId } from "@purss/domain";
import type { DiscoveryResult, PodcastSearchResponse, SourceDTO, SourceHealth } from "@purss/domain";
import { coreName, discover, searchPodcasts } from "@purss/connectors";
import type { PodcastSearchOptions } from "@purss/connectors";
import type { z } from "zod";
import type { followSchema, sourcePatchSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { bridgeClient } from "./bridge.ts";
import { recordDiscoveryMiss } from "./discovery-misses.ts";
import { emit } from "../app.ts";
import { HttpError, addSeconds, badRequest, notFound, nowIso } from "../http.ts";
import { enqueue } from "./jobs.ts";
import { hueFor, initialsFor } from "./content.ts";
import { iconUrl } from "./icons.ts";
import { createCollection, deleteItemNow } from "./collections.ts";
import { readSecret, removeSecret, writeSecret } from "../secrets.ts";
import { privateFeedKey } from "./feed-keys.ts";
import { dropCandidate, holdCandidate, peekCandidate } from "./discovery-cache.ts";
import { fullTextAvailable, queueAutoCapture } from "./captures.ts";
import { HAS_ANNOTATIONS } from "./annotations.ts";
import { itemCounts } from "./counts.ts";
import { deleteSourceNotifications } from "./notifications.ts";
import { assertRoom } from "./plans.ts";
import { deliverNews } from "./news.ts";
import { isNewsFeed, newsCandidate } from "./news-address.ts";

const QUIET_DAYS = 30;
/** What a followed feed says while it has no posts at all. */
export const NO_POSTS_YET = "No posts yet. Still following; new posts will appear here.";

type SourceRow = {
  id: string; kind: SourceDTO["kind"]; title: string; origin: string; site_url: string | null; feed_url: string | null; is_private: number;
  curator: string | null; hue: number; paused: number; notify: SourceDTO["notify"]; health: SourceHealth; health_text: string | null;
  last_success_at: string | null; last_item_at: string | null; created_at: string; fresh: number; items: number; collection_ids: string | null; ai_filtered: number;
  icon_digest: string | null;
  full_text: number;
  builtin: string | null;
  paused_until: string | null;
};

function healthOf(r: SourceRow): { health: SourceHealth; text: string | null } {
  if (r.health === "reconnect") return { health: "reconnect", text: r.health_text ?? "Reconnect required: this private source needs its link again." };
  if (r.paused) {
    const until = r.paused_until ? new Date(r.paused_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
    return { health: "paused", text: until ? `Paused until ${until}. Nothing new is collected until then.` : "Paused. Nothing new is collected until you resume it." };
  }
  if (r.health !== "ok" && r.health !== "quiet") return { health: r.health, text: r.health_text };
  // The engine looked at the feed and it had nothing in it yet (see applySyncBatch).
  if (r.health === "quiet" && !r.last_item_at) return { health: "quiet", text: r.health_text ?? NO_POSTS_YET };
  const last = r.last_item_at ?? r.last_success_at;
  if (last) {
    const days = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
    if (days >= QUIET_DAYS) return { health: "quiet", text: `No new posts for ${days} days. Still following.` };
  }
  return { health: "ok", text: null };
}

export function listSources(app: App, p: Principal): SourceDTO[] {
  const rows = app.db.all<SourceRow>(
    `SELECT s.*,
       0 AS fresh, 0 AS items,
       (SELECT group_concat(cs.collection_id) FROM collection_sources cs WHERE cs.source_id = s.id) AS collection_ids,
       (SELECT digest FROM source_icons si WHERE si.source_id = s.id) AS icon_digest,
       EXISTS (SELECT 1 FROM ai_filters f WHERE f.enabled = 1 AND f.source_id = s.id) AS ai_filtered
     FROM sources s WHERE s.workspace_id = ? AND s.followed = 1 AND s.kind <> 'manual' ORDER BY lower(s.title)`, p.workspaceId);
  // The counts of every source come from one pass over the PURSS, not from a lookup per source.
  const counts = itemCounts(app, p.workspaceId);
  return rows.map((r) => toSourceDTO({ ...r, fresh: counts.fresh(r.id), items: counts.items(r.id) }));
}

function toSourceDTO(r: SourceRow): SourceDTO {
  const h = healthOf(r);
  return {
    id: r.id, title: r.title, kind: r.kind, origin: r.origin, siteUrl: r.site_url, feedUrl: r.is_private ? null : r.feed_url,
    collectionIds: r.collection_ids ? r.collection_ids.split(",") : [], health: h.health, healthText: h.text,
    lastItemAt: r.last_item_at, lastSuccessAt: r.last_success_at, freshCount: r.fresh, itemCount: r.items, paused: r.paused === 1,
    pausedUntil: r.paused === 1 ? r.paused_until : null,
    hue: r.hue, initials: initialsFor(r.title), iconUrl: iconUrl(r.id, r.icon_digest), curator: r.curator, notify: r.notify,
    fullText: r.full_text === 1 && fullTextAvailable(r), fullTextAvailable: fullTextAvailable(r), aiFiltered: r.ai_filtered === 1,
  };
}

export function getSource(app: App, p: Principal, id: string): SourceDTO {
  const r = app.db.get<SourceRow>(
    `SELECT s.*, (SELECT COUNT(*) FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.source_id = s.id AND st.fresh = 1) AS fresh,
       (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items,
       (SELECT group_concat(cs.collection_id) FROM collection_sources cs WHERE cs.source_id = s.id) AS collection_ids,
       (SELECT digest FROM source_icons si WHERE si.source_id = s.id) AS icon_digest,
       EXISTS (SELECT 1 FROM ai_filters f WHERE f.enabled = 1 AND f.source_id = s.id) AS ai_filtered
     FROM sources s WHERE s.id = ? AND s.workspace_id = ?`, id, p.workspaceId);
  if (!r) throw notFound("That source");
  return toSourceDTO(r);
}

/** Discovery runs the safe fetcher; candidates are held server-side behind opaque tokens. */
export async function discoverSources(app: App, p: Principal, url: string): Promise<DiscoveryResult> {
  const news = newsCandidate(app, url);
  if (news) return { ok: true, url, candidates: presentCandidates(app, p, [news]) };
  const result = await discover(url, { bridge: bridgeClient(app) });
  if (!result.ok) {
    recordDiscoveryMiss(app, url, result.reason); // counts the site only, for the administrator; never changes the answer
    return result;
  }
  return { ...result, candidates: presentCandidates(app, p, result.candidates) };
}

/** Found feeds held behind opaque tokens, each with whether this PURSS already follows it, or follows a source of the same name. */
export function presentCandidates(app: App, p: Principal, drafts: Parameters<typeof holdCandidate>[2][]) {
  const byName = followedByName(app, p);
  return drafts.map((c) => holdDraft(app, p, c, byName));
}

/** Shows named like `query` in Apple's podcast directory. Nothing is stored; the person picks one and it is looked up like any feed address. */
export async function searchPodcastDirectory(query: string, opts?: PodcastSearchOptions): Promise<PodcastSearchResponse> {
  const found = await searchPodcasts(query, opts);
  return found.ok ? { ok: true, query, hits: found.hits } : found;
}

/** The followed sources by the part of their name that says what they are, to point out a second source with the same name. */
function followedByName(app: App, p: Principal): Map<string, { id: string; title: string }> {
  const byName = new Map<string, { id: string; title: string }>();
  for (const s of app.db.all<{ id: string; title: string }>("SELECT id, title FROM sources WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual' ORDER BY created_at", p.workspaceId)) {
    const key = coreName(s.title);
    if (key && !byName.has(key)) byName.set(key, s);
  }
  return byName;
}

/** The followed source of this PURSS for a feed address: by the address, or for a private source by its keyed hash. */
export function followedSource(app: App, p: Principal, feedUrl: string): { id: string } | undefined {
  const key = privateFeedKey(app, p.workspaceId, feedUrl);
  return app.db.get<{ id: string }>(
    "SELECT id FROM sources WHERE workspace_id = ? AND followed = 1 AND (feed_url = ? OR (feed_key IS NOT NULL AND feed_key = ?)) LIMIT 1", p.workspaceId, feedUrl, key);
}

/** A found feed behind an opaque token, with whether this PURSS already follows it, or follows a source of the same name. */
function holdDraft(app: App, p: Principal, c: Parameters<typeof holdCandidate>[2], byName: Map<string, { id: string; title: string }>) {
  const token = newId("dsc");
  const existing = followedSource(app, p, c.feedUrl);
  holdCandidate(token, p.workspaceId, c);
  const same = existing ? undefined : byName.get(coreName(c.title));
  return { ...c, token, alreadyFollowingSourceId: existing?.id ?? null, sameNameSource: same ?? null };
}

type Candidate = Omit<DiscoveryResult & { ok: true }, "ok" | "url">["candidates"][number];

/** For private sources keep only the site's origin: a feed's site link can carry the same secret. */
function siteOrigin(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function followSource(app: App, p: Principal, input: z.infer<typeof followSchema>): SourceDTO {
  const c = peekCandidate(input.token, p.workspaceId) as Candidate | null;
  if (!c) throw badRequest("That preview has expired. Please look up the link again.", "expired");
  const existing = followedSource(app, p, c.feedUrl);
  if (existing) return getSource(app, p, existing.id);
  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (!engineUser) throw badRequest("Your PURSS isn't connected to the collection engine yet. Try again in a minute.", "engine_pending");
  // This installation's news comes from here, not from the engine (services/news.ts).
  const isNews = isNewsFeed(app, c.feedUrl);
  // A bridged source's address is a descriptor, not a link anyone holds, so it is never a private link.
  const isPrivate = !isNews && !c.feedUrl.startsWith("bridge:") && (input.markPrivate || !!c.privateWarning);
  // An unfollowed source keeps its items. Following the same feed again takes that source up again; a second one
  // would hold a second copy of everything, and the first copy could no longer be reached or cleaned up.
  const former = isPrivate ? undefined : app.db.get<{ id: string; title: string }>(
    `SELECT id, title FROM sources WHERE workspace_id = ? AND feed_url = ? AND followed = 0 AND kind <> 'manual' ${isNews ? "AND builtin = 'news'" : ""} ORDER BY created_at DESC LIMIT 1`, p.workspaceId, c.feedUrl);
  const id = former?.id ?? newId("src");
  const title = input.title ?? former?.title ?? c.title;
  const fullText = input.fullText && fullTextAvailable({ kind: c.kind, is_private: isPrivate ? 1 : 0 });
  try {
    app.db.tx(() => {
      assertRoom(app, p.accountId, "sources");
      let collectionId = input.collectionId;
      if (!collectionId && input.newCollectionName) collectionId = createCollection(app, p, { name: input.newCollectionName, emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" }).id;
      if (collectionId && !app.db.get("SELECT 1 FROM collections WHERE id = ? AND workspace_id = ? AND mode = 'sources'", collectionId, p.workspaceId)) throw notFound("That collection");
      if (former) {
        // Followed from now: what the feed already had is back catalogue again, not New, and the engine has yet to confirm this new subscription.
        app.db.run(
          `UPDATE sources SET followed = 1, kind = ?, title = ?, origin = ?, site_url = ?, hue = ?, full_text = ?, paused = 0, engine_stream_id = NULL,
             health = ?, health_text = ?, created_at = ?, backlog_settled_at = NULL, subscribed_at = NULL WHERE id = ?`,
          c.kind, title, c.origin, c.siteUrl, hueFor(title), fullText ? 1 : 0, isNews ? "ok" : "pending", isNews ? null : "Collecting the first items…", nowIso(), id,
        );
      } else {
        // Private (secret-link) feed URLs never enter the database or job payloads; they go to the secrets directory.
        app.db.run(
          `INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, site_url, feed_url, feed_key, is_private, hue, full_text, health, health_text, builtin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, p.accountId, p.workspaceId, isPrivate ? "private" : c.kind, title, c.origin, isPrivate ? siteOrigin(c.siteUrl) : c.siteUrl, isPrivate ? null : c.feedUrl, isPrivate ? privateFeedKey(app, p.workspaceId, c.feedUrl) : null, isPrivate ? 1 : 0, hueFor(title), fullText ? 1 : 0,
          isNews ? "ok" : "pending", isNews ? null : "Collecting the first items…", isNews ? "news" : null, nowIso(),
        );
        if (isPrivate) writeSecret(app.config.secretsDir, `source-urls/${id}`, c.feedUrl);
      }
      if (collectionId) {
        app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", collectionId, id);
        if (!input.showOnHome) app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ? AND show_on_home = 1 AND NOT EXISTS (SELECT 1 FROM collection_sources WHERE collection_id = ? AND source_id <> ?)", collectionId, collectionId, id);
      }
      if (!isNews) enqueue(app, "engine.subscribe", { engineUserId: engineUser.id, sourceId: id, feedUrl: isPrivate ? `secret:source-urls/${id}` : c.feedUrl, title }, { accountId: p.accountId, workspaceId: p.workspaceId, idempotencyKey: `subscribe:${id}` });
    });
  } catch (err) {
    // The link file was written inside the transaction; a source that was not made has no business keeping it (deletion lists only existing sources' files).
    if (isPrivate && !former) removeSecret(app.config.secretsDir, `source-urls/${id}`);
    throw err;
  }
  dropCandidate(input.token);
  // Followed again: its newest posts and anything it missed arrive now (the maintenance tick would bring them too).
  if (isNews) deliverNews(app);
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

/**
 * Engine confirmed the subscription: remember its stream and pull the first items. `empty`: the engine, which fetches a feed
 * when it adds it, says that feed has nothing in it. That is evidence about this feed, so the source says "No posts yet"
 * now instead of "Collecting the first items…" for ever; its first post (see applySyncBatch) makes it an ordinary source.
 * Without that word, nothing is claimed.
 */
export function onSubscribed(app: App, sourceId: string, streamId: string, evidence: { empty?: boolean } = {}): void {
  const s = app.db.get<{ account_id: string; workspace_id: string; followed: number }>("SELECT account_id, workspace_id, followed FROM sources WHERE id = ?", sourceId);
  if (!s) return;
  const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", s.account_id);
  if (!s.followed) {
    // Unfollowed while the engine was still subscribing: undo the subscription there too.
    if (eu) enqueue(app, "engine.unsubscribe", { engineUserId: eu.id, streamId }, { accountId: s.account_id, workspaceId: s.workspace_id });
    return;
  }
  // A source that was waiting on a retry is following now; its first items are on the way.
  app.db.run(
    `UPDATE sources SET engine_stream_id = ?, subscribed_at = COALESCE(subscribed_at, ?), health = CASE WHEN health = 'error' THEN 'pending' ELSE health END,
       health_text = CASE WHEN health = 'error' THEN 'Collecting the first items…' ELSE health_text END WHERE id = ?`, streamId, nowIso(), sourceId);
  if (evidence.empty === true) {
    app.db.run("UPDATE sources SET health = 'quiet', health_text = ? WHERE id = ? AND health = 'pending' AND NOT EXISTS (SELECT 1 FROM items WHERE items.source_id = sources.id)", NO_POSTS_YET, sourceId);
  }
  if (eu) enqueue(app, "engine.sync", { engineUserId: eu.id }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `sync:${eu.id}`, runAfter: addSeconds(5) });
  emit(app, s.account_id, { type: "source", sourceId });
}

/** The engine couldn't follow the feed: the source says why, whether or not it will be asked again by itself. */
export function onSubscribeFailed(app: App, sourceId: string, message: string): void {
  const s = app.db.get<{ account_id: string }>("SELECT account_id FROM sources WHERE id = ?", sourceId);
  app.db.run("UPDATE sources SET health = 'error', health_text = ? WHERE id = ?", message, sourceId);
  if (s) emit(app, s.account_id, { type: "source", sourceId });
}

/**
 * Try again to follow a source whose subscription failed (or is waiting for its next automatic try).
 * Nothing else can be retried from here: a source that is working has nothing to retry.
 */
export function retrySource(app: App, p: Principal, id: string): SourceDTO {
  const s = app.db.get<{ title: string; feed_url: string | null; is_private: number; health: string; engine_stream_id: string | null }>(
    "SELECT title, feed_url, is_private, health, engine_stream_id FROM sources WHERE id = ? AND workspace_id = ? AND followed = 1 AND kind <> 'manual'", id, p.workspaceId);
  if (!s) throw notFound("That source");
  if (s.engine_stream_id || s.health !== "error") throw badRequest("This source is working, so there is nothing to retry.", "not_failed");
  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (!engineUser) throw badRequest("Your PURSS isn't connected to the collection engine yet. Try again in a minute.", "engine_pending");
  const feedUrl = s.is_private ? `secret:source-urls/${id}` : s.feed_url;
  if (!feedUrl) throw badRequest("This source's link is missing. Remove it and add it again.", "link_missing");
  app.db.tx(() => {
    app.db.run("UPDATE sources SET health = 'pending', health_text = 'Collecting the first items…' WHERE id = ?", id);
    // The same key re-arms the finished job; one still waiting for its next try is brought forward.
    const jobId = enqueue(app, "engine.subscribe", { engineUserId: engineUser.id, sourceId: id, feedUrl, title: s.title }, { accountId: p.accountId, workspaceId: p.workspaceId, idempotencyKey: `subscribe:${id}` });
    app.db.run("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after > ?", nowIso(), nowIso(), jobId, nowIso());
  });
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

export function patchSource(app: App, p: Principal, id: string, patch: z.infer<typeof sourcePatchSchema>): SourceDTO {
  const s = app.db.get<{ engine_stream_id: string | null; title: string; kind: string; is_private: number; full_text: number; builtin: string | null }>(
    "SELECT engine_stream_id, title, kind, is_private, full_text, builtin FROM sources WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!s) throw notFound("That source");
  if (patch.fullText && !fullTextAvailable(s)) throw badRequest("Full articles can't be fetched for this kind of source.", "full_text_unavailable");
  app.db.tx(() => {
    if (patch.title && patch.title !== s.title) {
      app.db.run("UPDATE sources SET title = ?, hue = ? WHERE id = ?", patch.title, hueFor(patch.title), id);
      const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
      if (eu && s.engine_stream_id) enqueue(app, "engine.rename", { engineUserId: eu.id, streamId: s.engine_stream_id, title: patch.title }, { accountId: p.accountId, workspaceId: p.workspaceId });
    }
    // Paused for a week or a month resumes by itself (see the returning pass); "until resumed" waits for the person.
    const pauseFor = patch.pauseFor ?? (patch.paused ? "until-resumed" : undefined);
    if (pauseFor) app.db.run("UPDATE sources SET paused = 1, paused_until = ? WHERE id = ?", pauseFor === "until-resumed" ? null : addSeconds((pauseFor === "week" ? 7 : 30) * 86400), id);
    else if (patch.paused === false) app.db.run("UPDATE sources SET paused = 0, paused_until = NULL WHERE id = ?", id);
    if (patch.notify) app.db.run("UPDATE sources SET notify = ? WHERE id = ?", patch.notify, id);
    if (patch.fullText !== undefined && (patch.fullText ? 1 : 0) !== s.full_text) {
      app.db.run("UPDATE sources SET full_text = ? WHERE id = ?", patch.fullText ? 1 : 0, id);
      if (patch.fullText) backfillFullText(app, p, id);
    }
    if (patch.collectionIds) {
      patch.collectionIds = [...new Set(patch.collectionIds)];
      for (const cid of patch.collectionIds) {
        if (!app.db.get("SELECT 1 FROM collections WHERE id = ? AND workspace_id = ? AND mode = 'sources'", cid, p.workspaceId)) throw notFound("That collection");
      }
      app.db.run("DELETE FROM collection_sources WHERE source_id = ?", id);
      for (const cid of patch.collectionIds) app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", cid, id);
    }
  });
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

/**
 * Turning full articles on also fetches copies for the source's newest items that are still to
 * be read (not Finished or Ignored), up to FULL_TEXT_BACKFILL; later items get one as they arrive.
 */
function backfillFullText(app: App, p: Principal, sourceId: string): void {
  const items = app.db.all<{ id: string; url: string }>(
    `SELECT i.id, i.url FROM items i JOIN item_state st ON st.item_id = i.id
     WHERE i.source_id = ? AND i.workspace_id = ? AND i.url IS NOT NULL AND st.workflow NOT IN ('finished', 'ignored')
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status IN ('pending', 'done'))
     ORDER BY COALESCE(i.published_at, i.discovered_at) DESC LIMIT ?`, sourceId, p.workspaceId, FULL_TEXT_BACKFILL);
  for (const it of items) queueAutoCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: it.id, url: it.url });
}

/**
 * Unfollow stops collection; kept items, attribution and snapshots stay. Unkept items from the
 * source drop out of lists and search (except those with highlights or notes, items.ts VISIBLE_SOURCE);
 * with `deleteUnkept` they are deleted permanently instead (never kept or published ones, nor ones
 * carrying the person's own highlights or notes).
 */
export function unfollowSource(app: App, p: Principal, id: string, opts: { deleteUnkept?: boolean } = {}): { keptItems: number; deletedItems: number } {
  const s = app.db.get<{ engine_stream_id: string | null }>("SELECT engine_stream_id FROM sources WHERE id = ? AND workspace_id = ? AND followed = 1", id, p.workspaceId);
  if (!s) throw notFound("That source");
  const kept = app.db.get<{ n: number }>("SELECT COUNT(DISTINCT b.item_id) AS n FROM basket_items b JOIN items i ON i.id = b.item_id WHERE i.source_id = ?", id)!.n;
  let deletedItems = 0;
  app.db.tx(() => {
    if (opts.deleteUnkept) {
      const unkept = app.db.all<{ id: string }>(
        `SELECT i.id FROM items i WHERE i.source_id = ? AND i.workspace_id = ?
           AND NOT EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM share_notes sn WHERE sn.item_id = i.id)
           AND NOT ${HAS_ANNOTATIONS}`, id, p.workspaceId);
      for (const it of unkept) if (deleteItemNow(app, p, it.id) !== null) deletedItems++;
    }
    app.db.run("UPDATE sources SET followed = 0, engine_stream_id = NULL WHERE id = ?", id);
    deleteSourceNotifications(app, id);
    app.db.run("DELETE FROM collection_sources WHERE source_id = ?", id);
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
    if (eu && s.engine_stream_id) enqueue(app, "engine.unsubscribe", { engineUserId: eu.id, streamId: s.engine_stream_id }, { accountId: p.accountId, workspaceId: p.workspaceId });
  });
  removeSecret(app.config.secretsDir, `source-urls/${id}`);
  emit(app, p.accountId, { type: "source", sourceId: id });
  if (deletedItems) emit(app, p.accountId, { type: "storage" });
  return { keptItems: kept, deletedItems };
}


/**
 * Private sources made before keys existed get theirs from their link file, once. A source whose link isn't here (one that came
 * back from an export and waits to be reconnected) has no key until it is reconnected.
 */
export function backfillFeedKeys(app: App): void {
  for (const s of app.db.all<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM sources WHERE is_private = 1 AND feed_key IS NULL AND followed = 1 AND health <> 'reconnect'")) {
    const link = readSecret(app.config.secretsDir, `source-urls/${s.id}`);
    const key = link ? privateFeedKey(app, s.workspace_id, link) : null;
    if (key) app.db.run("UPDATE sources SET feed_key = ? WHERE id = ? AND feed_key IS NULL", key, s.id);
  }
}

/** How long a followed source may wait for its first items before the engine is asked once what its feed holds. */
export const EMPTY_CHECK_AFTER_SECONDS = 600;

/**
 * A source that was followed before the engine's word on empty feeds existed, or whose answer was lost, would say "Collecting the
 * first items…" for ever. Once, a while after it was followed, the subscription job is run again: the engine answers that the feed
 * is already subscribed, and the answer carries what the feed holds (see engine.subscribe). The job's key remembers that it was asked.
 */
export function checkEmptyFeeds(app: App): void {
  const rows = app.db.all<{ id: string; title: string; feed_url: string | null; is_private: number; account_id: string; workspace_id: string; eu: string }>(
    `SELECT s.id, s.title, s.feed_url, s.is_private, s.account_id, s.workspace_id, eu.id AS eu
     FROM sources s JOIN engine_users eu ON eu.account_id = s.account_id AND eu.status = 'ready'
     WHERE s.followed = 1 AND s.kind <> 'manual' AND s.health = 'pending' AND s.engine_stream_id IS NOT NULL AND s.subscribed_at <= ?
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.source_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'empty-check:' || s.id)
     LIMIT 50`, new Date(Date.now() - EMPTY_CHECK_AFTER_SECONDS * 1000).toISOString());
  for (const s of rows) {
    const feedUrl = s.is_private ? `secret:source-urls/${s.id}` : s.feed_url;
    if (!feedUrl) continue;
    try {
      enqueue(app, "engine.subscribe", { engineUserId: s.eu, sourceId: s.id, feedUrl, title: s.title }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `empty-check:${s.id}` });
    } catch (err) {
      // An account that is suspended or being deleted starts nothing; it is looked at again when it is usable.
      if (!(err instanceof HttpError)) throw err;
    }
  }
}
