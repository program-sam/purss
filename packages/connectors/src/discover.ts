import type { DiscoveryCandidate, DiscoveryResult, KeepOffer } from "@purss/domain";
import { EPISODES, POSTS, VIDEOS, cadenceText } from "./cadence.ts";
import type { Noun } from "./cadence.ts";
import { decodeBody, isFeedKind, sniffContent } from "./content-type.ts";
import { FeedParseError, parseFeed } from "./feed.ts";
import type { ParsedFeed } from "./feed.ts";
import { isDiscourse, isGenericTitle, isSiteWideFeed, linkMatchesPage, MORE_FEED_PATHS, nameFeed, orderByVia, probeLandedOnName, rankByPage, sameName, sectionFeedName, sectionFeedPaths, sectionPath, siteNameFor, SITE_FEED_PATHS, WHOLE_SITE_FALLBACK_NOTE, WHOLE_SITE_NOTE, withoutCommentFeeds } from "./feed-choice.ts";
import { extractPageFacts, findDirectoryLinks } from "./html-links.ts";
import type { FoundLink } from "./html-links.ts";
import { EMAIL_MESSAGE, normalizeInput, withoutCookieBounce } from "./input.ts";
import { planKnownFeeds, resolveKnown } from "./known-feeds.ts";
import type { KnownDeps } from "./known-feeds.ts";
import { bridgeDescriptor, bridgeTargetForPage, parseBridgeDescriptor } from "./bridges.ts";
import type { BridgeTarget } from "./bridges.ts";
import { noFeedPlatform } from "./platforms.ts";
import { PRIVATE_URL_WARNING, privateUrlReason, redactUrl } from "./privacy.ts";
import { safeFetch } from "./safe-fetch.ts";
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

/*
 * Source discovery: from whatever was pasted to a short list of followable feeds, each
 * with an honest preview. Discovery fetching is separate from recurring collection
 * (FreshRSS does that); every request goes through safeFetch.
 */

export type DraftCandidate = Omit<DiscoveryCandidate, "token">;
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
  /** The installation's bridge router (plan/41); without it, bridged services get the "no feeds" answer. */
  bridge?: BridgeClient;
};

/** Asks the bridge router for a source's feed: what the engine will see, through the internal listener only. */
export type BridgeClient = (target: BridgeTarget, signal: AbortSignal) => Promise<{ status: number; body: Uint8Array } | { failed: true }>;

const MAX_CANDIDATES = 8;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const FEED_MAX_BYTES = 4 * 1024 * 1024;
const PROBE_PATHS = SITE_FEED_PATHS;
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5";

const MAX_REQUESTS = 40;
/** The usual addresses are asked for with a short redirect chain: a site that needs more is not serving a feed there. */
const PROBE_REDIRECTS = 2;

type Ctx = {
  retryDelayMs: number;
  signal: AbortSignal;
  /** Milliseconds left of the overall budget. */
  remainingMs: () => number;
  /** True once this discovery has made all the requests it may. */
  spent: () => boolean;
  now: () => Date;
  get: (url: string, opts?: { maxBytes?: number; accept?: string; timeoutMs?: number; phaseTimeoutsMs?: PhaseTimeouts; maxRedirects?: number }) => Promise<SafeFetchResult>;
};

function makeCtx(opts: DiscoverOptions): Ctx {
  const fetcher: FetchFn = opts.fetch ?? safeFetch;
  const budgetMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const budget = AbortSignal.timeout(budgetMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  const maxRequests = opts.maxRequests ?? MAX_REQUESTS;
  let requests = 0;
  return {
    retryDelayMs: opts.retryDelayMs ?? 1500,
    signal,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - started)),
    spent: () => requests >= maxRequests,
    now: opts.now ?? (() => new Date()),
    get: async (url, o) => {
      // One lookup is never allowed to turn into an unbounded number of requests to someone else's site.
      if (requests >= maxRequests) return { ok: false, reason: "aborted", message: "Looking stopped: this site needed too many requests.", detail: "request cap of one lookup" };
      requests++;
      const result = await fetcher(url, {
        signal,
        maxBytes: o?.maxBytes ?? PAGE_MAX_BYTES,
        // A preview needs only the start of a document (a podcast feed can be tens of MB).
        allowPartial: true,
        accept: o?.accept ?? FEED_ACCEPT,
        timeoutMs: o?.timeoutMs ?? 15_000,
        phaseTimeoutsMs: o?.phaseTimeoutsMs ?? { firstByteMs: 10_000, idleMs: 8000 },
        ...(o?.maxRedirects !== undefined ? { maxRedirects: o.maxRedirects } : {}),
        testAllowAddress: opts.testAllowAddress,
        resolver: opts.resolver,
        testTlsCa: opts.testTlsCa,
      });
      // Every redirect hop is a request to someone else's site too.
      if (result.ok) requests += result.response.redirects.length;
      return result;
    },
  };
}

function fail(url: string, reason: Failure["reason"], message: string): Failure {
  return { ok: false, url, reason, message };
}

/** Slowness is as likely to be here as there, so the message names neither as the culprit. */
export const TIMEOUT_MESSAGE = "Looking took too long. The site may be slow or PURSS busy; try again.";
export const BUSY_MESSAGE = "The site didn't give us what we needed just now: it was busy or limiting requests. Try again in a few minutes.";
/** One lookup made all the requests it may, probing a site that never showed a feed. */
export const CAP_MESSAGE = "We stopped looking after trying many addresses on that site without finding a feed. If you have the feed's own address, paste that.";
export const MISSING_HOST_MESSAGE = "There's no website with that name; the address doesn't exist. Check it for typing mistakes.";

/** safeFetch's detail for a name that does not resolve (as opposed to one that merely did not answer). */
const MISSING_HOST = /^(?:dns (?:ENOTFOUND|ENODATA|empty answer)|ENOTFOUND )/;

function failFromFetch(url: string, f: Extract<SafeFetchResult, { ok: false }>): Failure {
  switch (f.reason) {
    case "blocked":
      return fail(url, "blocked", f.message);
    case "toolarge":
      return fail(url, "toolarge", "That page or feed is too large for us to read safely.");
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
  "YouTube isn't handing out this channel's feed to this server right now. It often refuses feed requests from cloud servers; from a home connection it usually works. Try again later.";

function failFromStatus(url: string, status: number): Failure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return fail(url, "unsupported", "That address asks for a username and password, which isn't supported yet.");
  if (status === 403) return fail(url, "unreachable", "That website refused to show us the page (error 403). It may block automated readers or need a login.");
  if (status === 404 || status === 410) return fail(url, "unreachable", `We couldn't find anything at that address (error ${status}). Check it for typing mistakes.`);
  if (status === 429) return fail(url, "unreachable", "That website asked us to slow down (too many requests). Try again in a few minutes.");
  if (status >= 500) return fail(url, "unreachable", `That website is having problems right now (error ${status}). Try again later.`);
  return fail(url, "unreachable", `That website answered with an unexpected result (${status}).`);
}

/** Fetch with an https-first attempt when the person gave no scheme or plain http. */
async function getWithUpgrade(ctx: Ctx, url: string, httpFallback: string | null, o?: { maxBytes?: number; maxRedirects?: number }): Promise<SafeFetchResult> {
  const first = await ctx.get(url, o);
  if (!httpFallback) return first;
  if (first.ok && first.response.status < 400) return first;
  if (!first.ok && (first.reason === "blocked" || first.reason === "aborted" || first.reason === "toolarge")) return first;
  const second = await ctx.get(httpFallback, o);
  if (second.ok && second.response.status < 400) return second;
  return first.ok ? first : second.ok ? second : first;
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
  if (feed.youtube?.playlistId) return "YouTube playlist feed";
  if (feed.youtube) return "YouTube channel feed";
  if (feed.isPodcast) return "Podcast feed";
  switch (feed.format) {
    case "atom":
      return "Atom feed";
    case "jsonfeed":
      return "JSON Feed";
    default:
      return "RSS feed";
  }
}

function viaFor(feed: ParsedFeed, hint: Hint): string {
  if (feed.youtube?.playlistId) return "Playlist feed";
  if (feed.youtube) return "Channel feed";
  if (feed.isPodcast) return "Podcast feed";
  const label = `${hint.title ?? ""} ${feed.title ?? ""}`;
  let path = "";
  try {
    const u = new URL(hint.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    path = "";
  }
  if (/\bcomments?\b|\breplies\b|\bdiscussion\b/i.test(label) || /\/comments?(?:\/|$)|[?&]feed=comments|comments\/feed/i.test(path)) return "Comments feed";
  if (hint.section || /\/(?:category|categories|tag|tags|topic|topics|section|label|author|search)\//i.test(path) || /[?&](?:cat|category|tag|s|label)=/i.test(path)) return "Section feed";
  return "Posts feed";
}

function sampleTitle(feed: ParsedFeed, index: number): string {
  const item = feed.items[index]!;
  if (item.title) return item.title.length > 140 ? `${item.title.slice(0, 139)}…` : item.title;
  const text = htmlToText(item.summaryHtml ?? item.contentHtml ?? "", 400);
  if (text) return text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return "Untitled";
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

function buildCandidate(feedUrl: string, parsed: ParsedFeed, hint: Hint, ctx: Ctx, overrides: { via?: string; origin?: string; title?: string; note?: string } = {}): DraftCandidate {
  const feed = newestFirst(parsed);
  const noun = nounFor(feed);
  let host = "";
  try {
    host = new URL(feedUrl).hostname.replace(/^www\./, "");
  } catch {
    host = feedUrl;
  }
  return {
    title: overrides.title ?? nameFeed({ feedTitle: feed.title, linkTitle: cleanLine(hint.title, 200), siteName: hint.siteName, host }),
    kind: feed.youtube ? "youtube" : feed.isPodcast ? "podcast" : "feed",
    origin: overrides.origin ?? originFor(feed),
    via: overrides.via ?? viaFor(feed, hint),
    feedUrl,
    siteUrl: feed.siteUrl,
    cadence: cadenceText(feed.items, noun, ctx.now()),
    samples: feed.items.slice(0, 3).map((item, i) => ({ title: sampleTitle(feed, i), publishedAt: item.publishedAt })),
    summariesOnly: feed.summariesOnly,
    alreadyFollowingSourceId: null,
    privateWarning: privateUrlReason(feedUrl) ? PRIVATE_URL_WARNING : null,
    ...(overrides.note ? { note: overrides.note } : {}),
  };
}

/** `inconclusive`: the probe timed out or the site was busy, so nothing is known about the address. */
type FeedProbe = { feedUrl: string; parsed: ParsedFeed } | { failed: Failure | null; inconclusive?: boolean; /** The answer came from another host than the one asked: the site sends this address elsewhere. */ away?: boolean };

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
  if (!isFeedKind(kind)) return { failed: null, away };
  try {
    return { feedUrl: stableFeedUrl(start, r.url), parsed: parseFeed(r.body, r.contentType, { baseUrl: r.url }) };
  } catch (error) {
    if (error instanceof FeedParseError) return { failed: null };
    throw error;
  }
}

function dedupeCandidates(list: DraftCandidate[], parsedList: ParsedFeed[]): DraftCandidate[] {
  const seen = new Set<string>();
  const out: DraftCandidate[] = [];
  list.forEach((c, i) => {
    const first = parsedList[i]!.items[0];
    const key = `${(c.title || "").toLowerCase()}|${first?.url ?? first?.guid ?? c.feedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  });
  return out;
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
            title: channelLabel, kind: "youtube", origin: "YouTube channel feed", via: via ?? "Channel feed",
            feedUrl, siteUrl: inputUrl, cadence: null, samples: [], summariesOnly: false, privateWarning: null, alreadyFollowingSourceId: null,
            note: "YouTube didn't send recent videos just now. Following will keep trying.",
          });
          return null;
        }
        return probe.failed.reason === "timeout" ? fail(inputUrl, "timeout", YOUTUBE_SLOW) : fail(inputUrl, "unreachable", YOUTUBE_REFUSED);
      }
      if (probe.failed) return probe.failed;
      return fail(inputUrl, "unreachable", what === "playlist" ? "YouTube doesn't publish a feed for that playlist (it may be private or an automatic mix)." : "YouTube didn't return a feed for that channel.");
    }
    const hint = { url: probe.feedUrl };
    const base = buildCandidate(probe.feedUrl, probe.parsed, hint, ctx);
    candidates.push({ ...base, via: via ?? base.via, origin: what === "playlist" ? "YouTube playlist feed" : "YouTube channel feed", kind: "youtube" });
    return null;
  };

  const resolveChannelFromPage = async (path: string, mode: "channel" | "video") => {
    const page = await getYoutube(ctx, `https://www.youtube.com${path}`, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
    return channelIdFromResponse(page, mode, mode === "channel" ? path : "");
  };

  switch (target.kind) {
    case "channel-id": {
      channelLabel = "YouTube channel";
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
      channelLabel = decodeURIComponent(target.path.split("/")[1] ?? "") || "YouTube channel";
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
      let message = "We couldn't find which channel uploaded that video.";
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
        channelLabel ??= "YouTube channel";
        const err = await feedCandidate(channelFeedUrl(channelId), "Related channel — confirm", "channel");
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
type FoundVia = "alternate" | "anchor" | "listed" | "path";

/**
 * `prior`: trouble already met on the way here (a known service's feeds timing out), which an empty result must not hide.
 * `unopened`: the page itself did not open (`html` is empty), so only the site's conventional addresses are tried.
 */
async function discoverFromPage(ctx: Ctx, pageUrl: string, html: string, max: number, inputUrl: string, prior?: Pick<Trouble, "timeout" | "busy">, unopened?: { status: number }): Promise<DiscoveryDraft> {
  const facts = extractPageFacts(html, pageUrl);
  const section = sectionPath(pageUrl);
  const siteName = siteNameFor(facts, pageUrl);
  const page = { url: pageUrl, title: facts.title };
  const alternates = facts.links.filter((l) => l.source === "alternate");
  // A fediverse profile or post: offer only what it advertises; probing the server's paths would find
  // nothing of the account's. Any other page that names an ActivityPub actor (a blog with an ActivityPub
  // plugin) is an ordinary site and is searched like one.
  const pathname = new URL(pageUrl).pathname;
  if (facts.actorUrl && looksLikeProfilePath(pathname)) return socialFeedsFromProfile(ctx, facts.links, max, inputUrl, null);
  if (facts.actorUrl && alternates.length === 0 && looksLikeSocialPostPath(pathname)) return fail(inputUrl, "nofeed", FEDIVERSE_NOT_PROFILE);
  // A page that lists many sites' feeds (a publisher's hub) is cut short; the ones that are about this page go first.
  const anchors = rankByPage(facts.links.filter((l) => l.source === "anchor"), page).slice(0, 6);
  const probes: FoundLink[] = [...alternates.slice(0, max + 2), ...(alternates.length === 0 ? anchors : [])];
  const found: (Found & { via: FoundVia; matches: boolean })[] = [];
  const attempted = new Set<string>();
  const trouble: Trouble = { timeout: prior?.timeout ?? false, busy: prior?.busy ?? false, failure: null };
  /** An advertised feed for this very page or section did not answer. */
  let ownFeedSilent = false;
  /** Feeds that cover the whole site although the page is a section; judged by the address asked for, since a blog's feed often answers from another host. */
  const wholeSiteFeeds = new Set<DraftCandidate>();

  const record = (probe: Extract<FeedProbe, { failed: Failure | null }>): void => {
    if (probe.failed) trouble.failure ??= probe.failed;
    if (probe.failed?.reason === "timeout") trouble.timeout = true;
    else if (probe.inconclusive) trouble.busy = true;
  };

  const add = (url: string, probe: FeedProbe, hint: Hint, via: FoundVia, matches: boolean): void => {
    if ("failed" in probe) {
      record(probe);
      if (probe.inconclusive && !isSiteWideFeed(url, pageUrl)) ownFeedSilent = true;
      return;
    }
    const c = buildCandidate(probe.feedUrl, probe.parsed, { ...hint, url: probe.feedUrl, siteName }, ctx);
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
      add(l.url, probe, { title: l.title, url: l.url }, via, via === "alternate" || linkMatchesPage(l, page));
    }
  };

  /**
   * Probe conventional addresses a few at a time; stop after two feeds, when a batch was sent to another host (a login wall,
   * a parked domain: the rest of this list would be too), or when this lookup has made all the requests it may. Another list
   * of addresses is still tried: one odd redirect doesn't say that none of them is a feed.
   */
  const tryPaths = async (urls: string[], hint: { section?: boolean } = {}) => {
    const fresh = urls.filter((u) => !attempted.has(u));
    let hits = 0;
    let sendsAway = false;
    for (let i = 0; i < fresh.length && hits < 2 && !sendsAway && !ctx.spent() && !ctx.signal.aborted; i += 3) {
      const batch = await mapLimit(fresh.slice(i, i + 3), 3, async (u) => {
        attempted.add(u);
        const probe = await probeFeed(ctx, u, false, { maxRedirects: PROBE_REDIRECTS });
        // A site that reads the address as a name (/atom.xml → the feed of the user "atom") has no feed of its own there.
        return { u, probe: "feedUrl" in probe && probeLandedOnName(u, probe.feedUrl) ? { failed: null } : probe };
      });
      for (const { u, probe } of batch) {
        if (!("failed" in probe)) hits++;
        else if (probe.away) sendsAway = true;
        // A front page's conventional feed is the site's; a section's own feed is the section's.
        add(u, probe, { title: null, url: u, ...hint }, "path", !section || !!hint.section);
      }
    }
  };

  await tryLinks(probes);

  const origin = new URL(pageUrl).origin;
  if (isDiscourse(html)) {
    // A forum's "latest posts" feed has an entry per reply; its latest topics are what people want.
    await tryPaths([`${origin}/latest.rss`]);
  }
  // A section's own feed comes before any guess at the whole site.
  if (section && !found.some((f) => !wholeSiteFeeds.has(f.c))) {
    await tryPaths(sectionFeedPaths(section).map((p) => `${origin}${p}`), { section: true });
  }
  if (found.length === 0) {
    // Conservative fallback: a handful of conventional paths on the same site only.
    await tryPaths(PROBE_PATHS.map((p) => `${origin}${p}`));
  }
  if (found.length === 0 && !ctx.signal.aborted) {
    // Publisher and webcomic software that keeps its feed one folder down or names it after its format.
    await tryPaths(MORE_FEED_PATHS.map((p) => `${origin}${p}`));
  }
  if (found.length === 0 && !ctx.signal.aborted) {
    // Many news sites list their feeds on a page of their own ("RSS feeds"): look at the first two.
    for (const dir of findDirectoryLinks(html, pageUrl).filter((u) => !attempted.has(u)).slice(0, 2)) {
      attempted.add(dir);
      const listing = await ctx.get(dir, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
      if (!listing.ok) {
        if (listing.reason === "timeout" || listing.reason === "aborted") trouble.timeout = true;
        continue;
      }
      if (listing.response.status >= 400 || sniffContent(listing.response.body, listing.response.contentType) !== "html") continue;
      const listed = extractPageFacts(decodeBody(listing.response.body, listing.response.contentType), listing.response.url);
      // The listing may name a dozen feeds; the ones about the pasted page are looked at first.
      await tryLinks(rankByPage(listed.links, page).slice(0, 6), true);
      if (found.length > 0) break;
    }
  }

  // Feeds that were only listed (a hub's, a directory's) say nothing about the page unless one of them is the page's own.
  if (found.some((f) => f.via !== "alternate" && f.via !== "path" && f.matches)) {
    for (let i = found.length - 1; i >= 0; i--) if ((found[i]!.via === "anchor" || found[i]!.via === "listed") && !found[i]!.matches) found.splice(i, 1);
  }

  if (found.length === 0) {
    const first = trouble.failure;
    if (first?.reason === "blocked") return first;
    if (unopened) return failFromStatus(inputUrl, unopened.status)!;
    if (ctx.spent()) return fail(inputUrl, "nofeed", CAP_MESSAGE);
    if (trouble.timeout || ctx.signal.aborted) return fail(inputUrl, "timeout", TIMEOUT_MESSAGE);
    if (trouble.busy) return fail(inputUrl, "unreachable", BUSY_MESSAGE);
    return fail(inputUrl, "nofeed", "We couldn't find a feed on that page. Try the site's blog or news page, or paste the feed address itself if you have it.");
  }

  const matching = new Set(found.filter((f) => f.matches).map((f) => f.c));
  const unique = dedupeCandidates(
    found.map((f) => f.c),
    found.map((f) => f.parsed),
  ).map((c) => {
    const matchesPage = matching.has(c);
    if (wholeSiteFeeds.has(c)) return { ...c, matchesPage, via: "Whole site feed", note: c.note ?? (ownFeedSilent ? WHOLE_SITE_FALLBACK_NOTE : WHOLE_SITE_NOTE) };
    if (isDiscourse(html) && /\/posts\.rss$/.test(new URL(c.feedUrl).pathname)) return { ...c, matchesPage, via: "All replies", note: "Includes every reply, so it is busy. Latest topics is usually what you want." };
    if (isDiscourse(html) && /\/latest\.rss$/.test(new URL(c.feedUrl).pathname)) return { ...c, matchesPage, via: "Latest topics" };
    return { ...c, matchesPage };
  });
  const ordered = orderByVia(withoutCommentFeeds(unique)).slice(0, max);
  return {
    ok: true,
    url: inputUrl,
    candidates: unopened
      ? ordered.map((c) => ({ ...c, note: [`${section ? "That page" : "The site's front page"} didn't open (error ${unopened.status}), but this feed does.`, c.note].filter(Boolean).join(" ") }))
      : ordered,
  };
}

/** The dependencies a known-service plan needs, bound to this discovery's budget and fetcher. */
function knownDeps(ctx: Ctx): KnownDeps {
  return {
    probe: async (feedUrl) => {
      const probe = await probeFeed(ctx, feedUrl, false);
      if (!("failed" in probe)) return probe;
      return { failed: probe.failed ? { reason: probe.failed.reason, message: probe.failed.message } : null, inconclusive: !!probe.inconclusive };
    },
    json: async (url) => {
      const res = await ctx.get(url, { maxBytes: 256 * 1024, accept: "application/json" });
      if (!res.ok) {
        const f = failFromFetch(url, res);
        return { ok: false, reason: f.reason, message: f.message };
      }
      const status = failFromStatus(url, res.response.status);
      if (status) return { ok: false, reason: status.reason, message: status.message };
      try {
        return { ok: true, data: JSON.parse(decodeBody(res.response.body, res.response.contentType)) };
      } catch {
        return { ok: false, reason: "unsupported", message: "That service answered with something we couldn't read." };
      }
    },
    candidate: (feedUrl, parsed, extra) => buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx, extra),
    unverified: (feed, service) => ({
      title: feed.title ?? service,
      kind: "feed",
      origin: feed.origin ?? `${service} feed`,
      via: feed.via ?? "Posts feed",
      feedUrl: feed.feedUrl,
      siteUrl: null,
      cadence: null,
      samples: [],
      summariesOnly: false,
      alreadyFollowingSourceId: null,
      privateWarning: null,
      note: `${service} didn't send recent posts just now. Following will keep trying.`,
    }),
  };
}


// ---------- social accounts ----------

const JRD_ACCEPT = "application/jrd+json, application/json;q=0.9";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const PROFILE_REL = "http://webfinger.net/rel/profile-page";
const FEDIVERSE_NO_FEED = "This account doesn't offer a public feed. Some servers only publish one when the account's owner turns it on.";
const FEDIVERSE_NOT_PROFILE = "That page doesn't offer a feed. If it's a post, paste the account's profile address or its @name@server handle instead.";

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
    const c = buildCandidate(probe.feedUrl, probe.parsed, { url: probe.feedUrl }, ctx, { origin: SOCIAL_ORIGIN[platform], via: "Posts feed" });
    candidates.push({ ...c, kind: "feed", title: meaningfulTitle(probe.parsed.title) ?? fallbackTitle ?? c.title, note: SOCIAL_NOTE[platform] });
  }
  if (candidates.length === 0) return fail(inputUrl, "nofeed", FEDIVERSE_NO_FEED);
  return { ok: true, url: inputUrl, candidates: candidates.slice(0, max) };
}

/** @name@server: WebFinger names the profile page, and the profile page names its feed. */
async function discoverFediverse(t: { user: string; domain: string }, ctx: Ctx, max: number, opts: DiscoverOptions): Promise<DiscoveryDraft> {
  const handle = `@${t.user}@${t.domain}`;
  const server = normalizeInput(`https://${t.domain}/`, { testAllowAddress: opts.testAllowAddress });
  if (!server.ok) return fail(handle, server.reason, server.message);
  const wf = await ctx.get(`https://${t.domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${t.user}@${t.domain}`)}`, { maxBytes: 64 * 1024, accept: JRD_ACCEPT });
  if (!wf.ok) return failFromFetch(handle, wf);
  if (wf.response.status === 404 || wf.response.status === 410) {
    return fail(handle, "nofeed", `We couldn't find ${handle}. Check the spelling; the part after the second @ is the account's server.`);
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
    return fail(handle, "invalid", `${t.domain} answered, but not with an account we could read. It may not be a fediverse server.`);
  }
  if (!profile) return fail(handle, "nofeed", `${t.domain} knows ${handle} but doesn't link a public profile, so there's no feed to follow.`);
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
  if (r.status === 403) return fail(label, "nofeed", "This Bluesky account asks apps not to show its posts to people who aren't signed in, so it can't be followed here.");
  if (r.status === 404) return fail(label, "nofeed", `We couldn't find ${label} on Bluesky. Check the handle, for example name.bsky.social.`);
  if (r.status === 400) return fail(label, "invalid", "That isn't a valid Bluesky handle. It looks like name.bsky.social or a web address such as example.com.");
  const status = failFromStatus(label, r.status);
  if (status) return status;
  if (!isFeedKind(sniffContent(r.body, r.contentType))) return fail(label, "unreachable", "Bluesky didn't send the account's feed just now. Try again in a moment.");
  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(r.body, r.contentType, { baseUrl: r.url });
  } catch (error) {
    if (error instanceof FeedParseError) return fail(label, "invalid", "Bluesky sent a feed we couldn't read. Try again later.");
    throw error;
  }
  const feedUrl = stableFeedUrl(requested, r.url);
  const c = buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx, { origin: SOCIAL_ORIGIN.bluesky, via: t.related ? "Related account — confirm" : "Posts feed" });
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

// ---------- bridged services ----------

export const BRIDGE_NOTE = "Collected by this server from the public page, as the latest posts at each check. It can stop working when the service changes its site.";

/** A bridged source (a Telegram channel, a Bandcamp artist…), previewed through the bridge router. */
async function discoverBridged(target: BridgeTarget, bridge: BridgeClient, ctx: Ctx, label: string): Promise<DiscoveryDraft> {
  const { service, key } = target;
  if (ctx.signal.aborted) return fail(label, "timeout", TIMEOUT_MESSAGE);
  const answer = await bridge(target, ctx.signal).catch(() => ({ failed: true }) as const);
  if (ctx.signal.aborted) return fail(label, "timeout", TIMEOUT_MESSAGE);
  if ("failed" in answer || answer.status !== 200) {
    return fail(label, "unreachable", `${service.name} didn't give us the posts of ${key} just now. Check the address, or try again in a few minutes.`);
  }
  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(answer.body, "application/rss+xml");
  } catch {
    return fail(label, "unreachable", `${service.name} didn't give us the posts of ${key} just now. Try again in a few minutes.`);
  }
  const candidate = buildCandidate(bridgeDescriptor(service.id, key), parsed, { url: service.pageUrl(key) }, ctx, { origin: service.origin, via: "Posts feed", note: BRIDGE_NOTE });
  return { ok: true, url: service.pageUrl(key), candidates: [{ ...candidate, siteUrl: service.pageUrl(key) }] };
}

/** Discover followable feeds for a pasted address. Never throws; every outcome is a result. */
export async function discover(input: string, opts: DiscoverOptions = {}): Promise<DiscoveryDraft> {
  // A bridged source's own address (from an export, say) is that source again.
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.startsWith("bridge:")) {
    const described = parseBridgeDescriptor(trimmed);
    if (!described || !opts.bridge) return fail(trimmed.slice(0, 200), "unsupported", "That source comes from a server bridge this installation doesn't run, so it can't be followed here.");
    return await discoverBridged(described, opts.bridge, makeCtx(opts), trimmed);
  }
  const social = typeof input === "string" ? classifySocialInput(input) : null;
  if (social) {
    const ctx = makeCtx(opts);
    try {
      return await discoverSocial(social, ctx, Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES), opts, input);
    } catch {
      return fail(input.slice(0, 200), "unreachable", "Something went wrong while looking up that account. Try again in a moment.");
    }
  }
  const norm = normalizeInput(input, { testAllowAddress: opts.testAllowAddress });
  if (!norm.ok) return fail(typeof input === "string" ? input.slice(0, 200) : "", norm.reason, norm.message);
  const ctx = makeCtx(opts);
  const max = Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES);
  try {
    const entry = new URL(norm.url);
    if (isYoutubeHost(entry.hostname)) {
      const draft = await discoverYoutube(norm, ctx, max);
      if (!draft.ok || draft.candidates.length > 0 || draft.keep) return draft;
      return fail(norm.url, "nofeed", "We couldn't find a feed for that YouTube address.");
    }
    // Pages of services this server follows through its bridge.
    const bridged = opts.bridge ? bridgeTargetForPage(entry) : null;
    if (bridged && opts.bridge) return await discoverBridged(bridged, opts.bridge, ctx, norm.url);
    // Services that publish no feeds are named as such, without asking them for one.
    const platform = noFeedPlatform(entry);
    if (platform) return fail(norm.url, "unsupported", platform.message);
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
    const first = await getWithUpgrade(ctx, norm.url, norm.httpFallback);
    if (!first.ok) return failFromFetch(norm.url, first);
    const response = first.response;
    const statusFail = failFromStatus(norm.url, response.status);
    if (statusFail) {
      // A front page that refuses automated readers (403) or is broken (5xx) often still serves its feed; look at the usual addresses before giving up.
      if ((response.status === 403 || response.status >= 500) && !ctx.signal.aborted) {
        const rescued = await discoverFromPage(ctx, response.url, "", max, norm.url, prior, { status: response.status });
        if (rescued.ok) return rescued;
      }
      return statusFail;
    }
    const kind = sniffContent(response.body, response.contentType);
    if (isFeedKind(kind)) {
      let parsed: ParsedFeed;
      try {
        parsed = parseFeed(response.body, response.contentType, { baseUrl: response.url });
      } catch (error) {
        if (error instanceof FeedParseError) {
          return fail(norm.url, "invalid", error.code === "toolarge" ? "That feed is too large for us to read safely." : "That address looks like a feed, but we couldn't read it. The feed may be damaged.");
        }
        throw error;
      }
      // A YouTube feed pasted directly is still a YouTube source.
      const feedUrl = stableFeedUrl(norm.url, response.url);
      const candidate = buildCandidate(feedUrl, parsed, { url: feedUrl }, ctx);
      return { ok: true, url: norm.url, candidates: [candidate] };
    }
    if (kind === "html") {
      return await discoverFromPage(ctx, response.url, decodeBody(response.body, response.contentType), max, norm.url, prior);
    }
    if (kind === "xml") {
      const text = decodeBody(response.body.subarray(0, 4096), response.contentType);
      if (/<opml[\s>]/i.test(text)) return fail(norm.url, "unsupported", "That looks like an OPML list of subscriptions, not a single feed. Use Import to add the feeds in it.");
      if (/<urlset[\s>]|<sitemapindex[\s>]/i.test(text)) return fail(norm.url, "unsupported", "That's a sitemap, not a feed. Try the site's main page.");
      return fail(norm.url, "unsupported", "That address returns XML that isn't a feed we can read.");
    }
    if (kind === "json") return fail(norm.url, "unsupported", "That address returns data, not a feed. A JSON Feed has \"version\": \"https://jsonfeed.org/version/1.1\".");
    return fail(norm.url, "unsupported", "That address isn't a web page or a feed (it looks like a file). Paste a website or feed address.");
  } catch (error) {
    // Programming errors must not leak details or secrets into the user message.
    return fail(norm.url, "unreachable", `Something went wrong while checking ${redactUrl(norm.url)}. Try again in a moment.`);
  }
}
