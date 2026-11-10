import type { KnownPlan } from "./known-feeds.ts";

/*
 * Profile and page addresses of services that publish a native feed at a predictable address: a Steam game's news,
 * an arXiv listing, a Dailymotion, Odysee or PeerTube channel, a DeviantArt gallery, a Behance profile. Each plan
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
  return { service: "Steam", feeds: [{ feedUrl: `https://store.steampowered.com/feeds/news/app/${id}/`, title: `${name || `Steam app ${id}`} news`, via: "Posts feed", origin: "Steam news" }] };
}

/** A listing (`/list/cs.LG/recent`): the category's daily announcements. The feed is empty on days arXiv announces nothing. */
function arxiv(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const category = s[1] ?? "";
  if (s[0] !== "list" || !/^[a-z][a-z-]{1,24}(?:\.[A-Za-z][A-Za-z-]{0,24})?$/.test(category)) return null;
  return {
    service: "arXiv",
    feeds: [{
      feedUrl: `https://rss.arxiv.org/rss/${category}`,
      via: "Posts feed",
      origin: "arXiv listing",
      emptyNote: "arXiv announces new papers on weekdays, so this feed is empty at weekends and fills again on Monday.",
    }],
  };
}

function dailymotion(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (s.length !== 1 || !/^[A-Za-z0-9_.-]{3,60}$/.test(name) || RESERVED_DAILYMOTION.has(name.toLowerCase())) return null;
  return { service: "Dailymotion", feeds: [{ feedUrl: `https://www.dailymotion.com/rss/user/${encodeURIComponent(name)}`, title: `${name} on Dailymotion`, via: "Channel feed", origin: "Dailymotion channel" }] };
}

/**
 * A channel carries its claim id after a colon (`@name:5`), which is how Odysee's own links write it, and the feed
 * wants the id too: it answers a bare `@name` with "Invalid URL". A bare name is left to ordinary discovery.
 */
function odysee(url: URL): KnownPlan | null {
  const channel = /^@([^\s/\\?#:@]{1,80}):([0-9a-f]{1,40})$/i.exec(segmentsOf(url)[0] ?? "");
  if (!channel) return null;
  return { service: "Odysee", feeds: [{ feedUrl: `https://odysee.com/$/rss/@${encodeURIComponent(channel[1]!)}:${channel[2]}`, via: "Channel feed", origin: "Odysee channel" }] };
}

/** A profile (`/name`) or its gallery (`/name/gallery`). The backend answers an empty feed for a name it doesn't know, so only a gallery with entries counts. */
function deviantart(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(name) || RESERVED_DEVIANTART.has(name.toLowerCase())) return null;
  const gallery = s.length === 1 || (s[1] === "gallery" && (s.length === 2 || (s.length === 3 && s[2] === "all")));
  if (!gallery) return null;
  return { service: "DeviantArt", feeds: [{ feedUrl: `https://backend.deviantart.com/rss.xml?q=gallery:${name}`, via: "Gallery feed", origin: "DeviantArt gallery", needsItems: true }] };
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
    feeds: [{
      feedUrl: `${url.origin}/feeds/videos.xml?${param}=${encodeURIComponent(s[1]!)}`,
      via: "Channel feed",
      origin: kind === "a" ? "PeerTube account feed" : "PeerTube channel feed",
      generator: /^PeerTube\b/i,
    }],
  };
}

function behance(url: URL): KnownPlan | null {
  const s = segmentsOf(url);
  const name = s[0] ?? "";
  if (s.length !== 1 || !/^[A-Za-z0-9_-]{2,40}$/.test(name) || RESERVED_BEHANCE.has(name.toLowerCase())) return null;
  return { service: "Behance", feeds: [{ feedUrl: `https://www.behance.net/feeds/user?username=${encodeURIComponent(name)}`, via: "Projects feed", origin: "Behance projects" }] };
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
  return peertube(url);
}
