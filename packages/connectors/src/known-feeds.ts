import type { DraftCandidate } from "./discover.ts";
import type { ParsedFeed } from "./feed.ts";
import { WHOLE_SITE_FALLBACK_NOTE, WHOLE_SITE_NOTE, isSiteWideFeed } from "./feed-choice.ts";
import { hostOf as host, isHostOrSub, planServiceFeeds, segmentsOf as segments } from "./services.ts";

/*
 * Services whose feed addresses follow a fixed pattern, so a pasted page address can be turned
 * into the feed address without guessing: a subreddit, a GitHub repository, a Substack, a
 * Medium writer, a Tumblr or Blogger blog, a Vimeo channel, a Pinterest board, an Apple
 * Podcasts show, and the profile and page addresses of services.ts. Only the address is rewritten;
 * everything is then fetched and checked like any other feed (safeFetch, the address rules and the
 * redirect checks), and nothing is executed. The plan is pure: it decides which feed addresses to
 * try and what to call them.
 */

export type KnownReason = "invalid" | "blocked" | "unreachable" | "nofeed" | "unsupported" | "toolarge" | "timeout";

export type KnownFeed = {
  feedUrl: string;
  /** Name to use whatever the feed calls itself ("r/modeltrains"). */
  title?: string;
  via?: string;
  origin?: string;
  /** The feed of the very section (category, label) the pasted page is, as opposed to the whole site's. */
  section?: boolean;
  /** The feed the page is really about when several answer (a series page's podcast): offered first and preselected. */
  lead?: boolean;
  /** Said of this feed when a `lead` feed answered too. */
  alsoNote?: string;
  /** Said of this feed when it answers with no entries (a listing that is only filled on some days). */
  emptyNote?: string;
  /** The feed counts only with entries: the service answers an empty feed for a name it doesn't know. */
  needsItems?: boolean;
  /** The feed counts only when its generator matches: the address shape alone doesn't say which software runs the site. */
  generator?: RegExp;
};

export type KnownPlan =
  | {
      service: string;
      feeds: KnownFeed[];
      /** Offer the feed with a note when the service is only busy or limiting requests right now. */
      tolerateBusy?: boolean;
    }
  | { service: "Apple Podcasts"; lookup: { id: string; country: string | null } };

const FEED_LIKE_PATH = /(?:^|\/)(?:feed|feeds|rss|atom)(?:\/|\.|$)|\.(?:rss|atom|xml)$/i;

const RESERVED_GITHUB = new Set([
  "orgs", "settings", "marketplace", "topics", "explore", "features", "pricing", "about", "login", "signup", "join", "sponsors", "notifications", "new", "search", "apps", "collections",
  "trending", "enterprise", "customer-stories", "readme", "security", "site", "contact", "pulls", "issues", "codespaces", "organizations", "users", "events", "gist", "mobile", "git-guides", "team",
  "solutions", "resources", "premium-support", "logout", "dashboard", "stars", "copilot", "account", "assets", "sessions", "discussions", "models", "pages", "watching", "password_reset",
]);
const RESERVED_MEDIUM = new Set(["m", "tag", "topics", "search", "me", "plans", "membership", "about", "creators", "help", "policy", "jobs", "new-story", "p", "feed", "partner-program", "gift", "signin", "login"]);
const RESERVED_SUBSTACK = new Set(["www", "open", "support", "on", "api", "substack", "go", "email", "help"]);
const RESERVED_TUMBLR = new Set(["www", "api", "assets", "static", "at", "media", "tumblr", "dashboard", "explore", "tagged", "search", "settings", "login", "register", "likes", "following", "blog", "new", "inbox", "themes", "about", "privacy", "policy", "docs", "help", "jobs", "press", "apps", "tag"]);
const RESERVED_VIMEO = new Set([
  "channels", "groups", "categories", "watch", "ondemand", "features", "search", "upload", "blog", "enterprise", "stock", "log_in", "join", "about", "help", "music", "staffpicks", "couchmode",
  "solutions", "pricing", "plans", "watchlater", "api", "manage", "settings", "home", "live", "everywhere", "create", "tv", "business",
]);
const RESERVED_PINTEREST = new Set(["pin", "ideas", "search", "today", "business", "settings", "explore", "topics", "news_hub", "shop", "video", "login", "about", "help", "_", "create", "following", "watch"]);

function reddit(url: URL): KnownPlan | null {
  const s = segments(url);
  const kind = (s[0] ?? "").toLowerCase();
  const name = s[1] ?? "";
  if (kind === "r" && /^[A-Za-z0-9_]{2,21}$/.test(name) && (s.length === 2 || (s.length === 3 && /^(?:hot|new|top|rising|best|controversial)$/i.test(s[2]!)))) {
    return { service: "Reddit", tolerateBusy: true, feeds: [{ feedUrl: `https://www.reddit.com/r/${name}/.rss`, title: `r/${name}`, via: "Posts feed", origin: "Reddit feed" }] };
  }
  if ((kind === "user" || kind === "u") && /^[A-Za-z0-9_-]{3,20}$/.test(name) && (s.length === 2 || (s.length === 3 && /^(?:submitted|overview|posts)$/i.test(s[2]!)))) {
    return { service: "Reddit", tolerateBusy: true, feeds: [{ feedUrl: `https://www.reddit.com/user/${name}/.rss`, title: `u/${name}`, via: "Posts feed", origin: "Reddit feed" }] };
  }
  return null;
}

function github(url: URL): KnownPlan | null {
  const s = segments(url);
  const owner = s[0] ?? "";
  const repo = (s[1] ?? "").replace(/\.git$/, "");
  if (!owner || RESERVED_GITHUB.has(owner.toLowerCase()) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  // A user or organisation page: its public activity.
  if (s.length === 1) return { service: "GitHub", feeds: [{ feedUrl: `https://github.com/${owner}.atom`, title: `${owner} activity`, via: "Activity feed", origin: "GitHub activity" }] };
  if (!repo || !/^[\w.-]{1,100}$/.test(repo)) return null;
  const base = `https://github.com/${owner}/${repo}`;
  return {
    service: "GitHub",
    feeds: [
      { feedUrl: `${base}/releases.atom`, title: `${owner}/${repo} releases`, via: "Releases feed", origin: "GitHub releases" },
      { feedUrl: `${base}/tags.atom`, title: `${owner}/${repo} tags`, via: "Tags feed", origin: "GitHub tags" },
    ],
  };
}

function applePodcasts(url: URL): KnownPlan | null {
  const id = /\/id(\d{5,12})(?:$|[/?#])/.exec(`${url.pathname}/`)?.[1];
  if (!id || !/\/podcast\//.test(url.pathname)) return null;
  const first = segments(url)[0] ?? "";
  return { service: "Apple Podcasts", lookup: { id, country: /^[a-z]{2}$/.test(first) ? first : null } };
}

/**
 * A Guardian series page (`/football/series/footballweekly`) advertises only the series' articles. When the series is a
 * podcast, the show itself is the `podcast.xml` next to it, and that is what someone who pasted the page wants.
 */
function guardian(url: URL): KnownPlan | null {
  const s = segments(url);
  if (s.length !== 3 || s[1] !== "series" || !/^[a-z0-9-]{1,60}$/i.test(s[0]!) || !/^[a-z0-9-]{1,80}$/i.test(s[2]!)) return null;
  const base = `https://www.theguardian.com/${s[0]}/series/${s[2]}`;
  return {
    service: "The Guardian",
    feeds: [
      { feedUrl: `${base}/podcast.xml`, via: "Podcast feed", origin: "Podcast feed", lead: true },
      { feedUrl: `${base}/rss`, via: "Posts feed", alsoNote: "The show's articles and video pages, without the audio. Choose the podcast feed above to listen." },
    ],
  };
}

function simple(service: string, feedUrl: string, via = "Posts feed"): KnownPlan {
  return { service, feeds: [{ feedUrl, via }] };
}

function substack(url: URL): KnownPlan | null {
  const label = host(url).slice(0, -".substack.com".length);
  if (!/^[a-z0-9-]{1,63}$/.test(label) || RESERVED_SUBSTACK.has(label)) return null;
  return simple("Substack", `https://${label}.substack.com/feed`);
}

function medium(url: URL): KnownPlan | null {
  const h = host(url);
  if (h !== "medium.com" && h !== "www.medium.com") {
    const label = h.slice(0, -".medium.com".length);
    return /^[a-z0-9-]{1,63}$/.test(label) && label !== "www" && label !== "cdn-images-1" ? simple("Medium", `https://${label}.medium.com/feed`) : null;
  }
  const first = segments(url)[0] ?? "";
  if (!first || RESERVED_MEDIUM.has(first.toLowerCase())) return null;
  if (!/^@?[A-Za-z0-9._-]{1,60}$/.test(first)) return null;
  return simple("Medium", `https://medium.com/feed/${first.startsWith("@") ? `@${encodeURIComponent(first.slice(1))}` : encodeURIComponent(first)}`);
}

function tumblr(url: URL): KnownPlan | null {
  const h = host(url);
  let label = "";
  if (h === "www.tumblr.com" || h === "tumblr.com") label = segments(url)[0] ?? "";
  else label = h.slice(0, -".tumblr.com".length);
  if (!/^[A-Za-z0-9-]{1,32}$/.test(label) || RESERVED_TUMBLR.has(label.toLowerCase())) return null;
  return simple("Tumblr", `https://${label.toLowerCase()}.tumblr.com/rss`);
}

/** The path after `/<prefix>/`, up to a pagination or feed marker, as a feed path; null when there is none. */
function sectionTail(s: string[], from: number): string | null {
  const tail: string[] = [];
  for (const part of s.slice(from)) {
    if (part === "page" || part === "feed") break;
    if (!/^[^/\\?#]{1,100}$/.test(part)) return null;
    tail.push(encodeURIComponent(part));
  }
  return tail.length && tail.length <= 3 ? tail.join("/") : null;
}

function blogger(url: URL): KnownPlan | null {
  const h = host(url);
  const m = /^([a-z0-9-]{1,63})\.(blogspot\.[a-z]{2,3}(?:\.[a-z]{2})?)$/.exec(h);
  if (!m || m[1] === "www") return null;
  const base = `https://${m[1]}.${m[2]}/feeds/posts/default`;
  const s = segments(url);
  const label = s[0] === "search" && s[1] === "label" ? sectionTail(s, 2) : null;
  // A label page has a feed of its own, which comes before the whole blog's.
  if (label && !label.includes("/")) return { service: "Blogger", feeds: [{ feedUrl: `${base}/-/${label}`, via: "Section feed", section: true }, { feedUrl: base, via: "Posts feed" }] };
  return simple("Blogger", base);
}

function wordpressCom(url: URL): KnownPlan | null {
  const label = host(url).slice(0, -".wordpress.com".length);
  if (!/^[a-z0-9-]{1,63}$/.test(label) || label === "www" || label === "en" || label === "wordpress") return null;
  const base = `https://${label}.wordpress.com`;
  const s = segments(url);
  const kind = (s[0] ?? "").toLowerCase();
  const tail = kind === "category" || kind === "tag" || kind === "author" ? sectionTail(s, 1) : null;
  // A category, tag or author page has a feed of its own, which comes before the whole blog's.
  if (tail) return { service: "WordPress", feeds: [{ feedUrl: `${base}/${kind}/${tail}/feed/`, via: "Section feed", section: true }, { feedUrl: `${base}/feed/`, via: "Posts feed" }] };
  return simple("WordPress", `${base}/feed/`);
}

function vimeo(url: URL): KnownPlan | null {
  const s = segments(url);
  const first = (s[0] ?? "").toLowerCase();
  if ((first === "channels" || first === "groups") && /^[A-Za-z0-9_-]{1,60}$/.test(s[1] ?? "")) return simple("Vimeo", `https://vimeo.com/${first}/${s[1]}/videos/rss`, "Channel feed");
  if (!first || RESERVED_VIMEO.has(first) || /^\d+$/.test(first) || !/^[A-Za-z0-9_-]{1,60}$/.test(s[0]!)) return null;
  return simple("Vimeo", `https://vimeo.com/${s[0]}/videos/rss`, "Channel feed");
}

function pinterest(url: URL): KnownPlan | null {
  const s = segments(url);
  const user = s[0] ?? "";
  if (!/^[A-Za-z0-9_]{3,30}$/.test(user) || RESERVED_PINTEREST.has(user.toLowerCase())) return null;
  const board = s[1] ?? "";
  if (board && !board.startsWith("_") && board.length <= 120) {
    return simple("Pinterest", `https://www.pinterest.com/${user}/${encodeURIComponent(board)}.rss`);
  }
  return simple("Pinterest", `https://www.pinterest.com/${user}/feed.rss`);
}

/** The feed addresses to try for a page address of a known service, or null. */
export function planKnownFeeds(url: URL): KnownPlan | null {
  const h = host(url);
  if (FEED_LIKE_PATH.test(url.pathname) && !/(?:^|\.)reddit\.com$/.test(h)) return null;
  if (isHostOrSub(h, "reddit.com")) return reddit(url);
  if (h === "theguardian.com" || h === "www.theguardian.com") return guardian(url);
  if (h === "github.com" || h === "www.github.com") return github(url);
  if (h === "podcasts.apple.com" || h === "itunes.apple.com") return applePodcasts(url);
  if (isHostOrSub(h, "substack.com") && h !== "substack.com") return substack(url);
  if (isHostOrSub(h, "medium.com")) return medium(url);
  if (isHostOrSub(h, "tumblr.com")) return tumblr(url);
  if (/\.blogspot\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(h)) return blogger(url);
  if (h.endsWith(".wordpress.com")) return wordpressCom(url);
  if (h === "vimeo.com" || h === "www.vimeo.com") return vimeo(url);
  if (/(?:^|\.)pinterest\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(h)) return pinterest(url);
  return planServiceFeeds(url);
}

// ---------- resolving a plan ----------

export type KnownProbe =
  | { feedUrl: string; parsed: ParsedFeed }
  /** `inconclusive`: it timed out, was limited or failed on the service's side, so nothing is known about the feed. */
  | { failed: { reason: KnownReason; message: string } | null; inconclusive: boolean };

export type KnownDeps = {
  probe: (feedUrl: string) => Promise<KnownProbe>;
  json: (url: string) => Promise<{ ok: true; data: unknown } | { ok: false; reason: KnownReason; message: string }>;
  candidate: (feedUrl: string, parsed: ParsedFeed, extra: { title?: string; via?: string; origin?: string; note?: string }) => DraftCandidate;
  /** A candidate for a feed that did not answer (no preview). */
  unverified: (feed: KnownFeed, service: string) => DraftCandidate;
};

/**
 * `trouble`: nothing was found, but the feed addresses timed out or the service was busy, so nothing is known about
 * them. Ordinary discovery carries on, and if it finds nothing either it reports the trouble, not "no feed".
 */
export type KnownOutcome =
  | { candidates: DraftCandidate[] }
  | { failure: { reason: KnownReason; message: string } }
  | { trouble: { timeout: boolean; busy: boolean } }
  | null;

export const APPLE_NO_FEED = "Apple Podcasts doesn't list a public feed for that show, so it can't be followed from here. Try the show's own website, or search for it by name in a podcast app.";

function firstFeedUrl(data: unknown): string | null {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const u = (r as { feedUrl?: unknown } | null)?.feedUrl;
    if (typeof u === "string" && /^https?:\/\//i.test(u) && u.length <= 2000) return u;
  }
  return null;
}

/** A feed that answered but is not the one asked for (not the expected software, or empty where emptiness means an unknown name) counts as having no feed there. */
function counted(feed: KnownFeed, probe: KnownProbe): KnownProbe {
  if (!("feedUrl" in probe)) return probe;
  if (feed.generator && !feed.generator.test(probe.parsed.generator ?? "")) return { failed: null, inconclusive: false };
  if (feed.needsItems && probe.parsed.items.length === 0) return { failed: null, inconclusive: false };
  return probe;
}

/**
 * Fetch the planned feeds. Returns the candidates that answered; a failure worth showing (a service that
 * lists no feed, a blocked address); the trouble the feeds were in, when they did not answer; or null when
 * nothing came of it, so ordinary discovery carries on. `pageUrl` is the address that was pasted: a feed for the
 * whole site, found from a page inside the site, says so, and a page's own section feed comes before it.
 */
export async function resolveKnown(plan: KnownPlan, deps: KnownDeps, pageUrl: string): Promise<KnownOutcome> {
  if ("lookup" in plan) {
    const { id, country } = plan.lookup;
    const found = await deps.json(`https://itunes.apple.com/lookup?id=${id}&entity=podcast${country ? `&country=${country}` : ""}`);
    if (!found.ok) return { failure: { reason: found.reason, message: found.message } };
    const feedUrl = firstFeedUrl(found.data);
    if (!feedUrl) return { failure: { reason: "unsupported", message: APPLE_NO_FEED } };
    const probe = await deps.probe(feedUrl);
    if ("feedUrl" in probe) return { candidates: [deps.candidate(probe.feedUrl, probe.parsed, { via: "Podcast feed", origin: "Podcast feed" })] };
    if (probe.failed) return { failure: probe.failed };
    return { failure: { reason: "unsupported", message: APPLE_NO_FEED } };
  }
  const probes = (await Promise.all(plan.feeds.map((f) => deps.probe(f.feedUrl)))).map((probe, i) => counted(plan.feeds[i]!, probe));
  const sectionAsked = plan.feeds.some((f) => f.section);
  const sectionAnswered = plan.feeds.some((f, i) => f.section && "feedUrl" in probes[i]!);
  const candidates: DraftCandidate[] = [];
  let blocked: { reason: KnownReason; message: string } | null = null;
  const trouble = { timeout: false, busy: false };
  const leadAnswered = plan.feeds.some((f, i) => f.lead && "feedUrl" in probes[i]!);
  plan.feeds.forEach((feed, i) => {
    const probe = probes[i]!;
    if ("feedUrl" in probe) {
      // Judged by what was asked for, not by where the answer ended up (a blog's feed often lives on another host).
      const wholeSite = !feed.section && (sectionAsked || isSiteWideFeed(feed.feedUrl, pageUrl));
      const c = deps.candidate(probe.feedUrl, probe.parsed, wholeSite
        ? { title: feed.title, via: "Whole site feed", origin: feed.origin, note: sectionAsked && !sectionAnswered ? WHOLE_SITE_FALLBACK_NOTE : WHOLE_SITE_NOTE }
        : { title: feed.title, via: feed.via, origin: feed.origin, ...(leadAnswered && feed.alsoNote ? { note: feed.alsoNote } : feed.emptyNote && probe.parsed.items.length === 0 ? { note: feed.emptyNote } : {}) });
      // When one feed is the page's own, say which.
      candidates.push(leadAnswered ? { ...c, matchesPage: !!feed.lead } : c);
    } else if (probe.failed?.reason === "blocked") {
      blocked ??= probe.failed;
    } else if (probe.inconclusive && plan.tolerateBusy) {
      candidates.push(deps.unverified(feed, plan.service));
    } else if (probe.inconclusive) {
      if (probe.failed?.reason === "timeout") trouble.timeout = true;
      else trouble.busy = true;
    }
  });
  if (candidates.length) return { candidates };
  if (blocked) return { failure: blocked };
  return trouble.timeout || trouble.busy ? { trouble } : null;
}
