import { FULL_TEXT_BACKFILL, newId } from "@purss/domain";
import type { DiscoveryResult, PodcastSearchResponse, SiteSearchHit, SiteSearchResponse, SourceDTO, SourceHealth } from "@purss/domain";
import { coreName, discover, searchPodcasts, searchSites } from "@purss/connectors";
import type { DiscoveryDraft } from "@purss/connectors";
import type { PodcastSearchOptions, SiteSearchOptions } from "@purss/connectors";
import type { z } from "zod";
import type { followSchema, sourcePatchSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { bridgeOptions } from "./bridge.ts";
import { recordDiscoveryMiss } from "./discovery-misses.ts";
import { sourcesNamed } from "./discover.ts";
import { emit } from "../app.ts";
import { HttpError, addSeconds, badRequest, notFound, nowIso } from "../http.ts";
import { enqueue } from "./jobs.ts";
import { hueFor, initialsFor } from "./content.ts";
import { iconUrl } from "./icons.ts";
import { createCollection, deleteItemNow } from "./collections.ts";
import { readSecret, removeSecret, writeSecret } from "../secrets.ts";
import { canonicalFeedKey, otherScheme, privateFeedKey } from "./feed-keys.ts";
import { linkKey, urlKey } from "./url-key.ts";
import { dropCandidate, holdCandidate, peekCandidate } from "./discovery-cache.ts";
import { failCapture, fullTextAvailable, queueAutoCapture } from "./captures.ts";
import { HAS_ANNOTATIONS } from "./annotations.ts";
import { itemCounts } from "./counts.ts";
import { deleteSourceNotifications } from "./notifications.ts";
import { assertRoom } from "./plans.ts";
import { deliverNews } from "./news.ts";
import { isNewsFeed, newsCandidate } from "./news-address.ts";
import { server } from "@purss/copy/server";

const QUIET_DAYS = 30;
/** What a followed feed says while it has no posts at all. */
export const NO_POSTS_YET = server.api.sources.noPostsYet;

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
  if (r.health === "reconnect") return { health: "reconnect", text: r.health_text ?? server.api.sources.reconnectRequired };
  if (r.paused) {
    const until = r.paused_until ? new Date(r.paused_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
    return { health: "paused", text: until ? server.api.sources.pausedUntilNote(until) : server.api.sources.pausedNote };
  }
  // A source waiting for its first items, or one whose feed had nothing in it yet (see applySyncBatch), stores no text: its state says it.
  if (r.health === "pending") return { health: "pending", text: server.api.shared.gettingFirstItems };
  if (r.health !== "ok" && r.health !== "quiet") return { health: r.health, text: r.health_text };
  if (r.health === "quiet" && !r.last_item_at) return { health: "quiet", text: NO_POSTS_YET };
  const last = r.last_item_at ?? r.last_success_at;
  if (last) {
    const days = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
    if (days >= QUIET_DAYS) return { health: "quiet", text: server.api.sources.noNewPosts(days) };
  }
  return { health: "ok", text: null };
}

/** The new items on the app's icon: what the sidebar shows as new, summed over the followed sources. */
export function newItemCount(app: App, workspaceId: string): number {
  const ids = app.db.all<{ id: string }>("SELECT id FROM sources WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual'", workspaceId);
  const counts = itemCounts(app, workspaceId);
  return ids.reduce((n, r) => n + counts.fresh(r.id), 0);
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
    fullText: r.full_text === 1 && fullTextAvailable(r), fullTextAvailable: fullTextAvailable(r),
    privacyChangeable: !r.builtin && r.health !== "reconnect" && (r.is_private === 1 || (!!r.feed_url && !r.feed_url.startsWith("bridge:"))), aiFiltered: r.ai_filtered === 1,
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
  if (!r) throw notFound(server.api.shared.thatSource);
  return toSourceDTO(r);
}

/** Discovery runs the safe fetcher; candidates are held server-side behind opaque tokens. */
export async function discoverSources(app: App, p: Principal, url: string): Promise<DiscoveryResult> {
  const news = newsCandidate(app, url);
  if (news) return { ok: true, url, candidates: presentCandidates(app, p, [news]) };
  const result = await discover(url, bridgeOptions(app));
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

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/**
 * Wikidata's answers by query, kept an hour, so the same name asked again (by anyone) costs Wikidata nothing; and while Wikidata is
 * limiting requests, the time it asked us to wait, during which it isn't asked. Its limit counts the whole installation's address.
 */
const SITE_SEARCH_TTL_MS = 60 * 60 * 1000;
const SITE_SEARCH_ENTRIES = 1000;
const siteSearches = new Map<string, { at: number; found: Extract<Awaited<ReturnType<typeof searchSites>>, { ok: true }> }>();
let siteSearchQuietUntil = 0;
let siteSearchQuietAnswer: Extract<Awaited<ReturnType<typeof searchSites>>, { ok: false }> | null = null;
/** Searches still waiting for Wikidata by query: the same name asked meanwhile shares the one request. */
const siteSearchesAsked = new Map<string, Promise<Awaited<ReturnType<typeof searchSites>>>>();

async function cachedSiteSearch(query: string, opts?: SiteSearchOptions, now = Date.now()): Promise<Awaited<ReturnType<typeof searchSites>>> {
  const key = query.replace(/\s+/g, " ").trim().toLowerCase();
  const kept = siteSearches.get(key);
  if (kept && now - kept.at < SITE_SEARCH_TTL_MS) return kept.found;
  // A request already on its way for this name is awaited even when another name has since been told to wait.
  const asked = siteSearchesAsked.get(key);
  if (asked) return asked;
  if (now < siteSearchQuietUntil && siteSearchQuietAnswer) return siteSearchQuietAnswer;
  const request = searchSites(query, opts);
  siteSearchesAsked.set(key, request);
  let found: Awaited<typeof request>;
  try {
    found = await request;
  } finally {
    siteSearchesAsked.delete(key);
  }
  if (found.ok) {
    if (siteSearches.size >= SITE_SEARCH_ENTRIES) siteSearches.delete(siteSearches.keys().next().value!);
    siteSearches.set(key, { at: now, found });
  } else if (found.retryAfterMs) {
    // Counted from the answer, and a shorter wait never cuts a longer one short.
    siteSearchQuietUntil = Math.max(siteSearchQuietUntil, Date.now() + found.retryAfterMs);
    siteSearchQuietAnswer = found;
  }
  return found;
}

/** TEST ONLY: forget kept answers and any wait. */
export function resetSiteSearchCache(): void {
  siteSearches.clear();
  siteSearchesAsked.clear();
  siteSearchQuietUntil = 0;
  siteSearchQuietAnswer = null;
}

/**
 * Websites named like `query`: the public sources other readers here follow (sourcesNamed: hosted, sharing readers only, never a private
 * source), then the official websites Wikidata records for things of that name, leaving out a site already listed. Nothing is stored; the
 * person picks one and it is looked up like a pasted address. Wikidata failing still shows the readers' sources when there are any.
 */
export async function searchSiteDirectory(app: App, p: Principal, query: string, opts?: SiteSearchOptions): Promise<SiteSearchResponse> {
  const readers: SiteSearchHit[] = sourcesNamed(app, p, query).map((s) => ({ name: s.title, description: null, address: s.feedUrl, site: s.host ?? hostOf(s.feedUrl), from: "readers" }));
  const found = await cachedSiteSearch(query, opts);
  if (!found.ok) return readers.length ? { ok: true, query, hits: readers } : { ok: false, reason: found.reason, message: found.message };
  const listed = new Set(readers.map((h) => h.site));
  const wikidata: SiteSearchHit[] = found.hits.filter((h) => !listed.has(hostOf(h.siteUrl))).map((h) => ({ name: h.name, description: h.description, address: h.siteUrl, site: hostOf(h.siteUrl), from: "wikidata" }));
  return { ok: true, query, hits: [...readers, ...wikidata] };
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

/**
 * The followed source of this PURSS for a feed address: by the address written the same way up to what never changes which feed a
 * server sends (http or https, a trailing slash, tracking parameters; urlKey), or for a private source by its keyed hash of either scheme.
 */
export function followedSource(app: App, p: Principal, feedUrl: string): { id: string } | undefined {
  const other = otherScheme(feedUrl);
  const keys = [privateFeedKey(app, p.workspaceId, feedUrl), other ? privateFeedKey(app, p.workspaceId, other) : null].filter((k): k is string => !!k);
  return app.db.get<{ id: string }>(
    `SELECT id FROM sources WHERE workspace_id = ? AND followed = 1 AND (feed_url = ? OR (feed_url IS NOT NULL AND purss_url_key(feed_url) = ?)
       ${keys.length ? `OR feed_key IN (${keys.map(() => "?").join(", ")})` : ""}) ORDER BY created_at LIMIT 1`,
    p.workspaceId, feedUrl, urlKey(feedUrl), ...keys);
}

/**
 * A followed source (under another address) whose newest posts are this feed's newest: most of the feed's newest posts are among the
 * source's, and most of the source's as many newest are among the feed's. A section's feed inside a site's whole feed, or a feed that
 * shares a few posts with another, is not the same feed. Compared by post address (linkKey: no www, scheme or tracking parameters).
 */
function sameFeedSource(app: App, p: Principal, itemLinks: readonly string[] | undefined): { id: string; title: string } | undefined {
  const keys = [...new Set((itemLinks ?? []).map(linkKey).filter((k): k is string => !!k))];
  if (keys.length < SAME_FEED_MIN) return undefined;
  const need = Math.max(SAME_FEED_MIN, Math.ceil(keys.length * SAME_FEED_SHARE));
  const marks = keys.map(() => "?").join(", ");
  const sharing = app.db.all<{ id: string; title: string }>(
    `SELECT s.id, s.title FROM sources s JOIN items i ON i.workspace_id = s.workspace_id AND i.source_id = s.id
     WHERE s.workspace_id = ? AND s.followed = 1 AND s.kind <> 'manual' AND i.link_key IN (${marks})
     GROUP BY s.id HAVING COUNT(DISTINCT i.link_key) >= ? ORDER BY COUNT(DISTINCT i.link_key) DESC, s.created_at`, p.workspaceId, ...keys, need);
  const asked = new Set(keys);
  // Each source sharing enough posts in turn: the first whose newest posts (with or without an address) are mostly the feed's.
  for (const s of sharing) {
    const newest = app.db.all<{ link_key: string | null }>(
      "SELECT link_key FROM items WHERE workspace_id = ? AND source_id = ? ORDER BY discovered_at DESC, id DESC LIMIT ?", p.workspaceId, s.id, keys.length);
    if (newest.filter((r) => r.link_key !== null && asked.has(r.link_key)).length >= need) return { id: s.id, title: s.title };
  }
  return undefined;
}
/** At least this many posts in common, and this share of the newest on both sides. */
const SAME_FEED_MIN = 3;
const SAME_FEED_SHARE = 0.7;

/** A found feed behind an opaque token, with whether this PURSS already follows it, or follows a source of the same name. */
function holdDraft(app: App, p: Principal, c: Parameters<typeof holdCandidate>[2], byName: Map<string, { id: string; title: string }>) {
  const token = newId("dsc");
  const existing = followedSource(app, p, c.feedUrl);
  holdCandidate(token, p.workspaceId, c);
  const sameFeed = existing ? undefined : sameFeedSource(app, p, c.itemLinks);
  const same = existing || sameFeed ? undefined : byName.get(coreName(c.title));
  // How the engine will follow it, and the posts it was compared by, are not the person's business.
  const { large: _held, itemLinks: _links, ...shown } = c;
  return { ...shown, token, alreadyFollowingSourceId: existing?.id ?? null, sameFeedSource: sameFeed ?? null, sameNameSource: same ?? null };
}

type Candidate = Omit<DiscoveryResult & { ok: true }, "ok" | "url">["candidates"][number] & { large?: boolean };

/** For private sources keep only the site's origin: a feed's site link can carry the same secret. */
function siteOrigin(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function followSource(app: App, p: Principal, input: z.input<typeof followSchema>): SourceDTO {
  const c = peekCandidate(input.token, p.workspaceId) as Candidate | null;
  if (!c) throw badRequest(server.api.shared.lookupExpired, "expired");
  const existing = followedSource(app, p, c.feedUrl);
  if (existing) return getSource(app, p, existing.id);
  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (!engineUser) throw badRequest(server.api.shared.notConnectedYet, "engine_pending");
  // This installation's news comes from here, not from the engine (services/news.ts).
  const isNews = isNewsFeed(app, c.feedUrl);
  // A bridged source's address is a descriptor, not a link anyone holds, so it is never a private link.
  const isPrivate = !isNews && !c.feedUrl.startsWith("bridge:") && (input.markPrivate ?? !!c.privateWarning);
  // An unfollowed source keeps its items. Following the same feed again takes that source up again; a second one
  // would hold a second copy of everything, and the first copy could no longer be reached or cleaned up.
  const former = isPrivate ? undefined : app.db.get<{ id: string; title: string }>(
    `SELECT id, title FROM sources WHERE workspace_id = ? AND feed_url = ? AND followed = 0 AND kind <> 'manual' ${isNews ? "AND builtin = 'news'" : ""} ORDER BY created_at DESC LIMIT 1`, p.workspaceId, c.feedUrl);
  const id = former?.id ?? newId("src");
  const title = input.title ?? former?.title ?? c.title;
  const fullText = input.fullText && fullTextAvailable({ kind: c.kind, is_private: isPrivate ? 1 : 0 });
  // What the feed already has is back catalogue: it arrives Ignored, or with its last week as New (see sync.ts arrivalOf).
  const startFrom = input.startFrom ?? "now";
  // A feed the preview found bigger than the engine can read whole is followed through the feed gateway, which gives the engine a copy
  // of its newest items. The source keeps its own address; only what the engine is subscribed to differs.
  const viaGateway = !isNews && c.large === true;
  try {
    app.db.tx(() => {
      assertRoom(app, p.accountId, "sources");
      let collectionId = input.collectionId;
      if (!collectionId && input.newCollectionName) collectionId = createCollection(app, p, { name: input.newCollectionName, emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" }).id;
      if (collectionId && !app.db.get("SELECT 1 FROM collections WHERE id = ? AND workspace_id = ? AND mode = 'sources'", collectionId, p.workspaceId)) throw notFound(server.api.shared.thatCollection);
      if (former) {
        // Followed again: what the feed already has is back catalogue again, not New, and the engine has yet to confirm this new subscription.
        // (The posts stored the first time keep what they were; only what arrives now is the back catalogue of this follow.)
        app.db.run(
          `UPDATE sources SET followed = 1, kind = ?, title = ?, origin = ?, site_url = ?, hue = ?, full_text = ?, start_from = ?, paused = 0, engine_stream_id = NULL,
             health = ?, health_text = ?, created_at = ?, backlog_settled_at = NULL, subscribed_at = NULL, via_gateway = ? WHERE id = ?`,
          c.kind, title, c.origin, c.siteUrl, hueFor(title), fullText ? 1 : 0, startFrom, isNews ? "ok" : "pending", null, nowIso(), viaGateway ? 1 : 0, id,
        );
      } else {
        // Private (secret-link) feed URLs never enter the database or job payloads; they go to the secrets directory.
        app.db.run(
          `INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, site_url, feed_url, feed_key, is_private, hue, full_text, start_from, health, health_text, builtin, created_at, via_gateway)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, p.accountId, p.workspaceId, isPrivate ? "private" : c.kind, title, c.origin, isPrivate ? siteOrigin(c.siteUrl) : c.siteUrl, isPrivate ? null : c.feedUrl, isPrivate ? privateFeedKey(app, p.workspaceId, c.feedUrl) : null, isPrivate ? 1 : 0, hueFor(title), fullText ? 1 : 0, startFrom,
          isNews ? "ok" : "pending", null, isNews ? "news" : null, nowIso(), viaGateway ? 1 : 0,
        );
        if (isPrivate) writeSecret(app.config.secretsDir, `source-urls/${id}`, c.feedUrl);
      }
      if (collectionId) app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", collectionId, id);
      if (!isNews) enqueue(app, "engine.subscribe", { engineUserId: engineUser.id, sourceId: id, feedUrl: isPrivate ? `secret:source-urls/${id}` : c.feedUrl, title, ...(viaGateway ? { trim: true } : {}) }, { accountId: p.accountId, workspaceId: p.workspaceId, idempotencyKey: `subscribe:${id}` });
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
 * now instead of "Getting the first items…" for ever; its first post (see applySyncBatch) makes it an ordinary source.
 * Without that word, nothing is claimed. `viaGateway`: the engine's subscription is the feed gateway's copy of a feed too big for
 * the engine to read whole (the worker moved it there when the engine failed on it, or the follow had chosen it): the source
 * is marked, so a later subscription of it (a retry, a check of an empty feed) uses the gateway from the start.
 */
export function onSubscribed(app: App, sourceId: string, streamId: string, evidence: { empty?: boolean; viaGateway?: boolean } = {}): void {
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
       health_text = CASE WHEN health = 'error' THEN NULL ELSE health_text END, via_gateway = CASE WHEN ? THEN 1 ELSE via_gateway END WHERE id = ?`,
    streamId, nowIso(), evidence.viaGateway === true ? 1 : 0, sourceId);
  if (evidence.empty === true) {
    app.db.run("UPDATE sources SET health = 'quiet', health_text = NULL WHERE id = ? AND health = 'pending' AND NOT EXISTS (SELECT 1 FROM items WHERE items.source_id = sources.id)", sourceId);
  }
  if (eu) enqueue(app, "engine.sync", { engineUserId: eu.id }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `sync:${eu.id}`, runAfter: addSeconds(5) });
  emit(app, s.account_id, { type: "source", sourceId });
}

/** The engine couldn't follow the feed: the source says why, whether or not it will be asked again by itself. */
/** `reason`: why it failed, as the job reported it; the retry through the feed gateway is chosen by it (failures.ts), never by the words. */
export function onSubscribeFailed(app: App, sourceId: string, message: string, reason: string | null = null): void {
  const s = app.db.get<{ account_id: string }>("SELECT account_id FROM sources WHERE id = ?", sourceId);
  app.db.run("UPDATE sources SET health = 'error', health_text = ?, health_reason = ? WHERE id = ?", message, reason, sourceId);
  if (s) emit(app, s.account_id, { type: "source", sourceId });
}

/**
 * Try again to follow a source whose subscription failed (or is waiting for its next automatic try).
 * Nothing else can be retried from here: a source that is working has nothing to retry.
 */
export function retrySource(app: App, p: Principal, id: string): SourceDTO {
  const s = app.db.get<{ title: string; feed_url: string | null; is_private: number; health: string; engine_stream_id: string | null; via_gateway: number }>(
    "SELECT title, feed_url, is_private, health, engine_stream_id, via_gateway FROM sources WHERE id = ? AND workspace_id = ? AND followed = 1 AND kind <> 'manual'", id, p.workspaceId);
  if (!s) throw notFound(server.api.shared.thatSource);
  if (s.engine_stream_id || s.health !== "error") throw badRequest(server.api.sources.workingNoRetry, "not_failed");
  const engineUser = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", p.accountId);
  if (!engineUser) throw badRequest(server.api.shared.notConnectedYet, "engine_pending");
  const feedUrl = s.is_private ? `secret:source-urls/${id}` : s.feed_url;
  if (!feedUrl) throw badRequest(server.api.sources.linkMissing, "link_missing");
  app.db.tx(() => {
    app.db.run("UPDATE sources SET health = 'pending', health_text = NULL WHERE id = ?", id);
    // The same key re-arms the finished job; one still waiting for its next try is brought forward.
    const jobId = enqueue(app, "engine.subscribe", { engineUserId: engineUser.id, sourceId: id, feedUrl, title: s.title, ...(s.via_gateway ? { trim: true } : {}) }, { accountId: p.accountId, workspaceId: p.workspaceId, idempotencyKey: `subscribe:${id}` });
    app.db.run("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after > ?", nowIso(), nowIso(), jobId, nowIso());
  });
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

export function patchSource(app: App, p: Principal, id: string, patch: z.infer<typeof sourcePatchSchema>): SourceDTO {
  const s = app.db.get<{ engine_stream_id: string | null; title: string; kind: string; is_private: number; full_text: number; builtin: string | null }>(
    "SELECT engine_stream_id, title, kind, is_private, full_text, builtin FROM sources WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!s) throw notFound(server.api.shared.thatSource);
  if (patch.fullText && !fullTextAvailable(s)) throw badRequest(server.api.sources.fullArticlesUnavailable, "full_text_unavailable");
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
        if (!app.db.get("SELECT 1 FROM collections WHERE id = ? AND workspace_id = ? AND mode = 'sources'", cid, p.workspaceId)) throw notFound(server.api.shared.thatCollection);
      }
      app.db.run("DELETE FROM collection_sources WHERE source_id = ?", id);
      for (const cid of patch.collectionIds) app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", cid, id);
    }
  });
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

/** Subscriptions of a source still waiting to run (or to be tried again) use its link as it is now stored. */
function pointSubscribeJobs(app: App, sourceId: string, feedUrl: string): void {
  app.db.run("UPDATE jobs SET payload = json_set(payload, '$.feedUrl', ?), updated_at = ? WHERE kind = 'engine.subscribe' AND status IN ('queued', 'failed', 'cancelled') AND json_extract(payload, '$.sourceId') = ?",
    feedUrl, nowIso(), sourceId);
}

/**
 * Mark a followed source's link private, or show it again. Going private locks the link away as following a private link does
 * (services/sources.ts followSource): the link moves to the secrets folder, only a keyed fingerprint and the site's origin stay, and
 * full articles stop. Going public is the owner saying the link is an ordinary public feed: the link is looked up again, because a
 * private source keeps neither its kind nor its site's full address, and it is shown, exported and listed like any other from then on.
 * Shared pages and exports made while the link was public are not taken back.
 */
export async function setSourcePrivacy(app: App, p: Principal, id: string, makePrivate: boolean,
  find: (url: string) => Promise<DiscoveryDraft> = (url) => discover(url, bridgeOptions(app))): Promise<SourceDTO> {
  const s = app.db.get<{ kind: string; feed_url: string | null; site_url: string | null; is_private: number; health: string; builtin: string | null }>(
    "SELECT kind, feed_url, site_url, is_private, health, builtin FROM sources WHERE id = ? AND workspace_id = ? AND followed = 1 AND kind <> 'manual'", id, p.workspaceId);
  if (!s) throw notFound(server.api.shared.thatSource);
  if (!!s.is_private === makePrivate) return getSource(app, p, id);
  const file = `source-urls/${id}`;
  if (makePrivate) {
    if (s.builtin || !s.feed_url || s.feed_url.startsWith("bridge:")) throw badRequest(server.api.sources.noOwnLink, "no_link");
    const link = s.feed_url;
    writeSecret(app.config.secretsDir, file, link);
    try {
      app.db.tx(() => {
        app.db.run("UPDATE sources SET kind = 'private', is_private = 1, feed_url = NULL, feed_key = ?, site_url = ?, full_text = 0 WHERE id = ?",
          privateFeedKey(app, p.workspaceId, link), siteOrigin(s.site_url), id);
        pointSubscribeJobs(app, id, `secret:${file}`);
        // Pages and pictures of its items are no longer fetched: those still on their way are dropped (finished ones stay).
        for (const c of app.db.all<{ id: string }>("SELECT c.id FROM captures c JOIN items i ON i.id = c.item_id WHERE i.source_id = ? AND c.kind = 'fulltext' AND c.status = 'pending'", id)) {
          failCapture(app, c.id, server.api.shared.privateNoCopies);
          app.db.run("UPDATE jobs SET status = 'cancelled', lease_id = NULL, updated_at = ? WHERE kind = 'capture.fulltext' AND status IN ('queued', 'leased') AND json_extract(payload, '$.captureId') = ?", nowIso(), c.id);
        }
        // A worker holding one loses its lease: its result is refused, and the job doesn't come back after a crash.
        app.db.run(`UPDATE jobs SET status = 'cancelled', lease_id = NULL, updated_at = ? WHERE kind = 'capture.images' AND status IN ('queued', 'leased')
          AND json_extract(payload, '$.itemId') IN (SELECT id FROM items WHERE source_id = ?)`, nowIso(), id);
        // Item titles already shown in its notifications are not shown again.
        app.db.run("UPDATE notifications SET body = NULL WHERE source_id = ? AND kind = 'arrivals'", id);
        // The address no longer counts in the Discover graph: it is rebuilt within a minute, so suggestions and name search drop it if
        // that leaves too few readers.
        app.db.run("UPDATE discovery_state SET dirty = 1");
      });
    } catch (err) {
      removeSecret(app.config.secretsDir, file);
      throw err;
    }
  } else {
    const link = readSecret(app.config.secretsDir, file);
    if (!link || s.health === "reconnect") throw badRequest(server.api.sources.needsLinkAgain, "reconnect");
    // A worker holding a subscription reads the link from its file; it goes only once nothing in flight still needs it.
    if (app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe' AND status = 'leased' AND json_extract(payload, '$.sourceId') = ?", id)) {
      throw badRequest(server.api.sources.stillSettingUp, "busy");
    }
    const result = await find(link).catch(() => null);
    const key = canonicalFeedKey(link);
    const same = result?.ok ? result.candidates.find((c) => { try { return canonicalFeedKey(c.feedUrl) === key; } catch { return false; } }) : undefined;
    if (!same) throw badRequest(server.api.sources.feedUnreachable, "unreachable");
    // The source may have been changed or unfollowed while the feed was looked up.
    const changed = app.db.tx(() => {
      const n = app.db.run("UPDATE sources SET kind = ?, origin = ?, is_private = 0, feed_url = ?, feed_key = NULL, site_url = ? WHERE id = ? AND is_private = 1 AND followed = 1",
        same.kind, same.origin, link, same.siteUrl, id).changes;
      if (n) pointSubscribeJobs(app, id, link);
      return n;
    });
    if (changed && !app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe' AND status = 'leased' AND json_extract(payload, '$.sourceId') = ?", id)) {
      removeSecret(app.config.secretsDir, file);
    }
  }
  emit(app, p.accountId, { type: "source", sourceId: id });
  return getSource(app, p, id);
}

/**
 * Turning full articles on also fetches copies for the source's newest items that are still to
 * be read (not Finished or Ignored), up to FULL_TEXT_BACKFILL; later items get one as they arrive. The back catalogue of a source
 * followed from now is Ignored, so it is left out of this: no copies are made of posts the person chose not to start with.
 */
function backfillFullText(app: App, p: Principal, sourceId: string): void {
  const items = app.db.all<{ id: string; url: string }>(
    `SELECT i.id, i.url FROM items i JOIN item_state st ON st.item_id = i.id
     WHERE i.source_id = ? AND i.workspace_id = ? AND i.url IS NOT NULL AND st.workflow NOT IN ('finished', 'ignored')
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status IN ('pending', 'done'))
     ORDER BY i.listed_at DESC LIMIT ?`, sourceId, p.workspaceId, FULL_TEXT_BACKFILL);
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
  if (!s) throw notFound(server.api.shared.thatSource);
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
  const rows = app.db.all<{ id: string; title: string; feed_url: string | null; is_private: number; via_gateway: number; account_id: string; workspace_id: string; eu: string }>(
    `SELECT s.id, s.title, s.feed_url, s.is_private, s.via_gateway, s.account_id, s.workspace_id, eu.id AS eu
     FROM sources s JOIN engine_users eu ON eu.account_id = s.account_id AND eu.status = 'ready'
     WHERE s.followed = 1 AND s.kind <> 'manual' AND s.health = 'pending' AND s.engine_stream_id IS NOT NULL AND s.subscribed_at <= ?
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.source_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'empty-check:' || s.id)
     LIMIT 50`, new Date(Date.now() - EMPTY_CHECK_AFTER_SECONDS * 1000).toISOString());
  for (const s of rows) {
    const feedUrl = s.is_private ? `secret:source-urls/${s.id}` : s.feed_url;
    if (!feedUrl) continue;
    try {
      enqueue(app, "engine.subscribe", { engineUserId: s.eu, sourceId: s.id, feedUrl, title: s.title, ...(s.via_gateway ? { trim: true } : {}) }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `empty-check:${s.id}` });
    } catch (err) {
      // An account that is suspended or being deleted starts nothing; it is looked at again when it is usable.
      if (!(err instanceof HttpError)) throw err;
    }
  }
}
