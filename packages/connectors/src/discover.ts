import { server } from "@purss/copy/server";
import type { DiscoveryCandidate, DiscoveryResult, DiscoveryRoute, KeepOffer } from "@purss/domain";
import { EPISODES, POSTS, VIDEOS, cadenceText } from "./cadence.ts";
import type { Noun } from "./cadence.ts";
import { decodeBody, isFeedKind, sniffContent } from "./content-type.ts";
import { FeedParseError, parseFeed } from "./feed.ts";
import type { ParsedFeed } from "./feed.ts";
import { isDiscourse, isGenericTitle, isMediaWiki, isSiteWideFeed, isSubscribeEndpoint, isWikiSiteFeed, linkMatchesPage, MORE_FEED_PATHS, nameFeed, nameMatchesTitle, orderByVia, probeLandedOnName, rankByPage, sameEntries, sameName, sectionFeedName, sectionFeedPaths, sectionPath, siteNameFor, SITE_FEED_PATHS, WHOLE_SITE_FALLBACK_NOTE, WHOLE_SITE_NOTE, withoutCommentFeeds } from "./feed-choice.ts";
import { extractPageFacts, findDirectoryLinks, isDirectoryAddress } from "./html-links.ts";
import type { FoundLink } from "./html-links.ts";
import { cleanPasted, EMAIL_MESSAGE, normalizeInput, withoutCookieBounce, wwwAlternative } from "./input.ts";
import { crossrefJournalQueryUrl, crossrefWorkUrl, doiFromArticleUrl, doiFromInput, DUKE_MESSAGE, isPublisherHost, journalFeedsFor, journalFromUrl, journalTitle, normalIssn, planFromIssns, planJournal, readCrossrefJournalSearch, readCrossrefWork, resolverUrl } from "./journals.ts";
import type { CrossrefJournal, Platform } from "./journals.ts";
import { journalNameFromDoi, planKnownFeeds, resolveKnown } from "./known-feeds.ts";
import type { KnownDeps, KnownFeed, KnownPlan } from "./known-feeds.ts";
import { bridgeDescriptor, bridgeService, bridgeTargetForPage, parseBridgeDescriptor } from "./bridges.ts";
import type { BridgeService, BridgeTarget } from "./bridges.ts";
import { encodePageKey, needsCharsetRepair } from "./page-feeds.ts";
import { detectPageLists, markupDeclaresCharset } from "./page-lists.ts";
import type { PageListCandidate, PageListReason } from "./page-lists.ts";
import { crossrefJournalSearchUrl, crossrefJournalUrl, findCrossrefJournal, issnFromInput, issnPortalUrl, readCrossrefJournal } from "./crossref.ts";
import type { CrossrefJournalRecord } from "./crossref.ts";
import { noFeedPlatform } from "./platforms.ts";
import { addressVariants, readWikidataEntities, readWikidataSearch, wikidataEntitiesUrl, wikidataSearchUrl } from "./wikidata.ts";
import type { WikidataItem } from "./wikidata.ts";
import { PRIVATE_URL_WARNING, privateUrlReason, redactUrl } from "./privacy.ts";
import { safeFetch } from "./safe-fetch.ts";
import { TRIM_FEED_BYTES, TRIM_FEED_ITEMS, countFeedItems } from "./trimmed.ts";
import type { PhaseTimeouts, Resolver, SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { cleanLine, htmlToText } from "./text.ts";
import { SOCIAL_NOTE, SOCIAL_ORIGIN, blueskyTitle, classifySocialInput, looksLikeProfilePath, looksLikeSocialPostPath, platformForFeed } from "./social.ts";
import type { SocialTarget } from "./social.ts";
import {
  channelFeedUrl,
  channelIdFromResponse,
  classifyYoutubeUrl,
  isYoutubeHost,
  parseOembed,
  playlistFeedUrl,
  userFeedUrl,
  YOUTUBE_SLOW,
} from "./youtube.ts";

const feedLabels = server.sources.connectors.labels;

/*
 * Source discovery: from whatever was pasted to a short list of followable feeds, each
 * with an honest preview. Discovery fetching is separate from recurring collection
 * (FreshRSS does that); every request goes through safeFetch.
 */

/**
 * A found feed before it is held behind a token. `large`: the feed is bigger than the engine can read whole (`TRIM_FEED_BYTES` or `TRIM_FEED_ITEMS`), so
 * it is followed through the feed gateway; the person is not shown it.
 */
/**
 * `large`: the feed is too big for the engine to read whole. `itemLinks`: its newest posts' addresses, to recognise the same feed already
 * followed under another address. `route`: which way discovery found it (discovery-routes.ts), exactly one, for the administrator's record of
 * which routes are used. All three are kept with the preview on the server and never sent to the browser.
 */
export type DraftCandidate = Omit<DiscoveryCandidate, "token"> & { route: DiscoveryRoute; large?: boolean; itemLinks?: string[] };
export type DiscoveryDraft = { ok: true; url: string; candidates: DraftCandidate[]; keep?: KeepOffer } | Extract<DiscoveryResult, { ok: false }>;
type Failure = Extract<DiscoveryResult, { ok: false }>;

export type FetchFn = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

export type DiscoverOptions = {
  signal?: AbortSignal;
  /** Overall budget for one discovery. Default 30 s. */
  timeoutMs?: number;
  now?: () => Date;
  /** Replacement fetcher (tests rewrite YouTube hosts to a local server). Defaults to safeFetch. */
  fetch?: FetchFn;
  maxCandidates?: number;
  /** TEST ONLY, forwarded to safeFetch. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, forwarded to safeFetch. */
  resolver?: Resolver;
  /** TEST ONLY, forwarded to safeFetch. */
  testTlsCa?: string | Buffer;
  /** Pause between retries of YouTube's flaky feed endpoint. Default 1500 ms. */
  retryDelayMs?: number;
  /** Most requests one discovery may make (a page, its probes, a directory…). Default 40. */
  maxRequests?: number;
  /** The installation's bridge router; without it, bridged services get the "no feeds" answer. */
  bridge?: BridgeClient;
  /** Which services the router serves here (RSS-Bridge's only where RSS-Bridge runs). Default: all of them. */
  bridgeServes?: (service: BridgeService) => boolean;
};

/** Asks the bridge router for a source's feed: what the engine will see, through the internal listener only. */
export type BridgeClient = (target: BridgeTarget, signal: AbortSignal) => Promise<{ status: number; body: Uint8Array } | { failed: true }>;

const MAX_CANDIDATES = 8;
/** A pasted address is read this far before it is known to be a page or a feed; a feed read from it is cut at the same size as any other (FEED_MAX_BYTES). */
const PAGE_MAX_BYTES = TRIM_FEED_BYTES;
/** A feed is read up to this much: the size from which it goes through the feed gateway, so a preview that was cut short knows that. */
const FEED_MAX_BYTES = TRIM_FEED_BYTES;
const PROBE_PATHS = SITE_FEED_PATHS;
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5";

const MAX_REQUESTS = 40;
/** One request waits this long at most. */
const REQUEST_MS = 15_000;
/** The usual addresses are asked for with a short redirect chain: a site that needs more is not serving a feed there. */
const PROBE_REDIRECTS = 2;

type Ctx = {
  retryDelayMs: number;
  signal: AbortSignal;
  /** Milliseconds left of the overall budget. */
  remainingMs: () => number;
  /** True once this discovery has made all the requests it may. */
  spent: () => boolean;
  /** Raise the cap by `n` requests, for a step that asks someone other than the site (the registry) after the site used the cap up. */
  allow: (n: number) => void;
  now: () => Date;
  get: (url: string, opts?: { maxBytes?: number; accept?: string; timeoutMs?: number; phaseTimeoutsMs?: PhaseTimeouts; maxRedirects?: number }) => Promise<SafeFetchResult>;
  /** What was learned on the way about the journal the address belongs to, for its Crossref choice. */
  journal: JournalClue;
  /** The web page the lookup read (where it ended up, and what it said), for the lists of posts that may be found on it. Null when no page was read. */
  page: { url: string; html: string; body: Uint8Array } | null;
};

function makeCtx(opts: DiscoverOptions): Ctx {
  const fetcher: FetchFn = opts.fetch ?? safeFetch;
  const budgetMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const budget = AbortSignal.timeout(budgetMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  let maxRequests = opts.maxRequests ?? MAX_REQUESTS;
  let requests = 0;
  return {
    journal: { issns: [], names: [] },
    page: null,
    retryDelayMs: opts.retryDelayMs ?? 1500,
    signal,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - started)),
    spent: () => requests >= maxRequests,
    allow: (n) => { maxRequests = Math.max(maxRequests, requests) + n; },
    now: opts.now ?? (() => new Date()),
    get: async (url, o) => {
      // One lookup is never allowed to turn into an unbounded number of requests to someone else's site.
      if (requests >= maxRequests) return { ok: false, reason: "aborted", message: server.sources.connectors.discover.requestCap, detail: "request cap of one lookup" };
      requests++;
      const result = await fetcher(url, {
        signal,
        maxBytes: o?.maxBytes ?? PAGE_MAX_BYTES,
        // A preview needs only the start of a document (a podcast feed can be tens of MB).
        allowPartial: true,
        accept: o?.accept ?? FEED_ACCEPT,
        timeoutMs: o?.timeoutMs ?? REQUEST_MS,
        phaseTimeoutsMs: o?.phaseTimeoutsMs ?? { firstByteMs: 10_000, idleMs: 8000 },
        ...(o?.maxRedirects !== undefined ? { maxRedirects: o.maxRedirects } : {}),
        testAllowAddress: opts.testAllowAddress,
        resolver: opts.resolver,
        testTlsCa: opts.testTlsCa,
      });
      // Every redirect hop is a request to someone else's site too.
      if (result.ok) requests += result.response.redirects.length;
      // A 401 that names no way to sign in (no WWW-Authenticate) is a bot wall (DataDome answers so), not a password prompt: it is the
      // refusal a 403 is, and is handled as one.
      if (result.ok && result.response.status === 401 && !result.response.headers["www-authenticate"]) return { ok: true, response: { ...result.response, status: 403 } };
      return result;
    },
  };
}

/**
 * Whether a feed as far as it was read is too big for the engine to read whole: the read stopped at FEED_MAX_BYTES (a body cut there
 * is a feed larger than that), or what was read has more than TRIM_FEED_ITEMS items.
 */
function tooBigForEngine(r: { truncated: boolean; body: Uint8Array }): boolean {
  return r.truncated || countFeedItems(r.body) > TRIM_FEED_ITEMS;
}

function fail(url: string, reason: Failure["reason"], message: string): Failure {
  return { ok: false, url, reason, message };
}

/** Slowness is as likely to be here as there, so the message names neither as the culprit. */
export const COMMENTS_ONLY_MESSAGE = server.sources.connectors.discover.commentsOnly;
export const TIMEOUT_MESSAGE = server.sources.connectors.discover.timeout;
export const BUSY_MESSAGE = server.sources.connectors.discover.busy;
/** One lookup made all the requests it may, probing a site that never showed a feed. */
export const CAP_MESSAGE = server.sources.connectors.discover.cap;
export const MISSING_HOST_MESSAGE = server.sources.connectors.discover.missingHost;

/** safeFetch's detail for a name that does not resolve (as opposed to one that merely did not answer). */
const MISSING_HOST = /^(?:dns (?:ENOTFOUND|ENODATA|empty answer)|ENOTFOUND )/;

function failFromFetch(url: string, f: Extract<SafeFetchResult, { ok: false }>): Failure {
  switch (f.reason) {
    case "blocked":
      return fail(url, "blocked", f.message);
    case "toolarge":
      return fail(url, "toolarge", server.sources.connectors.discover.tooLarge);
    case "timeout":
    case "aborted":
      return fail(url, "timeout", TIMEOUT_MESSAGE);
    case "invalid":
      return fail(url, "invalid", f.message);
    default:
      return fail(url, "unreachable", MISSING_HOST.test(f.detail) ? MISSING_HOST_MESSAGE : f.message);
  }
}

export const YOUTUBE_REFUSED =
  server.sources.connectors.discover.youtubeRefused;

const NO_FEED_MESSAGE = server.sources.connectors.discover.noFeed;

function failFromStatus(url: string, status: number): Failure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return fail(url, "unsupported", server.sources.connectors.discover.needsLogin);
  if (status === 403) return fail(url, "unreachable", server.sources.connectors.discover.refused);
  if (status === 404 || status === 410) return fail(url, "unreachable", server.sources.connectors.discover.notFoundAt(status));
  if (status === 429) return fail(url, "unreachable", server.sources.connectors.discover.slowDown);
  if (status >= 500) return fail(url, "unreachable", server.sources.connectors.discover.siteProblems(status));
  return fail(url, "unreachable", server.sources.connectors.discover.unexpectedAnswer(status));
}

/** Fetch with an https-first attempt when the person gave no scheme or plain http. */
async function getWithUpgrade(ctx: Ctx, url: string, httpFallback: string | null, o?: { maxBytes?: number; maxRedirects?: number; accept?: string }): Promise<SafeFetchResult> {
  return withHttpFallback(ctx, await ctx.get(url, o), httpFallback, o);
}

/** What the https attempt gave, or when it could not do better, what plain http gives for the same address. */
async function withHttpFallback(ctx: Ctx, first: SafeFetchResult, httpFallback: string | null, o?: { maxBytes?: number; maxRedirects?: number; accept?: string }): Promise<SafeFetchResult> {
  if (!httpFallback) return first;
  if (first.ok && first.response.status < 400) return first;
  if (!first.ok && (first.reason === "blocked" || first.reason === "aborted" || first.reason === "toolarge")) return first;
  const second = await ctx.get(httpFallback, o);
  if (second.ok && second.response.status < 400) return second;
  return first.ok ? first : second.ok ? second : first;
}

/**
 * The address did not open because of the host: it refused us (403), is broken (5xx), failed to connect or did not answer. A page that is
 * not found (404, 410) or a site that asks for slowness (429) says something about the page or the traffic, not about the name.
 */
function hostTrouble(ctx: Ctx, result: SafeFetchResult): boolean {
  if (ctx.signal.aborted) return false;
  if (!result.ok) return result.reason === "unreachable" || result.reason === "timeout";
  return result.response.status === 403 || result.response.status >= 500;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- candidate building ----------

type Hint = { title?: string | null; url: string; section?: boolean; siteName?: string | null };

function nounFor(feed: ParsedFeed): Noun {
  if (feed.isPodcast) return EPISODES;
  if (feed.youtube) return VIDEOS;
  return POSTS;
}

function originFor(feed: ParsedFeed): string {
  if (feed.youtube?.playlistId) return feedLabels.youtubePlaylistFeed;
  if (feed.youtube) return feedLabels.youtubeChannelFeed;
  if (feed.isPodcast) return feedLabels.podcastFeed;
  switch (feed.format) {
    case "atom":
      return feedLabels.atomFeed;
    case "jsonfeed":
      return feedLabels.jsonFeed;
    default:
      return server.words.rssFeed;
  }
}

function viaFor(feed: ParsedFeed, hint: Hint): string {
  if (feed.youtube?.playlistId) return feedLabels.playlistFeed;
  if (feed.youtube) return feedLabels.channelFeed;
  if (feed.isPodcast) return feedLabels.podcastFeed;
  const label = `${hint.title ?? ""} ${feed.title ?? ""}`;
  let path = "";
  try {
    const u = new URL(hint.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    path = "";
  }
  if (/\bcomments?\b|\breplies\b|\bdiscussion\b/i.test(label) || /\/comments?(?:\/|$)|[?&]feed=comments|comments\/feed/i.test(path)) return feedLabels.commentsFeed;
  if (hint.section || /\/(?:category|categories|tag|tags|topic|topics|section|label|author|search)\//i.test(path) || /[?&](?:cat|category|tag|s|label)=/i.test(path)) return feedLabels.sectionFeed;
  return feedLabels.postsFeed;
}

function sampleTitle(feed: ParsedFeed, index: number): string {
  const item = feed.items[index]!;
  if (item.title) return item.title.length > 140 ? `${item.title.slice(0, 139)}…` : item.title;
  const text = htmlToText(item.summaryHtml ?? item.contentHtml ?? "", 400);
  if (text) return text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return server.words.untitled;
}

function newestFirst(feed: ParsedFeed): ParsedFeed {
  const dated = feed.items.some((i) => i.publishedAt);
  if (!dated) return feed;
  const sorted = feed.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (Date.parse(b.item.publishedAt ?? "") || 0) - (Date.parse(a.item.publishedAt ?? "") || 0) || a.index - b.index)
    .map((x) => x.item);
  return { ...feed, items: sorted };
}

/** Feed titles like "RSS", "Feed" or "Nieuws" say nothing about the source on their own. */
export function meaningfulTitle(title: string | null | undefined): string | null {
  const t = title?.trim();
  return t && !isGenericTitle(t) ? t : null;
}

/** Newest posts compared to recognise a feed already followed under another address. */
const SAME_FEED_ITEMS = 10;

function buildCandidate(feedUrl: string, parsed: ParsedFeed, hint: Hint, ctx: Ctx, overrides: { route: DiscoveryRoute; via?: string; origin?: string; title?: string; note?: string }): DraftCandidate {
  const feed = newestFirst(parsed);
  const noun = nounFor(feed);
  let host = "";
  try {
    host = new URL(feedUrl).hostname.replace(/^www\./, "");
  } catch {
    host = feedUrl;
  }
  return {
    route: overrides.route,
    title: overrides.title ?? nameFeed({ feedTitle: feed.title, linkTitle: cleanLine(hint.title, 200), siteName: hint.siteName, host }),
    kind: feed.youtube ? "youtube" : feed.isPodcast ? "podcast" : "feed",
    origin: overrides.origin ?? originFor(feed),
    via: overrides.via ?? viaFor(feed, hint),
    feedUrl,
    siteUrl: feed.siteUrl,
    cadence: cadenceText(feed.items, noun, ctx.now()),
    samples: feed.items.slice(0, 3).map((item, i) => ({ title: sampleTitle(feed, i), publishedAt: item.publishedAt })),
    itemLinks: feed.items.slice(0, SAME_FEED_ITEMS).flatMap((item) => (item.url ? [item.url] : [])),
    summariesOnly: feed.summariesOnly,
    alreadyFollowingSourceId: null,
    // A bridged source's address is a descriptor (its key can be long and random-looking), not a link anyone holds.
    privateWarning: !feedUrl.startsWith("bridge:") && privateUrlReason(feedUrl) ? PRIVATE_URL_WARNING : null,
    ...(overrides.note ? { note: overrides.note } : {}),
    // The gateway trims RSS, Atom and RDF; a JSON Feed is read by the engine as it is.
    ...(feed.large && feed.format !== "jsonfeed" ? { large: true } : {}),
  };
}

/** `inconclusive`: the probe timed out or the site was busy, so nothing is known about the address. */
type FeedProbe = { feedUrl: string; parsed: ParsedFeed } | {
  failed: Failure | null;
  inconclusive?: boolean;
  /** The answer came from another host than the one asked: the site sends this address elsewhere. */
  away?: boolean;
  /** The address answered with a web page: where it ended up and what it said (a site's "RSS feeds" page at `/rss`, say). */
  page?: { url: string; body: Uint8Array; contentType: string | null };
};

/** Fetch a URL expected to be a feed; returns the parsed feed or why not. */
/**
 * The address to follow. Some sites bounce a cookie-less visitor back to the same feed with
 * query noise added (e.g. Nature's `?error=cookies_not_supported&code=<random>`); that is not
 * the feed's address, and its random value would look like a private key. Keep the requested
 * address when the final one only adds query parameters to the same path.
 */
export function stableFeedUrl(requested: string, final: string): string {
  try {
    const a = new URL(requested);
    const b = new URL(final);
    if (a.origin === b.origin && a.pathname === b.pathname && [...a.searchParams].every(([k, v]) => b.searchParams.get(k) === v)) return a.href;
  } catch {
    /* fall through */
  }
  return withoutCookieBounce(final);
}

const bareHost = (u: string): string => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

async function probeFeed(ctx: Ctx, url: string, upgrade: boolean, o: { maxRedirects?: number } = {}): Promise<FeedProbe> {
  let httpFallback: string | null = null;
  let start = url;
  if (upgrade && url.startsWith("http://")) {
    try {
      const u = new URL(url);
      if (!u.port) {
        httpFallback = url;
        u.protocol = "https:";
        start = u.href;
      }
    } catch {
      /* keep as is */
    }
  }
  const res = await getWithUpgrade(ctx, start, httpFallback, { maxBytes: FEED_MAX_BYTES, ...(o.maxRedirects !== undefined ? { maxRedirects: o.maxRedirects } : {}) });
  if (!res.ok) return { failed: failFromFetch(url, res), inconclusive: res.reason === "timeout" || res.reason === "aborted" };
  const r = res.response;
  const away = bareHost(r.url) !== bareHost(start);
  const statusFail = failFromStatus(url, r.status);
  if (statusFail) return { failed: statusFail, inconclusive: r.status === 429 || r.status >= 500, away };
  const kind = sniffContent(r.body, r.contentType);
  if (!isFeedKind(kind)) return { failed: null, away, ...(kind === "html" ? { page: { url: r.url, body: r.body, contentType: r.contentType ?? null } } : {}) };
  try {
    return { feedUrl: stableFeedUrl(start, r.url), parsed: { ...parseFeed(r.body, r.contentType, { baseUrl: r.url }), ...(tooBigForEngine(r) ? { large: true } : {}) } };
  } catch (error) {
    if (error instanceof FeedParseError) return { failed: null };
    throw error;
  }
}

/**
 * Whether an address answers with something the preview reads as a feed: the same fetch, sniff and parse as a discovery probe,
 * so the answer is "yes" only for what a person would have been shown as a feed. The worker asks it before it lets the engine
 * force a subscription (the engine refuses a feed served without a Content-Type); a page, a failed fetch or a body that does
 * not parse is "no".
 */
export async function previewsAsFeed(url: string, opts: Pick<DiscoverOptions, "signal" | "fetch" | "timeoutMs" | "testAllowAddress" | "resolver" | "testTlsCa"> = {}): Promise<boolean> {
  const ctx = makeCtx({ ...opts, maxRequests: 4 });
  try {
    return "parsed" in (await probeFeed(ctx, url, false, { maxRedirects: 3 }));
  } catch {
    return false;
  }
}

/** Feeds that carry the same entries (one feed under two addresses or in two formats) are one choice: the first is kept. */
function dedupeCandidates(list: DraftCandidate[], parsedList: ParsedFeed[]): DraftCandidate[] {
  const kept: number[] = [];
  list.forEach((_, i) => {
    if (!kept.some((k) => sameEntries(parsedList[k]!, parsedList[i]!))) kept.push(i);
  });
  return kept.map((i) => list[i]!);
}

// ---------- YouTube ----------

/** What a YouTube lookup does before it gives up: the first try is patient for 12 s, the second for what is left of the budget (at most 15 s). */
const YOUTUBE_FIRST_TRY_MS = 12_000;
const YOUTUBE_SECOND_TRY_MS = 15_000;

/**
 * A request to YouTube. Its pages are over a megabyte and an answer now and then stalls (a lost packet, a slow lookup
 * of the name) or is cut off; a second connection a moment later usually works. So a try that timed out or was
 * interrupted is made once more, with the time that is left, instead of ending the lookup. A phase that was never
 * reached is not a verdict on the channel.
 */
async function getYoutube(ctx: Ctx, url: string, o: { maxBytes?: number; accept?: string }): Promise<SafeFetchResult> {
  const first = await ctx.get(url, { ...o, timeoutMs: YOUTUBE_FIRST_TRY_MS, phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 6000 } });
  const stalled = !first.ok && (first.reason === "timeout" || (first.reason === "unreachable" && /ECONNRESET|EPIPE|ECONNABORTED|PREMATURE_CLOSE/.test(first.detail)));
  if (!stalled || ctx.signal.aborted) return first;
  const left = Math.min(YOUTUBE_SECOND_TRY_MS, ctx.remainingMs() - 500);
  if (left < 3000) return first;
  return ctx.get(url, { ...o, timeoutMs: left, phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 6000 } });
}

async function discoverYoutube(norm: { url: string }, ctx: Ctx, max: number): Promise<DiscoveryDraft> {
  const url = new URL(norm.url);
  const target = classifyYoutubeUrl(url);
  const inputUrl = norm.url;
  if (target.kind === "unsupported") return fail(inputUrl, "unsupported", target.message);

  const candidates: DraftCandidate[] = [];
  /** A single video link can be kept as it is instead of following its channel. */
  let keep: KeepOffer | undefined;
  /** A readable name for the channel when its feed (which carries the real title) didn't answer. */
  let channelLabel: string | null = null;
  const feedCandidate = async (feedUrl: string, via: string | null, what: "channel" | "playlist" | "user"): Promise<Failure | null> => {
    // YouTube's feed endpoint answers 404/5xx intermittently (more often from cloud servers): retry briefly.
    const stalled = (p: FeedProbe) => "failed" in p && (p.failed?.reason === "unreachable" || p.failed?.reason === "timeout");
    let probe = await probeFeed(ctx, feedUrl, false);
    for (let attempt = 1; attempt < 3 && stalled(probe) && !ctx.signal.aborted && ctx.remainingMs() > ctx.retryDelayMs + 3000; attempt++) {
      await new Promise((r) => setTimeout(r, ctx.retryDelayMs));
      probe = await probeFeed(ctx, feedUrl, false);
    }
    if ("failed" in probe) {
      if (probe.failed?.reason === "unreachable" || probe.failed?.reason === "timeout") {
        // The channel is known, only its feed didn't answer: offer it anyway; the engine keeps retrying.
        if (what === "channel" && channelLabel) {
          candidates.push({
            route: "youtube", title: channelLabel, kind: "youtube", origin: feedLabels.youtubeChannelFeed, via: via ?? feedLabels.channelFeed,
            feedUrl, siteUrl: inputUrl, cadence: null, samples: [], summariesOnly: false, privateWarning: null, alreadyFollowingSourceId: null,
            note: server.sources.connectors.discover.youtubeNoRecentVideos,
          });
          return null;
        }
        return probe.failed.reason === "timeout" ? fail(inputUrl, "timeout", YOUTUBE_SLOW) : fail(inputUrl, "unreachable", YOUTUBE_REFUSED);
      }
      if (probe.failed) return probe.failed;
      return fail(inputUrl, "unreachable", what === "playlist" ? server.sources.connectors.discover.youtubeNoPlaylistFeed : server.sources.connectors.discover.youtubeNoChannelFeed);
    }
    const hint = { url: probe.feedUrl };
    const base = buildCandidate(probe.feedUrl, probe.parsed, hint, ctx, { route: "youtube" });
    candidates.push({ ...base, via: via ?? base.via, origin: what === "playlist" ? feedLabels.youtubePlaylistFeed : feedLabels.youtubeChannelFeed, kind: "youtube" });
    return null;
  };

  const resolveChannelFromPage = async (path: string, mode: "channel" | "video") => {
    const page = await getYoutube(ctx, `https://www.youtube.com${path}`, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
    return channelIdFromResponse(page, mode, mode === "channel" ? path : "");
  };

  switch (target.kind) {
    case "channel-id": {
      channelLabel = feedLabels.youtubeChannel;
      const err = await feedCandidate(channelFeedUrl(target.channelId), null, "channel");
      if (err) return err;
      break;
    }
    case "feed": {
      const feedUrl = target.channelId ? channelFeedUrl(target.channelId) : target.playlistId ? playlistFeedUrl(target.playlistId) : userFeedUrl(target.user!);
      const err = await feedCandidate(feedUrl, null, target.playlistId ? "playlist" : "channel");
      if (err) return err;
      break;
    }
    case "page": {
      const id = await resolveChannelFromPage(target.path, "channel");
      if (!id.ok) {
        // Legacy /user/ names have an official feed even when the page cannot be read.
        if (target.label === "user") {
          const name = decodeURIComponent(target.path.split("/")[2] ?? "");
          const err = await feedCandidate(userFeedUrl(name), null, "user");
          if (!err) break;
        }
        return fail(inputUrl, id.reason, id.message);
      }
      channelLabel = decodeURIComponent(target.path.split("/")[1] ?? "") || feedLabels.youtubeChannel;
      const err = await feedCandidate(channelFeedUrl(id.channelId), null, "channel");
      if (err) return err;
      break;
    }
    case "playlist": {
      const err = await feedCandidate(playlistFeedUrl(target.playlistId), null, "playlist");
      if (err) return err;
      break;
    }
    case "video": {
      let channelId: string | null = null;
      let message = server.sources.connectors.discover.videoChannelNotFound;
      let reason: Failure["reason"] = "unsupported";
      const oembed = await getYoutube(ctx, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${target.videoId}`)}`, {
        maxBytes: 64 * 1024,
        accept: "application/json",
      });
      if (oembed.ok && oembed.response.status === 200) {
        const author = parseOembed(decodeBody(oembed.response.body, oembed.response.contentType));
        channelLabel = author.authorName ?? null;
        // The video itself can be kept as it is, with the title and picture YouTube gives it.
        if (author.title) {
          keep = { url: `https://www.youtube.com/watch?v=${target.videoId}`, kind: "video", title: author.title, siteName: "YouTube", author: author.authorName, imageUrl: author.thumbnailUrl };
        }
        if (author.authorUrl) {
          try {
            const authorUrl = new URL(author.authorUrl);
            if (isYoutubeHost(authorUrl.hostname)) {
              const t = classifyYoutubeUrl(authorUrl);
              if (t.kind === "channel-id") channelId = t.channelId;
              else if (t.kind === "page") {
                const id = await resolveChannelFromPage(t.path, "channel");
                if (id.ok) channelId = id.channelId;
                else ({ message, reason } = { message: id.message, reason: id.reason });
              }
            }
          } catch {
            /* ignore a malformed author url */
          }
        }
      }
      if (!channelId) {
        const id = await resolveChannelFromPage(`/watch?v=${target.videoId}`, "video");
        if (id.ok) channelId = id.channelId;
        else if (id.reason === "unreachable" || id.reason === "timeout") ({ message, reason } = { message: id.message, reason: id.reason });
      }
      if (channelId) {
        channelLabel ??= feedLabels.youtubeChannel;
        const err = await feedCandidate(channelFeedUrl(channelId), feedLabels.relatedChannelConfirm, "channel");
        if (err && !target.playlistId && !keep) return err;
      } else if (!target.playlistId && !keep) {
        return fail(inputUrl, reason, message);
      }
      if (target.playlistId) {
        const err = await feedCandidate(playlistFeedUrl(target.playlistId), null, "playlist");
        if (err && candidates.length === 0 && !keep) return err;
      }
      break;
    }
  }
  return { ok: true, url: inputUrl, candidates: candidates.slice(0, max), ...(keep ? { keep } : {}) };
}

// ---------- generic ----------

type Found = { c: DraftCandidate; parsed: ParsedFeed };

/** What went wrong while probing, so a slow or busy site is never reported as having nothing. */
type Trouble = { timeout: boolean; busy: boolean; failure: Failure | null };

/** Where a found feed came from, which decides whether finding it says anything about the pasted page. */
type FoundVia = "alternate" | "anchor" | "listed" | "path" | "journal";

/**
 * `prior`: trouble already met on the way here (a known service's feeds timing out), which an empty result must not hide.
 * `unopened`: the page itself did not open (`html` is empty), so only the site's conventional addresses are tried.
 */
async function discoverFromPage(ctx: Ctx, pageUrl: string, html: string, max: number, inputUrl: string, prior?: Pick<Trouble, "timeout" | "busy">, unopened?: { status: number }): Promise<DiscoveryDraft> {
  const facts = extractPageFacts(html, pageUrl);
  const section = sectionPath(pageUrl);
  const siteName = siteNameFor(facts, pageUrl);
  const page = { url: pageUrl, title: facts.title };
  // Every page of a wiki advertises the feed of the whole wiki's changes: it is not the page's.
  const wiki = isMediaWiki(html);
  const ownLinks = wiki ? facts.links.filter((l) => !isWikiSiteFeed(l.url, pageUrl)) : facts.links;
  const alternates = ownLinks.filter((l) => l.source === "alternate");
  // A fediverse profile or post: offer only what it advertises; probing the server's paths would find
  // nothing of the account's. Any other page that names an ActivityPub actor (a blog with an ActivityPub
  // plugin) is an ordinary site and is searched like one.
  const pathname = new URL(pageUrl).pathname;
  if (facts.actorUrl && looksLikeProfilePath(pathname)) return socialFeedsFromProfile(ctx, facts.links, max, inputUrl, null);
  if (facts.actorUrl && alternates.length === 0 && looksLikeSocialPostPath(pathname)) return fail(inputUrl, "nofeed", FEDIVERSE_NOT_PROFILE);
  // A page that lists many sites' feeds (a publisher's hub) is cut short; the ones that are about this page go first.
  const anchors = rankByPage(ownLinks.filter((l) => l.source === "anchor"), page).slice(0, 6);
  const probes: FoundLink[] = [...alternates.slice(0, max + 2), ...(alternates.length === 0 ? anchors : [])];
  /**
   * `asked`: the journal feed address that was probed, so a later sign that it is the page's own can mark it, with `sibling`
   * (the main feed of a journal's second feed) and `feedNote` (what the feed itself covers).
   */
  const found: (Found & { via: FoundVia; matches: boolean; asked?: string; sibling?: string; feedNote?: string })[] = [];
  const attempted = new Set<string>();
  const trouble: Trouble = { timeout: prior?.timeout ?? false, busy: prior?.busy ?? false, failure: null };
  /** A feed of comments is not what a site's page is followed for: it does not end the search for the posts, and is never offered alone. */
  const hasPosts = () => found.some((f) => f.c.via !== feedLabels.commentsFeed);
  /** An advertised feed for this very page or section did not answer. */
  let ownFeedSilent = false;
  /** Feeds that cover the whole site although the page is a section; judged by the address asked for, since a blog's feed often answers from another host. */
  const wholeSiteFeeds = new Set<DraftCandidate>();
  /** Feed-looking addresses that answered with the site's page of feeds instead (`/rss` → "RSS feeds"), read later without asking again. */
  const probedListings = new Map<string, NonNullable<Extract<FeedProbe, { failed: Failure | null }>["page"]>>();

  const record = (probe: Extract<FeedProbe, { failed: Failure | null }>): void => {
    if (probe.failed) trouble.failure ??= probe.failed;
    if (probe.failed?.reason === "timeout") trouble.timeout = true;
    else if (probe.inconclusive) trouble.busy = true;
  };

  const add = (url: string, probe: FeedProbe, hint: Hint, via: FoundVia, matches: boolean, route: DiscoveryRoute): void => {
    if ("failed" in probe) {
      record(probe);
      if (probe.page && isDirectoryAddress(probe.page.url, pageUrl)) probedListings.set(url, probe.page);
      if (probe.inconclusive && !isSiteWideFeed(url, pageUrl)) ownFeedSilent = true;
      return;
    }
    // A link on the page to a "Subscribe" feed that holds nothing is the site's sign-up address, not its posts: the search goes on. A feed the page
    // advertises as its own is meant, however quiet it is.
    if (via !== "alternate" && probe.parsed.items.length === 0 && isSubscribeEndpoint(probe.feedUrl, probe.parsed.title)) return;
    const c = buildCandidate(probe.feedUrl, probe.parsed, { ...hint, url: probe.feedUrl, siteName }, ctx, { route });
    const wholeSite = isSiteWideFeed(url, pageUrl) || isSiteWideFeed(probe.feedUrl, pageUrl);
    if (wholeSite) wholeSiteFeeds.add(c);
    // A section's feed that only calls itself by the site's name is named after the section as well.
    if (section && !wholeSite && siteName && sameName(c.title, siteName)) c.title = sectionFeedName(facts.title, siteName) ?? c.title;
    found.push({ c, parsed: probe.parsed, via, matches });
  };

  /** `listed`: the links come from a page that lists feeds (a directory), not from the pasted page itself. */
  const tryLinks = async (links: FoundLink[], listed = false) => {
    const fresh = links.filter((l) => !attempted.has(l.url));
    const results = await mapLimit(fresh, 3, async (l) => {
      attempted.add(l.url);
      return { l, probe: await probeFeed(ctx, l.url, true) };
    });
    for (const { l, probe } of results) {
      const via: FoundVia = listed ? "listed" : l.source === "alternate" ? "alternate" : "anchor";
      const route: DiscoveryRoute = listed ? "listed-feed" : l.source === "alternate" ? "alternate-link" : l.shown ? "copy-address" : "page-anchor";
      add(l.url, probe, { title: l.title, url: l.url }, via, via === "alternate" || linkMatchesPage(l, page), route);
    }
  };

  /**
   * Probe conventional addresses a few at a time; stop after two feeds, when a batch was sent to another host (a login wall,
   * a parked domain: the rest of this list would be too), or when this lookup has made all the requests it may. Another list
   * of addresses is still tried: one odd redirect doesn't say that none of them is a feed. A site that answered a guess with
   * "too many requests", an error of its own or no answer in time gets no more guesses in this lookup.
   */
  let siteStrained = false;
  const tryPaths = async (urls: string[], route: DiscoveryRoute, hint: { section?: boolean } = {}) => {
    const fresh = urls.filter((u) => !attempted.has(u));
    let hits = 0;
    let sendsAway = false;
    for (let i = 0; i < fresh.length && hits < 2 && !sendsAway && !siteStrained && !ctx.spent() && !ctx.signal.aborted; i += 3) {
      const batch = await mapLimit(fresh.slice(i, i + 3), 3, async (u) => {
        attempted.add(u);
        const probe = await probeFeed(ctx, u, false, { maxRedirects: PROBE_REDIRECTS });
        // A site that reads the address as a name (/atom.xml → the feed of the user "atom") has no feed of its own there.
        return { u, probe: "feedUrl" in probe && probeLandedOnName(u, probe.feedUrl) ? { failed: null } : probe };
      });
      for (const { u, probe } of batch) {
        if (!("failed" in probe)) hits++;
        else if (probe.away) sendsAway = true;
        else if (probe.inconclusive) siteStrained = true;
        // A front page's conventional feed is the site's; a section's own feed is the section's.
        add(u, probe, { title: null, url: u, ...hint }, "path", !section || !!hint.section, route);
      }
    }
  };

  await tryLinks(probes);

  const origin = new URL(pageUrl).origin;
  if (isDiscourse(html)) {
    // A forum's "latest posts" feed has an entry per reply; its latest topics are what people want.
    await tryPaths([`${origin}/latest.rss`], "discourse-latest");
  }

  /** Probe a journal's feed; `matches` says whether it is shown to be this page's own journal. */
  const tryJournal = async (feed: KnownFeed, matches: (journalName: string | null) => boolean, route: DiscoveryRoute): Promise<boolean> => {
    if (attempted.has(feed.feedUrl)) {
      // Already offered as a journal the page links to: now shown to be the page's own, with its second feed.
      const seen = found.find((f) => f.asked === feed.feedUrl);
      if (seen && !seen.matches && matches(seen.c.title)) {
        for (const f of found) {
          if (f !== seen && f.sibling !== feed.feedUrl) continue;
          const { note: _linked, ...rest } = f.c;
          f.c = f.feedNote ? { ...rest, note: f.feedNote } : rest;
          f.matches = true;
        }
      }
      return !!seen;
    }
    attempted.add(feed.feedUrl);
    const probe = await probeFeed(ctx, feed.feedUrl, false);
    if ("failed" in probe) {
      record(probe);
      return false;
    }
    if (feed.needsItems && probe.parsed.items.length === 0) return false;
    const name = feed.title ?? feed.retitle?.(probe.parsed.title, probe.parsed) ?? (feed.nameFromDoi ? await journalNameFromDoi(probe.parsed, knownDeps(ctx)) : null) ?? (feed.nameLike ? (found.find((f) => f.asked === feed.nameLike)?.c.title ?? null) : null);
    const own = matches(name);
    const note = [feed.note, own ? null : LINKED_JOURNAL_NOTE].filter(Boolean).join(" ");
    const shown = name ?? (feed.nameFromDoi ? (feed.origin ?? null) : null);
    const c = buildCandidate(probe.feedUrl, probe.parsed, { url: probe.feedUrl, siteName }, ctx, { route, via: feed.via, origin: feed.origin, ...(shown ? { title: shown } : {}), ...(note ? { note } : {}) });
    found.push({ c, parsed: probe.parsed, via: "journal", matches: own, asked: feed.feedUrl, sibling: feed.nameLike, feedNote: feed.note });
    return true;
  };
  /** A journal's feeds, its main feed first (a second feed is named like it); true when any answered. */
  const tryJournalFeeds = async (feeds: KnownFeed[], matches: (journalName: string | null) => boolean, route: DiscoveryRoute): Promise<boolean> => {
    let any = false;
    for (const feed of feeds) if (await tryJournal(feed, matches, route)) any = true;
    return any;
  };
  const publisherPage = isPublisherHost(new URL(pageUrl).hostname.toLowerCase());
  const pageIssns = new Set(facts.journal.issns.map(normalIssn).filter((v): v is string => !!v));
  // The journal the page belongs to, for its Crossref choice: its scholarly metadata, or an Open Journal Systems journal's name.
  ctx.journal.issns.push(...pageIssns);
  if (OJS_GENERATOR.test(html) && (siteName ?? facts.title)) ctx.journal.names.push({ name: (siteName ?? facts.title)! });
  if (!publisherPage && facts.platformLinks.length) {
    // A society's page for its journal links to the journal on the publisher's platform; at most two journals, the page's own first.
    const picks = new Map<string, { link: { url: string; title: string | null }; ref: NonNullable<ReturnType<typeof journalFromUrl>> }>();
    for (const link of rankByPage(facts.platformLinks, page)) {
      const ref = journalFromUrl(new URL(link.url));
      if (!ref) continue;
      const key = ref.platform === "sciencedirect" ? `sciencedirect:${ref.slug}` : `${ref.platform}:${ref.id}`;
      if (!picks.has(key)) picks.set(key, { link, ref });
      if (picks.size === 2) break;
    }
    // Shown to be the page's own journal only by its name or ISSN: the address words a publisher shares with the page (`/journals`) say nothing.
    await mapLimit([...picks.values()], 3, async ({ link, ref }) => {
      const own = (name: string | null) => nameMatchesTitle(link.title, page.title) || nameMatchesTitle(name, page.title) || (ref.platform === "wiley" && pageIssns.has(ref.id));
      if (ref.platform !== "sciencedirect") return tryJournalFeeds(journalFeedsFor(ref), own, "journal-platform");
      const plan = await scienceDirectPlan(ctx, ref.slug);
      if (plan && "feeds" in plan) for (const feed of plan.feeds) if (await tryJournal(feed, own, plan.route)) return true;
      return false;
    });
  }
  // An Open Journal Systems journal: its announcements (news, calls for papers) are a feed of their own next to its articles.
  const ojs = facts.links.find((l) => l.source === "alternate" && /\/gateway\/plugin\/WebFeedGatewayPlugin\//.test(l.url));
  if (ojs && !publisherPage) {
    const base = ojs.url.slice(0, ojs.url.indexOf("/gateway/plugin/"));
    await tryJournal({ feedUrl: `${base}/gateway/plugin/AnnouncementFeedGatewayPlugin/atom`, via: feedLabels.announcementsFeed, note: OJS_ANNOUNCEMENTS_NOTE, needsItems: true }, () => true, "journal-ojs");
  }
  // Unless the page's own feed or journal was already found.
  if (pageIssns.size && !found.some((f) => f.matches && !wholeSiteFeeds.has(f.c))) {
    // The page's scholarly metadata names its journal; a publisher whose feeds are made from an ISSN gives the address.
    const plan = planFromIssns(facts.journal.publisher, [...pageIssns]);
    if (plan && "feeds" in plan) for (const feed of plan.feeds) if (await tryJournal(feed, () => true, plan.route)) break;
  }

  // Journals answer in whatever order their probes finish: the page's own come before those it only links to.
  found.sort((a, b) => Number(a.via === "journal" && !a.matches) - Number(b.via === "journal" && !b.matches));

  // A section's own feed comes before any guess at the whole site. Publishers keep no feed at a blog's usual addresses.
  if (!publisherPage && section && !found.some((f) => !wholeSiteFeeds.has(f.c) && f.c.via !== feedLabels.commentsFeed)) {
    await tryPaths(sectionFeedPaths(section).map((p) => `${origin}${p}`), "section-path", { section: true });
  }
  if (!hasPosts() && !publisherPage) {
    // Conservative fallback: a handful of conventional paths on the same site only.
    await tryPaths(PROBE_PATHS.map((p) => `${origin}${p}`), "conventional-path");
  }
  if (!hasPosts() && !publisherPage && !ctx.signal.aborted) {
    // Many news sites list their feeds on a page of their own ("RSS feeds"): look at the first two, those the page links to first,
    // then a feed-looking link or conventional address that answered with such a page (`/rss`), which was already fetched.
    const linked = findDirectoryLinks(html, pageUrl).filter((u) => probedListings.has(u) || !attempted.has(u));
    for (const dir of [...new Set([...linked, ...probedListings.keys()])].slice(0, 2)) {
      let shown = probedListings.get(dir);
      if (!shown) {
        attempted.add(dir);
        const listing = await ctx.get(dir, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
        if (!listing.ok) {
          if (listing.reason === "timeout" || listing.reason === "aborted") trouble.timeout = true;
          continue;
        }
        if (listing.response.status >= 400 || sniffContent(listing.response.body, listing.response.contentType) !== "html") continue;
        shown = { url: listing.response.url, body: listing.response.body, contentType: listing.response.contentType ?? null };
      }
      const listed = extractPageFacts(decodeBody(shown.body, shown.contentType), shown.url);
      // The listing may name a dozen feeds; the ones about the pasted page are looked at first.
      await tryLinks(rankByPage(listed.links, page).slice(0, 6), true);
      if (hasPosts()) break;
    }
  }
  if (!hasPosts() && !publisherPage && !ctx.signal.aborted) {
    // Publisher and webcomic software that keeps its feed one folder down or names it after its format.
    await tryPaths(MORE_FEED_PATHS.map((p) => `${origin}${p}`), "more-paths");
  }

  // Feeds that were only listed (a hub's, a directory's) say nothing about the page unless one of them is the page's own.
  if (found.some((f) => f.via !== "alternate" && f.via !== "path" && f.matches)) {
    for (let i = found.length - 1; i >= 0; i--) if ((found[i]!.via === "anchor" || found[i]!.via === "listed") && !found[i]!.matches) found.splice(i, 1);
  }

  if (!hasPosts()) {
    const first = trouble.failure;
    if (first?.reason === "blocked") return first;
    if (isDuke(pageUrl)) return fail(inputUrl, "nofeed", DUKE_MESSAGE);
    if (unopened) return failFromStatus(inputUrl, unopened.status)!;
    if (ctx.spent()) return fail(inputUrl, "nofeed", CAP_MESSAGE);
    if (trouble.timeout || ctx.signal.aborted) return fail(inputUrl, "timeout", TIMEOUT_MESSAGE);
    if (trouble.busy) return fail(inputUrl, "unreachable", BUSY_MESSAGE);
    if (found.length) return fail(inputUrl, "nofeed", COMMENTS_ONLY_MESSAGE);
    return fail(inputUrl, "nofeed", NO_FEED_MESSAGE);
  }

  const matching = new Set(found.filter((f) => f.matches).map((f) => f.c));
  const unique = dedupeCandidates(
    found.map((f) => f.c),
    found.map((f) => f.parsed),
  ).map((c) => {
    const matchesPage = matching.has(c);
    if (wholeSiteFeeds.has(c)) return { ...c, matchesPage, via: feedLabels.wholeSiteFeed, note: c.note ?? (ownFeedSilent ? WHOLE_SITE_FALLBACK_NOTE : WHOLE_SITE_NOTE) };
    if (isDiscourse(html) && /\/posts\.rss$/.test(new URL(c.feedUrl).pathname)) return { ...c, matchesPage, via: feedLabels.allReplies, note: server.sources.connectors.discover.allRepliesNote };
    if (isDiscourse(html) && /\/latest\.rss$/.test(new URL(c.feedUrl).pathname)) return { ...c, matchesPage, via: feedLabels.latestTopics };
    return { ...c, matchesPage };
  });
  const ordered = orderByVia(withoutCommentFeeds(unique)).slice(0, max);
  return {
    ok: true,
    url: inputUrl,
    candidates: unopened
      ? ordered.map((c) => ({ ...c, note: [server.sources.connectors.discover.didntOpen(section ? server.sources.connectors.discover.thatPage : server.sources.connectors.discover.frontPage, unopened.status), c.note].filter(Boolean).join(" ") }))
      : ordered,
  };
}

/**
 * Fetch an address and find its feeds: the address is a feed itself, or a page whose feeds are looked for. `url` is what
 * is fetched, `inputUrl` what the person gave (the two differ for a DOI, fetched through doi.org).
 */
async function discoverAddress(ctx: Ctx, asked: string, httpFallback: string | null, max: number, inputUrl: string, prior?: Pick<Trouble, "timeout" | "busy">, accept?: string, www: { url: string; httpFallback: string | null } | null = null): Promise<DiscoveryDraft> {
  let url = asked;
  const o = accept ? { accept } : undefined;
  // With a `www.` form to fall back on, the bare host may use half of what is left of the budget on its first try, so that the other host
  // gets the other half whatever the first one does.
  let first = await ctx.get(asked, www ? { ...o, timeoutMs: Math.min(REQUEST_MS, Math.floor(ctx.remainingMs() / 2)) } : o);
  // A bare host can be the one that refuses (a bot challenge in front of the bare name), fails or does not answer while the site's usual
  // `www.` address works: that is asked as soon as the bare host's own first try has shown it, before its plain-http form is tried. It is
  // the same site, followed like a redirect to it.
  if (www && hostTrouble(ctx, first)) {
    const other = await getWithUpgrade(ctx, www.url, www.httpFallback, o);
    // Only if it stays on the site: a `www.` host that sends everyone to a login or another site is not the site's own page.
    if (other.ok && other.response.status < 400 && bareHost(other.response.url) === bareHost(asked)) {
      first = other;
      url = www.url;
    }
  }
  if (url === asked) first = await withHttpFallback(ctx, first, httpFallback, o);
  if (!first.ok) return failFromFetch(inputUrl, first);
  const response = first.response;
  // Sent on to a journal's page (a DOI, a short link): its feed is made from that address, even when the page is walled.
  let landedTrouble: { timeout: boolean; busy: boolean } | null = null;
  if (response.url !== url) {
    const landed = planJournal(new URL(response.url));
    const known = landed ? await resolveKnown(landed, knownDeps(ctx), response.url) : null;
    if (known && "candidates" in known) return { ok: true, url: inputUrl, candidates: known.candidates.slice(0, max) };
    if (known && "trouble" in known) {
      landedTrouble = known.trouble;
      prior = { timeout: !!prior?.timeout || landedTrouble.timeout, busy: !!prior?.busy || landedTrouble.busy };
    }
  }
  const statusFail = failFromStatus(inputUrl, response.status);
  if (statusFail) {
    // A front page that refuses automated readers (403) or is broken (5xx) often still serves its feed; look at the usual addresses before giving up.
    if ((response.status === 403 || response.status >= 500) && !ctx.signal.aborted) {
      const rescued = await discoverFromPage(ctx, response.url, "", max, inputUrl, prior, { status: response.status });
      if (rescued.ok) return rescued;
    }
    if (response.status === 403 && isDuke(response.url)) return fail(inputUrl, "nofeed", DUKE_MESSAGE);
    // The journal's feed didn't answer just now: the walled page says nothing more.
    if (landedTrouble) return landedTrouble.timeout ? fail(inputUrl, "timeout", TIMEOUT_MESSAGE) : fail(inputUrl, "unreachable", BUSY_MESSAGE);
    return statusFail;
  }
  const kind = sniffContent(response.body, response.contentType);
  if (isFeedKind(kind)) {
    let parsed: ParsedFeed;
    try {
      parsed = { ...parseFeed(response.body, response.contentType, { baseUrl: response.url }), ...(tooBigForEngine(response) ? { large: true } : {}) };
    } catch (error) {
      if (error instanceof FeedParseError) {
        return fail(inputUrl, "invalid", error.code === "toolarge" ? server.sources.connectors.discover.feedTooLarge : server.sources.connectors.discover.feedUnreadable);
      }
      throw error;
    }
    // A YouTube feed pasted directly is still a YouTube source.
    const feedUrl = stableFeedUrl(url, response.url);
    const candidate = buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx, { route: "feed-address" });
    return { ok: true, url: inputUrl, candidates: [candidate] };
  }
  if (kind === "html") {
    const html = decodeBody(response.body, response.contentType);
    ctx.page = { url: response.url, html, body: response.body };
    return await discoverFromPage(ctx, response.url, html, max, inputUrl, prior);
  }
  if (kind === "xml") {
    const text = decodeBody(response.body.subarray(0, 4096), response.contentType);
    if (/<opml[\s>]/i.test(text)) return fail(inputUrl, "unsupported", server.sources.connectors.discover.opmlList);
    if (/<urlset[\s>]|<sitemapindex[\s>]/i.test(text)) return fail(inputUrl, "unsupported", server.sources.connectors.discover.sitemap);
    return fail(inputUrl, "unsupported", server.sources.connectors.discover.notAFeedXml);
  }
  if (kind === "json") return fail(inputUrl, "unsupported", server.sources.connectors.discover.notAFeedJson);
  return fail(inputUrl, "unsupported", server.sources.connectors.discover.notAPage);
}

// ---------- registries ----------

export const WIKIDATA_NOTE = server.sources.connectors.discover.wikidataNote;
/**
 * The answers after which the registries are asked: nothing found on the page, or a page that turns automated readers
 * away (403, 429, "busy or limiting") or is broken (5xx). Asking a registry puts no load on the site, and whatever it names
 * is checked like any feed. Not a more particular answer (a fediverse post, a page that isn't there, Duke's message),
 * which says something the registries can't improve on.
 */
function registryMayHelp(draft: Failure): boolean {
  if (draft.reason === "nofeed") return draft.message === NO_FEED_MESSAGE || draft.message === CAP_MESSAGE;
  if (draft.reason !== "unreachable") return false;
  return [403, 429].some((status) => draft.message === failFromStatus(draft.url, status)!.message) || draft.message === BUSY_MESSAGE || Array.from({ length: 100 }, (_, i) => 500 + i).some((status) => draft.message === failFromStatus(draft.url, status)!.message);
}
/** Feeds Wikidata lists that are tried. */
const MAX_REGISTRY_FEEDS = 4;
/** Requests the registry step may make after the site used up the cap: Wikidata's search and items, and two feeds. */
const REGISTRY_ALLOWANCE = 4;
/** Each registry request gets this long, so a slow registry can't use up the lookup's budget. */
const REGISTRY_TIMEOUT_MS = 8000;

/**
 * Discovery's last resort: when a web address gave nothing, ask Wikidata which item has the page (or, for a
 * section page, the site's front page) as its official website. Feeds it lists are tried like any other, and the page's
 * own item's ISSNs are handed to the Crossref step. A private-looking address is never sent, nor any query string;
 * Wikidata failing or slow leaves the answer as it was.
 */
async function withRegistry(ctx: Ctx, draft: DiscoveryDraft, pageUrl: string, max: number): Promise<DiscoveryDraft> {
  if (draft.ok || !registryMayHelp(draft) || ctx.journal.issns.length || ctx.signal.aborted || privateUrlReason(pageUrl)) return draft;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return draft;
  }
  // An address by number has no official website to look up.
  if (/^[\d.]+$|^\[/.test(url.hostname)) return draft;
  const page = addressVariants(url);
  const front = url.pathname.replace(/\/+$/, "") ? addressVariants(new URL("/", url)) : [];
  // A site whose own addresses used up the lookup's requests (a 404 that redirects, say) still gets the registry asked: its search and
  // items, and two of the feeds it names. That is someone else being asked, not more load on the site.
  if (ctx.spent()) ctx.allow(REGISTRY_ALLOWANCE);
  // A search over a very long page address's spellings would be too long an address to send: the front page alone then.
  const items = await wikidataItems(ctx, wikidataSearchUrl([...page, ...front]) ? [...page, ...front] : front);
  const pageSet = new Set(page);
  const frontSet = new Set(front);
  // Only items whose website really is one of the spellings asked about: the search index can lag behind an edit.
  const own = items.filter((i) => i.websites.some((w) => pageSet.has(w)));
  // A publishing platform's front page is not the journal's: its feed (if Wikidata lists one) would be another journal's or the platform's.
  const site = isPublisherHost(url.hostname.toLowerCase()) || journalFromUrl(url) ? [] : items.filter((i) => !own.includes(i) && i.websites.some((w) => frontSet.has(w)));
  // A journal's ISSNs come from the page's own item only: a publisher's front page is not one journal.
  ctx.journal.issns.push(...own.flatMap((i) => i.issns));
  // The page's own feeds first; the front page's, for a section page, as the whole site's.
  const ownFeeds = [...new Set(own.flatMap((i) => i.feeds))];
  const siteFeeds = [...new Set(site.flatMap((i) => i.feeds))].filter((f) => !ownFeeds.includes(f));
  const feeds = [...ownFeeds.map((f) => [f, false] as const), ...siteFeeds.map((f) => [f, true] as const)].slice(0, Math.min(MAX_REGISTRY_FEEDS, max));
  const found: DraftCandidate[] = [];
  const offered: ParsedFeed[] = [];
  for (const [feedUrl, wholeSite] of feeds) {
    if (ctx.signal.aborted) break;
    const probe = await probeFeed(ctx, feedUrl, false);
    if ("failed" in probe || offered.some((p) => sameEntries(p, probe.parsed))) continue;
    offered.push(probe.parsed);
    const c = buildCandidate(probe.feedUrl, probe.parsed, { url: probe.feedUrl }, ctx, wholeSite ? { route: "wikidata", via: feedLabels.wholeSiteFeed, note: `${WIKIDATA_NOTE} ${WHOLE_SITE_NOTE}` } : { route: "wikidata", note: WIKIDATA_NOTE });
    found.push({ ...c, matchesPage: !wholeSite });
  }
  return found.length ? { ok: true, url: draft.url, candidates: found } : draft;
}

/** The items Wikidata has with one of `addresses` as their official website; nothing when it can't be asked just now. */
async function wikidataItems(ctx: Ctx, addresses: string[]): Promise<WikidataItem[]> {
  const search = wikidataSearchUrl(addresses);
  if (!search) return [];
  const ask = async (url: string): Promise<unknown> => {
    const res = await ctx.get(url, { maxBytes: 512 * 1024, accept: "application/json", timeoutMs: REGISTRY_TIMEOUT_MS, maxRedirects: 0 });
    if (!res.ok || res.response.status !== 200) return null;
    try {
      return JSON.parse(decodeBody(res.response.body, res.response.contentType));
    } catch {
      return null;
    }
  };
  const ids = readWikidataSearch(await ask(search));
  if (!ids.length || ctx.signal.aborted) return [];
  return readWikidataEntities(await ask(wikidataEntitiesUrl(ids)));
}

// ---------- scholarly journals ----------

export const LINKED_JOURNAL_NOTE = server.sources.connectors.discover.linkedJournalNote;
export const CROSSREF_VIA = feedLabels.registeredArticles;
export const CROSSREF_NOTE = server.sources.connectors.discover.crossrefNote;
const OJS_GENERATOR = /<meta[^>]+name=["']generator["'][^>]+content=["']Open Journal Systems/i;

/**
 * What discovery learned about the journal an address belongs to: ISSNs it was told (a page's metadata, a DOI's
 * Crossref record), names to look up in Crossref with the publisher that must match, the platform a journal page is on
 * (its feeds' journal name is then looked up), and a Wiley journal code that isn't an ISSN.
 */
type JournalClue = { issns: string[]; names: { name: string; publisher?: RegExp }[]; platform?: Platform; wileyCode?: string };

/** Crossref's publisher names for each platform: a journal found by name must be one of the platform's. */
const PLATFORM_PUBLISHER: Record<Platform, RegExp | undefined> = {
  wiley: /\b(?:wiley|hindawi)\b/i,
  tandf: /\b(?:taylor|informa|routledge)\b/i,
  sage: /\bsage\b/i,
  uchicago: /\bchicago\b/i,
  berghahn: /\bberghahn\b/i,
  // Project MUSE hosts many publishers' journals: an exact, single title match is required instead.
  muse: undefined,
  sciencedirect: /\belsevier\b/i,
  ieee: /\b(?:ieee|institute of electrical)\b/i,
  iop: /\b(?:iop|institute of physics)\b/i,
  acm: /\b(?:acm|association for computing machinery)\b/i,
  springer: /\bspringer\b/i,
  mdpi: /\bmdpi\b/i,
  plos: /\b(?:plos|public library of science)\b/i,
  frontiers: /\bfrontiers\b/i,
};
const DUKE_SLUG = /^[a-z][a-z0-9-]{2,60}$/;
const DUKE_NOT_JOURNALS = new Set(["books", "journals", "search", "account", "about", "contact", "cart", "series", "authors", "subjects", "news", "sign-in", "my-account", "content", "pb-assets", "rss"]);

/** What a journal page's address says about its journal. */
function noteJournalAddress(ctx: Ctx, url: URL): void {
  const ref = journalFromUrl(url);
  if (ref) ctx.journal.platform = ref.platform;
  if (ref?.platform === "wiley") {
    if (normalIssn(ref.id)) ctx.journal.issns.push(ref.id);
    else ctx.journal.wileyCode = ref.id;
  }
  const s = url.pathname.split("/").filter(Boolean);
  if (isDuke(url.href) && DUKE_SLUG.test(s[0] ?? "") && !DUKE_NOT_JOURNALS.has(s[0]!)) ctx.journal.names.push({ name: s[0]!.replace(/-/g, " "), publisher: /\bduke\b/i });
}

/** A pasted ISSN: Crossref names the journal and its publisher, whose ISSN-made feed (Wiley, Elsevier) is offered when it answers. */
async function discoverIssn(ctx: Ctx, issn: string, max: number): Promise<DiscoveryDraft> {
  ctx.journal.issns.push(issn);
  const label = `ISSN ${issn.slice(0, 4)}-${issn.slice(4)}`;
  const record = await knownDeps(ctx).json(crossrefJournalUrl(issn));
  const journal = record.ok ? readCrossrefJournal(record.data) : null;
  if (!journal) return fail(label, "nofeed", server.sources.connectors.discover.unknownIssn);
  const plan = planFromIssns(journal.publisher, [issn, ...journal.issns], journal.title);
  const known = plan ? await resolveKnown(plan, knownDeps(ctx), label) : null;
  if (known && "candidates" in known) return { ok: true, url: label, candidates: known.candidates.slice(0, max) };
  return fail(label, "nofeed", server.sources.connectors.discover.journalNoFeed(`${journal.title ?? server.sources.connectors.discover.thatJournal}${journal.publisher ? ` (${journal.publisher})` : ""}`));
}

/**
 * The journal's ISSNs for its Crossref choice, the likeliest first (at most two): those it was told, else those Crossref
 * gives for the journal's name. Crossref files a journal's works under one of its ISSNs, not always the same one.
 */
async function journalIssns(ctx: Ctx, draft: DiscoveryDraft): Promise<string[]> {
  const told = [...new Set(ctx.journal.issns.map(normalIssn).filter((v): v is string => !!v))].slice(0, 2);
  if (told.length) return told;
  const names = [...ctx.journal.names];
  const platform = ctx.journal.platform;
  if (platform) {
    const publisher = PLATFORM_PUBLISHER[platform];
    // The journal feeds found say the journal's name ("Wiley: Oceania: Table of Contents" → "Oceania").
    for (const c of draft.ok ? draft.candidates : []) if (isJournalArticlesFeed(c)) names.push({ name: c.title, publisher });
    if (ctx.journal.wileyCode && !names.length) {
      // A Wiley feed that is switched off still answers (404) with a channel that names the journal.
      const name = await wileyJournalName(ctx, ctx.journal.wileyCode);
      if (name) names.push({ name, publisher });
    }
  }
  const tried = new Set<string>();
  for (const { name, publisher } of names.slice(0, 3)) {
    // "Social Anthropology/Anthropologie sociale" is "Social Anthropology" in Crossref's journal list.
    for (const variant of [name, name.split(/\s*\/\s*/)[0]!]) {
      const key = variant.toLowerCase().trim();
      if (!key || tried.has(key)) continue;
      tried.add(key);
      const search = await knownDeps(ctx).json(crossrefJournalSearchUrl(variant));
      const found: CrossrefJournalRecord | null = search.ok ? findCrossrefJournal(search.data, variant, publisher) : null;
      if (found) return found.issns.slice(0, 2);
    }
  }
  return [];
}

async function wileyJournalName(ctx: Ctx, code: string): Promise<string | null> {
  const res = await ctx.get(`https://onlinelibrary.wiley.com/feed/${code}/most-recent`, { maxBytes: 256 * 1024, maxRedirects: 0 });
  if (!res.ok || (res.response.status !== 200 && res.response.status !== 404)) return null;
  try {
    return journalTitle(parseFeed(res.response.body, res.response.contentType).title);
  } catch {
    return null;
  }
}

/** Feeds a journal's page can have that aren't its articles. */
const NOT_THE_JOURNALS_ARTICLES = new Set([feedLabels.announcementsFeed, feedLabels.commentsFeed, feedLabels.allReplies, feedLabels.wholeSiteFeed]);

/** A journal's own articles (or issues) feed, as opposed to its announcements or a site's other feeds. */
function isJournalArticlesFeed(c: DraftCandidate): boolean {
  return (c.via === feedLabels.articlesFeed || c.via === feedLabels.earlyArticlesFeed || c.via === feedLabels.issuesFeed) && !c.feedUrl.startsWith("bridge:");
}

/**
 * The journal's Crossref choice, added after everything else was found and ordered. Next to the journal's own
 * articles feed it is an alternative, never chosen first; without one it is the journal's feed. A journal Crossref
 * doesn't know, or a router that can't reach Crossref just now, leaves the result as it was. If the caller allows only
 * one choice, the journal's own feed stays and Crossref is not added.
 */
async function withCrossref(ctx: Ctx, opts: DiscoverOptions, draft: DiscoveryDraft, max: number): Promise<DiscoveryDraft> {
  const service = bridgeService("crossref");
  if (!service || !opts.bridge || !(opts.bridgeServes?.(service) ?? true)) return draft;
  if (!draft.ok && draft.reason === "blocked") return draft;
  if (draft.ok && draft.candidates.some((c) => c.feedUrl.startsWith(`bridge:${service.id}/`))) return draft;
  if (ctx.signal.aborted) return draft;
  if (draft.ok && max <= 1 && draft.candidates.some(isJournalArticlesFeed)) {
    return { ...draft, candidates: draft.candidates.slice(0, Math.max(0, max)) };
  }
  // The first ISSN whose works Crossref has; an ISSN with none is kept only when no other has any.
  let picked: { issn: string; parsed: ParsedFeed } | null = null;
  for (const issn of await journalIssns(ctx, draft)) {
    if (ctx.signal.aborted) return draft;
    const answer = await opts.bridge({ service, key: issn }, ctx.signal).catch(() => ({ failed: true }) as const);
    if ("failed" in answer || answer.status !== 200) continue;
    let parsed: ParsedFeed;
    try {
      parsed = parseFeed(answer.body, "application/rss+xml");
    } catch {
      continue;
    }
    if (!picked || (!picked.parsed.items.length && parsed.items.length)) picked = { issn, parsed };
    if (picked.parsed.items.length) break;
  }
  if (!picked) return draft;
  const { issn, parsed } = picked;
  const site = issnPortalUrl(issn);
  const c = { ...buildCandidate(bridgeDescriptor(service.id, issn), parsed, { url: site }, ctx, { route: "crossref", origin: service.origin, via: CROSSREF_VIA, note: CROSSREF_NOTE }), siteUrl: site };
  if (!draft.ok) return { ok: true, url: draft.url, candidates: [{ ...c, matchesPage: true }] };
  const others = draft.candidates.slice(0, max - 1);
  // Without the journal's own feed, its articles come first (before its announcements, say), and start out chosen. The
  // journal's own feed is its articles feed on a platform, or a feed the page itself shows to be its own.
  if (!draft.candidates.some((c) => isJournalArticlesFeed(c) || (c.matchesPage === true && !NOT_THE_JOURNALS_ARTICLES.has(c.via)))) return { ...draft, candidates: [{ ...c, matchesPage: true }, ...others] };
  return { ...draft, candidates: [...others, { ...c, alternative: true }] };
}
export const OJS_ANNOUNCEMENTS_NOTE = server.sources.connectors.journals.announcementsNote;

function isDuke(url: string): boolean {
  const h = bareHost(url);
  return h === "dukeupress.edu" || h.endsWith(".dukeupress.edu");
}

/**
 * A DOI (an article's identifier): Crossref names the journal, its publisher and ISSNs, and a publisher whose feed
 * address is made from an ISSN (Wiley, Elsevier) gives the journal's feed. Otherwise the DOI's own page is looked at like
 * any other, asked for as a web page: doi.org answers a feed reader's usual request with Crossref's metadata instead.
 */
async function discoverDoi(ctx: Ctx, doi: string, pageUrl: string, max: number, label: string): Promise<DiscoveryDraft> {
  const deps = knownDeps(ctx);
  const record = await deps.json(crossrefWorkUrl(doi));
  const journal: CrossrefJournal | null = record.ok ? readCrossrefWork(record.data) : null;
  // Crossref's own records are fullest under the electronic ISSN; the publisher's feed may take the print one.
  if (journal) ctx.journal.issns.push(...(journal.electronic ? [journal.electronic] : []), ...journal.issns);
  const plan = journal ? planFromIssns(journal.publisher, journal.issns, journal.title) : null;
  let trouble: { timeout: boolean; busy: boolean } | undefined;
  if (plan) {
    const known = await resolveKnown(plan, deps, pageUrl);
    if (known && "candidates" in known) return { ok: true, url: label, candidates: known.candidates.slice(0, max) };
    if (known && "trouble" in known) trouble = known.trouble;
  }
  const draft = await discoverAddress(ctx, pageUrl, null, max, label, trouble, HTML_ACCEPT);
  if (draft.ok || !journal?.title) return draft;
  // The journal's feed didn't answer just now: that is not "no feed".
  if (trouble) return trouble.timeout ? fail(label, "timeout", TIMEOUT_MESSAGE) : fail(label, "unreachable", BUSY_MESSAGE);
  // Only a conclusive miss (nothing found, the article page refused or missing) names the journal; a busy or slow site stays retryable.
  const conclusive = draft.reason === "nofeed" || draft.reason === "unsupported" || [403, 404, 410].some((status) => draft.message === failFromStatus(label, status)!.message);
  if (!conclusive) return draft;
  return fail(label, "nofeed", server.sources.connectors.discover.articleInJournal(`${journal.title}${journal.publisher ? ` (${journal.publisher})` : ""}`));
}

/** The feed plan of a ScienceDirect journal, from Crossref's one Elsevier journal whose title is the address's name. */
async function scienceDirectPlan(ctx: Ctx, slug: string): Promise<KnownPlan | null> {
  const search = await knownDeps(ctx).json(crossrefJournalQueryUrl(slug));
  const journal = search.ok ? readCrossrefJournalSearch(search.data, slug) : null;
  if (journal) ctx.journal.issns.push(...(journal.electronic ? [journal.electronic] : []), ...journal.issns);
  return journal ? planFromIssns(journal.publisher, journal.issns, journal.title) : null;
}

/** The dependencies a known-service plan needs, bound to this discovery's budget and fetcher. */
function knownDeps(ctx: Ctx): KnownDeps {
  return {
    probe: async (feedUrl) => {
      const probe = await probeFeed(ctx, feedUrl, false);
      if (!("failed" in probe)) return probe;
      return { failed: probe.failed ? { reason: probe.failed.reason, message: probe.failed.message } : null, inconclusive: !!probe.inconclusive };
    },
    json: async (url, o) => {
      const res = await ctx.get(url, { maxBytes: o?.maxBytes ?? 256 * 1024, accept: "application/json" });
      if (!res.ok) {
        const f = failFromFetch(url, res);
        return { ok: false, reason: f.reason, message: f.message };
      }
      const status = failFromStatus(url, res.response.status);
      if (status) return { ok: false, reason: status.reason, message: status.message, status: res.response.status };
      try {
        return { ok: true, data: JSON.parse(decodeBody(res.response.body, res.response.contentType)) };
      } catch {
        return { ok: false, reason: "unsupported", message: server.sources.connectors.discover.serviceUnreadable };
      }
    },
    candidate: (feedUrl, parsed, extra) => buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx, extra),
  };
}


// ---------- social accounts ----------

const JRD_ACCEPT = "application/jrd+json, application/json;q=0.9";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const PROFILE_REL = "http://webfinger.net/rel/profile-page";
const FEDIVERSE_NO_FEED = server.sources.connectors.discover.fediverseNoFeed;
const FEDIVERSE_NOT_PROFILE = server.sources.connectors.discover.fediverseNotProfile;

/** The feeds a fediverse profile page advertises, labelled with the platform and its limits. */
async function socialFeedsFromProfile(ctx: Ctx, links: FoundLink[], max: number, inputUrl: string, fallbackTitle: string | null): Promise<DiscoveryDraft> {
  const advertised = links.filter((l) => l.source === "alternate").slice(0, 3);
  const results = await mapLimit(advertised, 3, (l) => probeFeed(ctx, l.url, false));
  const candidates: DraftCandidate[] = [];
  for (const probe of results) {
    if ("failed" in probe) {
      if (probe.failed?.reason === "blocked") return probe.failed;
      continue;
    }
    const platform = platformForFeed(probe.parsed.generator);
    const c = buildCandidate(probe.feedUrl, probe.parsed, { url: probe.feedUrl }, ctx, { route: "fediverse", origin: SOCIAL_ORIGIN[platform], via: feedLabels.postsFeed });
    candidates.push({ ...c, kind: "feed", title: meaningfulTitle(probe.parsed.title) ?? fallbackTitle ?? c.title, note: SOCIAL_NOTE[platform] });
  }
  if (candidates.length === 0) return fail(inputUrl, "nofeed", FEDIVERSE_NO_FEED);
  return { ok: true, url: inputUrl, candidates: candidates.slice(0, max) };
}

/** @name@server: WebFinger names the profile page, and the profile page names its feed. */
async function discoverFediverse(t: { user: string; domain: string }, ctx: Ctx, max: number, opts: DiscoverOptions): Promise<DiscoveryDraft> {
  const handle = `@${t.user}@${t.domain}`;
  const serverCheck = normalizeInput(`https://${t.domain}/`, { testAllowAddress: opts.testAllowAddress });
  if (!serverCheck.ok) return fail(handle, serverCheck.reason, serverCheck.message);
  const wf = await ctx.get(`https://${t.domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${t.user}@${t.domain}`)}`, { maxBytes: 64 * 1024, accept: JRD_ACCEPT });
  if (!wf.ok) return failFromFetch(handle, wf);
  if (wf.response.status === 404 || wf.response.status === 410) {
    return fail(handle, "nofeed", server.sources.connectors.discover.handleNotFound(handle));
  }
  const wfStatus = failFromStatus(handle, wf.response.status);
  if (wfStatus) return wfStatus;
  let profile: string | null = null;
  try {
    const jrd = JSON.parse(decodeBody(wf.response.body, wf.response.contentType)) as { links?: unknown };
    for (const l of Array.isArray(jrd.links) ? jrd.links : []) {
      const link = l as { rel?: unknown; href?: unknown };
      if (link?.rel !== PROFILE_REL || typeof link.href !== "string") continue;
      try {
        const u = new URL(link.href);
        if (u.protocol === "https:" || u.protocol === "http:") { profile = u.href; break; }
      } catch { /* not an address */ }
    }
  } catch {
    return fail(handle, "invalid", server.sources.connectors.discover.notAnAccount(t.domain));
  }
  if (!profile) return fail(handle, "nofeed", server.sources.connectors.discover.noPublicProfile(t.domain, handle));
  const page = await ctx.get(profile, { accept: HTML_ACCEPT });
  if (!page.ok) return failFromFetch(handle, page);
  const pageStatus = failFromStatus(handle, page.response.status);
  if (pageStatus) return pageStatus;
  if (sniffContent(page.response.body, page.response.contentType) !== "html") return fail(handle, "nofeed", FEDIVERSE_NO_FEED);
  const facts = extractPageFacts(decodeBody(page.response.body, page.response.contentType), page.response.url);
  return socialFeedsFromProfile(ctx, facts.links, max, handle, handle);
}

/** Bluesky's own profile feed. A handle redirects to the DID form, which outlives handle changes. */
async function discoverBluesky(t: { actor: string; related: boolean }, ctx: Ctx): Promise<DiscoveryDraft> {
  const label = t.actor.startsWith("did:") ? t.actor : `@${t.actor}`;
  const requested = `https://bsky.app/profile/${t.actor}/rss`;
  const res = await ctx.get(requested, { maxBytes: FEED_MAX_BYTES });
  if (!res.ok) return failFromFetch(label, res);
  const r = res.response;
  if (r.status === 403) return fail(label, "nofeed", server.sources.connectors.discover.blueskyHidden);
  if (r.status === 404) return fail(label, "nofeed", server.sources.connectors.discover.blueskyNotFound(label));
  if (r.status === 400) return fail(label, "invalid", server.sources.connectors.discover.blueskyBadHandle);
  const status = failFromStatus(label, r.status);
  if (status) return status;
  if (!isFeedKind(sniffContent(r.body, r.contentType))) return fail(label, "unreachable", server.sources.connectors.discover.blueskyNoFeed);
  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(r.body, r.contentType, { baseUrl: r.url });
  } catch (error) {
    if (error instanceof FeedParseError) return fail(label, "invalid", server.sources.connectors.discover.blueskyUnreadable);
    throw error;
  }
  const feedUrl = stableFeedUrl(requested, r.url);
  const c = buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx, { route: "bluesky", origin: SOCIAL_ORIGIN.bluesky, via: t.related ? feedLabels.relatedAccountConfirm : feedLabels.postsFeed });
  return { ok: true, url: label, candidates: [{ ...c, kind: "feed", title: blueskyTitle(parsed.title, t.actor), note: SOCIAL_NOTE.bluesky }] };
}

async function discoverSocial(t: SocialTarget, ctx: Ctx, max: number, opts: DiscoverOptions, input: string): Promise<DiscoveryDraft> {
  if (t.kind === "unsupported") return fail(input.slice(0, 200), "unsupported", t.message);
  if (t.kind === "fediverse") {
    const found = await discoverFediverse(t, ctx, max, opts);
    // name@server without the leading @ is usually an email address: say so when no account answered to it.
    return !found.ok && t.emailLike ? fail(input.slice(0, 200), "invalid", EMAIL_MESSAGE) : found;
  }
  return discoverBluesky(t, ctx);
}

// ---------- lists of posts on a page that has no feed ----------

const pageLists = server.sources.connectors.pageLists;
const PAGE_SERVICE = "page";
/**
 * The most lists offered for one page, and so the most previews: each has the bridge fetch the page once more. They are the lookup's own
 * allowance, apart from the cap of requests discovery makes itself, which a site whose usual addresses all redirect has used up by then.
 */
const MAX_PAGE_LISTS = 3;
/** A list is previewed only with this much of the lookup's time left: the bridge fetches the page and reads it, which takes seconds. */
const PAGE_PREVIEW_MIN_MS = 8000;
/** One list's preview waits this long at most. */
const PAGE_PREVIEW_MAX_MS = 25_000;
/** The words for what made a list likely or doubtful, by the detector's reason codes (a code without words does not compile). */
const REASON_WORDS: Record<PageListReason, string> = pageLists.reasons;
/** What counts for a list, and what counts against it: the first are said as "why", the second as "doubts"; `undated` is said by the note. */
const DOUBTS = new Set<PageListReason>(["inNav", "inFooter", "inSidebar", "inChrome", "brittle", "approximate", "incomplete", "facetTitles", "metaTitles", "queryOnlyLinks"]);

/** A list's preview: what the bridge makes of it now, or nothing when it could not read it. */
async function previewPageList(ctx: Ctx, bridge: BridgeClient, target: BridgeTarget): Promise<ParsedFeed | null> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.min(PAGE_PREVIEW_MAX_MS, ctx.remainingMs())))]);
  const answer = await bridge(target, signal).catch(() => ({ failed: true }) as const);
  if ("failed" in answer || answer.status !== 200) return null;
  try {
    const parsed = parseFeed(answer.body, "application/rss+xml");
    return parsed.items.length ? parsed : null;
  } catch {
    return null;
  }
}

/** What PURSS says about a list it offers: how it reads it and what that costs, how sure it is, and why it chose it. */
function pageListNote(c: PageListCandidate): string {
  const reasons = c.reasons.filter((r) => r !== "dataOnly");
  const why = reasons.filter((r) => !DOUBTS.has(r));
  const doubts = reasons.filter((r) => DOUBTS.has(r));
  return [
    pageLists.note,
    c.confidence === "high" ? "" : pageLists.unsure,
    why.length ? pageLists.because(why.map((r) => REASON_WORDS[r])) : "",
    doubts.length ? pageLists.doubts(doubts.map((r) => REASON_WORDS[r])) : "",
  ].filter(Boolean).join(" ");
}

/**
 * Discovery's last step, for a page that has no feed: the lists of posts the page itself shows (page-lists.ts), each previewed through the
 * bridge as the source it would be. It runs only when the bridge serves page lists, a web page was read, and nothing else (the page's own
 * feeds, its usual addresses, Wikidata, Crossref) found a feed, so a real feed always wins. A list is offered only when the bridge read posts
 * from it just now; one that is likely (`high`) is the page's own and starts out chosen, one that is merely possible (`medium`) is offered
 * and left to the person; a guess (`low`) is no list at all. No script of the page runs, and nothing is fetched here: the page is the one
 * the lookup already read.
 */
async function withPageLists(ctx: Ctx, opts: DiscoverOptions, draft: DiscoveryDraft, max: number): Promise<DiscoveryDraft> {
  const service = bridgeService(PAGE_SERVICE);
  const page = ctx.page;
  if (!service || !page || !opts.bridge || !(opts.bridgeServes?.(service) ?? true)) return draft;
  // Nothing was found: no feed, or the cap ended the search for one. A page that turned readers away, was slow or busy is not "no list" either.
  if (draft.ok || draft.reason !== "nofeed" || (draft.message !== NO_FEED_MESSAGE && draft.message !== CAP_MESSAGE)) return draft;
  // A page whose address looks to carry a key stays out of a descriptor that is kept, exported and logged.
  if (ctx.signal.aborted || ctx.remainingMs() < PAGE_PREVIEW_MIN_MS || privateUrlReason(page.url)) return draft;
  const found = detectPageLists(page.html, page.url, ctx.now());
  const best = found.candidates[0];
  if (!best || best.confidence === "low") {
    return found.diagnosis === "appShell" || found.diagnosis === "emptyMain" ? fail(draft.url, "nofeed", pageLists.scriptPage) : draft;
  }
  const fixEncoding = !markupDeclaresCharset(page.html) && needsCharsetRepair(page.body);
  const keyed = found.candidates.flatMap((c) => {
    const key = c.confidence !== "low" && c.portable && c.recipe ? encodePageKey({ url: page.url, recipe: c.recipe, fixEncoding }) : null;
    return key ? [{ c, key }] : [];
  }).slice(0, Math.min(MAX_PAGE_LISTS, max));
  const bridge = opts.bridge;
  const read = await Promise.all(keyed.map(async ({ c, key }) => ({ c, key, parsed: await previewPageList(ctx, bridge, { service, key }) })));
  if (ctx.signal.aborted) return fail(draft.url, "timeout", TIMEOUT_MESSAGE);
  const offered = read.flatMap((r) => (r.parsed ? [{ ...r, parsed: r.parsed }] : []));
  if (!offered.length) return draft;
  const facts = extractPageFacts(page.html, page.url);
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  const siteName = siteNameFor(facts, page.url);
  return {
    ok: true,
    url: draft.url,
    candidates: offered.map(({ c, key, parsed }, i) => {
      const confidence = c.confidence === "high" ? "high" : "medium";
      const candidate = buildCandidate(bridgeDescriptor(service.id, key), parsed, { url: page.url, title: facts.title, siteName }, ctx, {
        route: "page-list",
        origin: service.origin,
        via: offered.length > 1 ? pageLists.viaNumbered(i + 1) : pageLists.via,
        note: pageListNote(c),
        title: nameFeed({ feedTitle: parsed.title, linkTitle: cleanLine(facts.title, 200), siteName, host }),
      });
      // Only the first list, and only when PURSS is sure of it, is the page's own; the others are for the person to choose.
      return { ...candidate, siteUrl: page.url, matchesPage: c.rank === 1 && confidence === "high", pageList: { confidence } };
    }),
  };
}

// ---------- bridged services ----------

export const BRIDGE_NOTE = server.sources.connectors.discover.bridgeNote;

/** A bridged source (a Telegram channel, a Bandcamp artist…), previewed through the bridge router. */
async function discoverBridged(target: BridgeTarget, bridge: BridgeClient, ctx: Ctx, label: string): Promise<DiscoveryDraft> {
  const { service, key } = target;
  if (ctx.signal.aborted) return fail(label, "timeout", TIMEOUT_MESSAGE);
  const answer = await bridge(target, ctx.signal).catch(() => ({ failed: true }) as const);
  if (ctx.signal.aborted) return fail(label, "timeout", TIMEOUT_MESSAGE);
  const shown = service.label?.(key) ?? key;
  if ("failed" in answer || answer.status !== 200) {
    return fail(label, "unreachable", server.sources.connectors.discover.bridgeNoPostsCheck(service.name, shown));
  }
  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(answer.body, "application/rss+xml");
  } catch {
    return fail(label, "unreachable", server.sources.connectors.discover.bridgeNoPosts(service.name, shown));
  }
  const crossref = service.backend.kind === "crossref";
  const pageList = service.id === PAGE_SERVICE;
  const candidate = buildCandidate(bridgeDescriptor(service.id, key), parsed, { url: service.pageUrl(key) }, ctx, {
    route: `bridge:${service.id}`,
    origin: service.origin,
    via: crossref ? CROSSREF_VIA : pageList ? pageLists.via : feedLabels.postsFeed,
    note: crossref ? CROSSREF_NOTE : pageList ? pageLists.note : BRIDGE_NOTE,
  });
  return { ok: true, url: service.pageUrl(key), candidates: [{ ...candidate, siteUrl: service.pageUrl(key) }] };
}

/** Discover followable feeds for a pasted address. Never throws; every outcome is a result. */
export async function discover(input: string, opts: DiscoverOptions = {}): Promise<DiscoveryDraft> {
  // A bridged source's own address (from an export, say) is that source again.
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.startsWith("bridge:")) {
    const described = parseBridgeDescriptor(trimmed);
    if (!described || !opts.bridge || !(opts.bridgeServes?.(described.service) ?? true)) return fail(trimmed.slice(0, 200), "unsupported", server.sources.connectors.discover.bridgeNotRun);
    return await discoverBridged(described, opts.bridge, makeCtx(opts), trimmed);
  }
  // An article's DOI, bare (10.1111/…), as doi:10.1111/… or as a doi.org address. Read before the address rules: a bare DOI
  // starts like a numeric (private) address.
  const doi = typeof input === "string" ? doiFromInput(cleanPasted(input)) : null;
  if (doi) {
    const ctx = makeCtx(opts);
    const max = Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES);
    const given = doi.viaResolver ? normalizeInput(input, { testAllowAddress: opts.testAllowAddress }) : null;
    const pageUrl = given?.ok ? given.url : resolverUrl(doi.doi);
    try {
      return await withCrossref(ctx, opts, await discoverDoi(ctx, doi.doi, pageUrl, max, doi.viaResolver ? pageUrl : doi.doi), max);
    } catch {
      return fail(doi.doi.slice(0, 200), "unreachable", server.sources.connectors.discover.doiFailed);
    }
  }
  // A journal's ISSN: the publisher's feed when its address is made from the ISSN, and the journal's Crossref choice.
  const issn = typeof input === "string" ? issnFromInput(input) : null;
  if (issn) {
    const ctx = makeCtx(opts);
    const max = Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES);
    try {
      return await withCrossref(ctx, opts, await discoverIssn(ctx, issn, max), max);
    } catch {
      return fail(issn, "unreachable", server.sources.connectors.discover.issnFailed);
    }
  }
  const social = typeof input === "string" ? classifySocialInput(input) : null;
  if (social) {
    const ctx = makeCtx(opts);
    try {
      return await discoverSocial(social, ctx, Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES), opts, input);
    } catch {
      return fail(input.slice(0, 200), "unreachable", server.sources.connectors.discover.accountFailed);
    }
  }
  const norm = normalizeInput(input, { testAllowAddress: opts.testAllowAddress });
  if (!norm.ok) return fail(typeof input === "string" ? input.slice(0, 200) : "", norm.reason, norm.message);
  const ctx = makeCtx(opts);
  const max = Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES);
  try {
    return await withPageLists(ctx, opts, await withCrossref(ctx, opts, await withRegistry(ctx, await discoverUrl(ctx, opts, norm, max), norm.url, max), max), max);
  } catch (error) {
    // Programming errors must not leak details or secrets into the user message.
    return fail(norm.url, "unreachable", server.sources.connectors.discover.checkFailed(redactUrl(norm.url)));
  }
}

/** Discovery for a web address (normalised). */
async function discoverUrl(ctx: Ctx, opts: DiscoverOptions, norm: Extract<ReturnType<typeof normalizeInput>, { ok: true }>, max: number): Promise<DiscoveryDraft> {
  {
    const entry = new URL(norm.url);
    noteJournalAddress(ctx, entry);
    if (isYoutubeHost(entry.hostname)) {
      const draft = await discoverYoutube(norm, ctx, max);
      if (!draft.ok || draft.candidates.length > 0 || draft.keep) return draft;
      return fail(norm.url, "nofeed", server.sources.connectors.discover.noYoutubeFeed);
    }
    // Pages of services this server follows through its bridge.
    const found = opts.bridge ? bridgeTargetForPage(entry) : null;
    const bridged = found && (opts.bridgeServes?.(found.service) ?? true) ? found : null;
    if (bridged && opts.bridge) return await discoverBridged(bridged, opts.bridge, ctx, norm.url);
    // Services that publish no feeds are named as such, without asking them for one.
    const platform = noFeedPlatform(entry);
    if (platform) return fail(norm.url, "unsupported", platform.message);
    // An article on a platform whose article pages refuse automated readers: its DOI names the journal.
    const articleDoi = doiFromArticleUrl(entry);
    if (articleDoi) return await discoverDoi(ctx, articleDoi, norm.url, max, norm.url);
    // A ScienceDirect journal: its address carries only the journal's name, and the feed is made from its ISSN.
    const sciencedirect = journalFromUrl(entry);
    if (sciencedirect?.platform === "sciencedirect") {
      const plan = await scienceDirectPlan(ctx, sciencedirect.slug);
      const known = plan ? await resolveKnown(plan, knownDeps(ctx), norm.url) : null;
      if (known && "candidates" in known) return { ok: true, url: norm.url, candidates: known.candidates.slice(0, max) };
    }
    // Services whose feed addresses follow a fixed pattern.
    const plan = planKnownFeeds(entry);
    let prior: Pick<Trouble, "timeout" | "busy"> | undefined;
    if (plan) {
      const known = await resolveKnown(plan, knownDeps(ctx), norm.url);
      if (known && "failure" in known) return fail(norm.url, known.failure.reason, known.failure.message);
      if (known && "trouble" in known) prior = known.trouble;
      else if (known) {
        // The feed the page is about (a series page's podcast) goes first, then the usual order.
        const ordered = orderByVia(known.candidates);
        return { ok: true, url: norm.url, candidates: [...ordered.filter((c) => c.matchesPage), ...ordered.filter((c) => !c.matchesPage)].slice(0, max) };
      }
    }
    return await discoverAddress(ctx, norm.url, norm.httpFallback, max, norm.url, prior, undefined, wwwAlternative(norm));
  }
}
