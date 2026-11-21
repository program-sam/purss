import { server } from "@purss/copy/server";
import type { ParsedFeed } from "./feed.ts";
import type { KnownPlan } from "./known-feeds.ts";

const feedLabels = server.sources.connectors.labels;

/*
 * Profile and page addresses of services that publish a native feed at a predictable address: a Steam game's news,
 * an arXiv listing, a Dailymotion, Odysee or PeerTube channel, a DeviantArt gallery, a Behance profile, and the news pages of
 * NOS, the BBC, the European Commission's Press Corner and Rijksoverheid. Each plan
 * only rewrites the pasted address into the feed address; the feed is then fetched and checked like any other
 * (known-feeds.ts), and an address that turns out not to have one goes through ordinary discovery as before.
 * Reserved first path segments (site pages such as /search or /settings) never name an account.
 */

export const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/\.$/, "");
export const segmentsOf = (url: URL): string[] => url.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
export const isHostOrSub = (h: string, base: string): boolean => h === base || h.endsWith(`.${base}`);

const RESERVED_DAILYMOTION = new Set([
  "video", "playlist", "playlists", "search", "library", "upload", "settings", "notifications", "about", "help", "legal", "terms", "privacy", "countries", "explore", "discover", "live",
  "trending", "topic", "topics", "channel", "channels", "partner", "publisher", "creators", "advertisers", "signin", "login", "signup", "register", "embed", "player", "rss", "oembed",
]);
const RESERVED_DEVIANTART = new Set([
  "tag", "tags", "search", "watch", "daily-deviations", "popular", "popular-all-time", "topic", "topics", "about", "shop", "core-membership", "join", "users", "settings", "notifications",
  "messages", "groups", "forum", "critiques", "journals", "status", "cart", "checkout", "today", "undiscovered", "newest", "contests", "browse", "login", "signup", "developers",
  "team", "careers", "press", "help", "studio", "sitemap", "mobile", "deviation", "art", "stash", "chat", "notes", "premium", "support", "wiki", "oauth2",
]);
const RESERVED_BEHANCE = new Set([
  "gallery", "galleries", "collection", "collections", "search", "joblist", "jobs", "hire", "about", "assets", "live", "blog", "misc", "onboarding", "settings", "notifications", "signup",
  "login", "feeds", "portfolio", "moodboard", "moodboards", "services", "discover", "following", "appreciated", "projects", "wip", "adobe", "creativecloud", "careers", "advertise",
  "privacy", "terms", "help", "community", "report", "tos", "support", "sitemap", "posts", "assignments", "talent", "creatives", "featured", "pro", "mobile", "downloads",
]);

/** A game's news on Steam's store: `/app/<id>/<Name>/`. The feed carries only the number, so the name comes from the address when it has one. */
function steam(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const id = s[1] ?? "";
  if (s[0] !== "app" || !/^\d{1,9}$/.test(id)) return null;
  const name = /^[\w.%'-]{1,100}$/.test(s[2] ?? "") ? s[2]!.replace(/_+/g, " ").trim() : "";
  return { service: "Steam", route: "known:steam", feeds: [{ feedUrl: `https://store.steampowered.com/feeds/news/app/${id}/`, title: server.sources.connectors.services.steamNews(name || server.sources.connectors.services.steamApp(id)), via: feedLabels.postsFeed, origin: server.sources.connectors.services.steamOrigin }] };
}

/** A listing (`/list/cs.LG/recent`): the category's daily announcements. The feed is empty on days arXiv announces nothing. */
function arxiv(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const category = s[1] ?? "";
  if (s[0] !== "list" || !/^[a-z][a-z-]{1,24}(?:\.[A-Za-z][A-Za-z-]{0,24})?$/.test(category)) return null;
  return {
    service: "arXiv",
    route: "known:arxiv",
    feeds: [{
      feedUrl: `https://rss.arxiv.org/rss/${category}`,
      via: feedLabels.postsFeed,
      origin: server.sources.connectors.services.arxivOrigin,
      emptyNote: server.sources.connectors.services.arxivEmptyNote,
    }],
  };
}

function dailymotion(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (s.length !== 1 || !/^[A-Za-z0-9_.-]{3,60}$/.test(name) || RESERVED_DAILYMOTION.has(name.toLowerCase())) return null;
  return { service: "Dailymotion", route: "known:dailymotion", feeds: [{ feedUrl: `https://www.dailymotion.com/rss/user/${encodeURIComponent(name)}`, title: server.sources.connectors.services.dailymotionTitle(name), via: feedLabels.channelFeed, origin: server.sources.connectors.services.dailymotionOrigin }] };
}

/**
 * A channel carries its claim id after a colon (`@name:5`), which is how Odysee's own links write it, and the feed
 * wants the id too: it answers a bare `@name` with "Invalid URL". A bare name is left to ordinary discovery.
 */
function odysee(url: URL): KnownPlan | null {
  const channel = /^@([^\s/\\?#:@]{1,80}):([0-9a-f]{1,40})$/i.exec(segmentsOf(url)[0] ?? "");
  if (!channel) return null;
  return { service: "Odysee", route: "known:odysee", feeds: [{ feedUrl: `https://odysee.com/$/rss/@${encodeURIComponent(channel[1]!)}:${channel[2]}`, via: feedLabels.channelFeed, origin: server.sources.connectors.services.odyseeOrigin }] };
}

/** A profile (`/name`) or its gallery (`/name/gallery`). The backend answers an empty feed for a name it doesn't know, so only a gallery with entries counts. */
function deviantart(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(name) || RESERVED_DEVIANTART.has(name.toLowerCase())) return null;
  const gallery = s.length === 1 || (s[1] === "gallery" && (s.length === 2 || (s.length === 3 && s[2] === "all")));
  if (!gallery) return null;
  return { service: "DeviantArt", route: "known:deviantart", feeds: [{ feedUrl: `https://backend.deviantart.com/rss.xml?q=gallery:${name}`, via: feedLabels.galleryFeed, origin: server.sources.connectors.services.deviantartOrigin, needsItems: true }] };
}

const PEERTUBE_TABS = new Set(["videos", "video-channels", "video-playlists", "about", "channels", "playlists"]);

/**
 * An account (`/a/name`) or channel (`/c/name`) page. PeerTube runs on any domain, so only the address shape says so, and
 * another kind of site may use the same shape (Discourse has /c/ for categories): the feed counts only when PeerTube made it.
 */
function peertube(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const kind = s[0];
  if ((kind !== "a" && kind !== "c") || !/^[A-Za-z0-9._:-]{1,50}(?:@[A-Za-z0-9.-]{1,200})?$/.test(s[1] ?? "")) return null;
  if (s.length > 3 || (s.length === 3 && !PEERTUBE_TABS.has(s[2]!))) return null;
  const param = kind === "a" ? "accountName" : "videoChannelName";
  return {
    service: "PeerTube",
    route: "known:peertube",
    feeds: [{
      feedUrl: `${url.origin}/feeds/videos.xml?${param}=${encodeURIComponent(s[1]!)}`,
      via: feedLabels.channelFeed,
      origin: kind === "a" ? server.sources.connectors.services.peertubeAccountOrigin : server.sources.connectors.services.peertubeChannelOrigin,
      generator: /^PeerTube\b/i,
    }],
  };
}

function behance(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (s.length !== 1 || !/^[A-Za-z0-9_-]{2,40}$/.test(name) || RESERVED_BEHANCE.has(name.toLowerCase())) return null;
  return { service: "Behance", route: "known:behance", feeds: [{ feedUrl: `https://www.behance.net/feeds/user?username=${encodeURIComponent(name)}`, via: feedLabels.projectsFeed, origin: server.sources.connectors.services.behanceOrigin }] };
}

/**
 * NOS (the Dutch public broadcaster): its pages carry no feed link, and its feeds live on `feeds.nos.nl`. The front page and its news and sport
 * pages are the whole news and the whole sport feed, and a section's page its own; each address was checked to answer with that section's feed.
 */
const NOS_SECTIONS: Record<string, { feed: string; title: string }> = {
  "": { feed: "nosnieuwsalgemeen", title: "NOS Nieuws" },
  nieuws: { feed: "nosnieuwsalgemeen", title: "NOS Nieuws" },
  "nieuws/laatste": { feed: "nosnieuwsalgemeen", title: "NOS Nieuws" },
  "nieuws/binnenland": { feed: "nosnieuwsbinnenland", title: "NOS Binnenland" },
  "nieuws/buitenland": { feed: "nosnieuwsbuitenland", title: "NOS Buitenland" },
  "nieuws/economie": { feed: "nosnieuwseconomie", title: "NOS Economie" },
  "nieuws/tech": { feed: "nosnieuwstech", title: "NOS Tech" },
  sport: { feed: "nossportalgemeen", title: "NOS Sport" },
  "sport/laatste": { feed: "nossportalgemeen", title: "NOS Sport" },
  "sport/voetbal": { feed: "nosvoetbal", title: "NOS Voetbal" },
};

function nos(url: URL): KnownPlan | null {
  const section = NOS_SECTIONS[segmentsOf(url).join("/").toLowerCase()];
  if (!section) return null;
  return { service: "NOS", route: "known:nos", feeds: [{ feedUrl: `https://feeds.nos.nl/${section.feed}`, title: section.title, via: feedLabels.postsFeed, origin: "NOS" }] };
}

/**
 * The BBC: its news and sport pages and its language services carry no feed link, and their feeds live on `feeds.bbci.co.uk` under the
 * page's own path (`/news/technology` → `feeds.bbci.co.uk/news/technology/rss.xml`). Pages that are not a section (an article, a live page,
 * a topic, iPlayer) have none and are left to the page search; a section without a feed answers 404 there and is left to it too.
 */
const BBC_NOT_SECTIONS = new Set(["articles", "live", "videos", "av", "topics", "programmes", "iplayer", "sounds", "search", "weather", "usingthebbc", "aboutthebbc"]);

/** Every section's feed is titled "BBC News" or "BBC Sport"; its description names the section ("BBC News - Technology"). */
function bbcTitle(title: string | null, feed: ParsedFeed): string | null {
  const section = title && feed.description?.startsWith(`${title} - `) ? feed.description.slice(title.length + 3).trim() : "";
  // A language service's description is a tagline of its own ("BBC Mundo - Noticias - BBC News Mundo"): its title is name enough.
  return section && !section.includes(" - ") ? `${title} – ${section}` : null;
}

function bbc(url: URL): KnownPlan | null {
  const s = segmentsOf(url).map((x) => x.toLowerCase());
  if (s.length === 0 || s.length > 4 || s.some((x) => !/^[a-z][a-z0-9_-]*$/.test(x) || /\d{5,}/.test(x) || BBC_NOT_SECTIONS.has(x))) return null;
  return { service: "BBC", route: "known:bbc", feeds: [{ feedUrl: `https://feeds.bbci.co.uk/${s.join("/")}/rss.xml`, retitle: bbcTitle, via: feedLabels.postsFeed, origin: "BBC" }] };
}

/**
 * The European Commission's Press Corner builds its list in the browser and links no feed, but its own script reads the press releases from
 * a feed at `/commission/presscorner/api/rss`, in the language the address names.
 */
function presscorner(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  if (s[0] !== "commission" || s[1] !== "presscorner") return null;
  const language = s.slice(2).reverse().find((x) => /^[a-z]{2}$/.test(x)) ?? "en";
  return { service: "European Commission", route: "known:presscorner", feeds: [{ feedUrl: `https://ec.europa.eu/commission/presscorner/api/rss?language=${language}`, title: "European Commission Press Corner", via: feedLabels.postsFeed, origin: "European Commission" }] };
}

/**
 * Rijksoverheid (the Dutch government): its news page links no feed, and its "RSS-link kopiëren" button makes the address of a search feed in the
 * browser. The whole news list is that search with only the news filter; the old `feeds.rijksoverheid.nl` feeds now carry a notice that they stopped.
 */
const RIJKSOVERHEID_NEWS = "https://www.rijksoverheid.nl/api/rss?query=" + encodeURIComponent(JSON.stringify({ filters: [{ field: "content_type", values: ["pro:newsDocument"], type: "all" }], resultSearchTerm: "", pageTitle: "Nieuws" }));

function rijksoverheid(url: URL): KnownPlan | null {
  const path = segmentsOf(url).join("/").toLowerCase();
  if (path !== "" && path !== "actueel" && path !== "actueel/nieuws") return null;
  return { service: "Rijksoverheid", route: "known:rijksoverheid", feeds: [{ feedUrl: RIJKSOVERHEID_NEWS, title: "Rijksoverheid Nieuws", via: feedLabels.postsFeed, origin: "Rijksoverheid" }] };
}

/** The feed addresses to try for a page address of one of these services, or null. */
export function planServiceFeeds(url: URL): KnownPlan | null {
  const h = hostOf(url);
  if (h === "store.steampowered.com") return steam(url);
  if (h === "arxiv.org" || h === "www.arxiv.org") return arxiv(url);
  if (h === "dailymotion.com" || h === "www.dailymotion.com") return dailymotion(url);
  if (h === "odysee.com" || h === "www.odysee.com") return odysee(url);
  if (h === "deviantart.com" || h === "www.deviantart.com") return deviantart(url);
  if (h === "behance.net" || h === "www.behance.net") return behance(url);
  if (h === "nos.nl" || h === "www.nos.nl") return nos(url);
  if (h === "bbc.com" || h === "www.bbc.com" || h === "bbc.co.uk" || h === "www.bbc.co.uk") return bbc(url);
  if (h === "ec.europa.eu") return presscorner(url);
  if (h === "rijksoverheid.nl" || h === "www.rijksoverheid.nl") return rijksoverheid(url);
  return peertube(url);
}
