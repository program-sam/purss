import { server } from "@purss/translations/server";
import type { BridgeServiceId } from "@purss/domain";
import { createHmac, timingSafeEqual } from "node:crypto";
import { issnFromPortalUrl, issnPortalUrl } from "./crossref.ts";
import { MAX_PAGE_KEY, decodePageKey, encodePageKey, keepsFragment, pageBridgeParams, pageHost, pagePostId } from "./page-feeds.ts";

/*
 * Services followed through the installation's bridge: pages that publish no feed of
 * their own, turned into one by a bundled RSS-Bridge behind the egress bridge router. This file is
 * the one catalogue both sides read: discovery maps a pasted page address to a source descriptor
 * (`bridge:<service>/<key>`), the worker and the API sign the engine address for it, and the router
 * checks the key, asks the backend and gives every entry a stable id taken from its post address,
 * so a later change of backend keeps a source's items.
 *
 * Only services that worked without credentials from both a home and a datacenter address are
 * listed. Each key pattern is the service's own handle syntax; a renamed handle is a new source.
 * Most services are collected by RSS-Bridge; Crossref by the router's own backend, so it
 * runs on every installation, with or without RSS-Bridge.
 */

export type BridgeService = {
  id: BridgeServiceId;
  /** What people call the service. */
  name: string;
  /** What one source on it is called ("Telegram channel"). */
  origin: string;
  /** The service's public handle syntax, after lower-casing. */
  keyPattern: RegExp;
  /** A check a pattern can't make: a key that is a pattern-shaped document must also say something allowed (a page list's). */
  validKey?(key: string): boolean;
  /** A long-running public account, for checking that the bridge still works (the weekly update check). */
  example: string;
  /** The key a page address names, or null for every other page on the service. */
  keyFromPage(url: URL): string | null;
  /** The public page of a key: the source's site address, and what OPML exports. */
  pageUrl(key: string): string;
  /** What a key is called to the administrator, when the key itself says little (a page list's key is its page's address). */
  label?(key: string): string;
  /** Which backend collects it: RSS-Bridge (with its bridge and parameters for a key), or Crossref's API. */
  backend: { kind: "rss-bridge"; bridge: string; params(key: string): Record<string, string> } | { kind: "crossref" };
  /** The stable id of a post, from its address, or null when the address isn't one of this key's posts. */
  postId(key: string, link: URL): string | null;
  /** A well-formed post the backend includes that isn't this source's own, left out on purpose (not a sign the output changed). */
  excluded?(key: string, link: URL): boolean;
  /** The source's name without the backend's decoration ("Nils Frahm - Bandcamp Band" → "Nils Frahm"). */
  cleanTitle?(title: string): string;
  /** What a source is called when the backend gave it no name of its own, instead of "<key> on <service>". */
  fallbackTitle?(key: string): string;
  /** A post's title as the backend wrote it, tidied (a page's titles keep the whitespace of its markup). */
  cleanPostTitle?(title: string): string;
  /** Whether a post's address keeps its #fragment (a changelog's entries are headings of one page, told apart by it). */
  keepFragment?(key: string, link: URL): boolean;
  /** A post's HTML without the backend's placeholders for media it couldn't show. */
  cleanHtml?(html: string): string;
  /** Minutes to add to the backend's dates, when it labels local times as UTC. */
  dateCorrectionMinutes?: number;
  /**
   * The service's pictures can't be shown on another site, so an entry carries them for keeping only: none in its text and no
   * attachments of the backend's, but the post's lasting picture address as its picture and, after it, its other pictures as
   * picture attachments. A basket that keeps readable text stores them, and the app shows only stored copies of them (copyOnlyPicture).
   */
  keptPictures?(link: URL, html: string): { cover: string | null; more: string[] };
  /** The backend answers with no posts when it couldn't read the page, so an answer without posts is a failure, not an empty source. */
  emptyIsFailure?: boolean;
};

const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/\.$/, "");
const segmentsOf = (url: URL): string[] => url.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });

/** Telegram public names: letters, digits and underscores, starting with a letter; 5 to 32 long, or 4 for collectible names (t.me/mash). */
const TELEGRAM_NAME = /^[a-z][a-z0-9_]{2,30}[a-z0-9]$/;
const TELEGRAM_RESERVED = new Set(["joinchat", "addstickers", "addemoji", "addtheme", "share", "proxy", "socks", "login", "iv", "setlanguage", "confirmphone", "contact", "boost", "giftcode", "invoice", "addlist", "bg", "s"]);
const TELEGRAM_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me", "telegram.dog", "www.telegram.dog"]);

const telegram: BridgeService = {
  id: "telegram",
  example: "durov",
  name: "Telegram",
  origin: server.sources.connectors.bridges.telegram,
  keyPattern: TELEGRAM_NAME,
  keyFromPage(url) {
    if (!TELEGRAM_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    // t.me/name, t.me/name/123 (a post) and t.me/s/name (the web preview) all name the channel.
    const name = (s[0] === "s" ? s[1] : s[0])?.toLowerCase() ?? "";
    if (s[0] !== "s" && TELEGRAM_RESERVED.has(name)) return null;
    if (name.startsWith("+")) return null;
    return TELEGRAM_NAME.test(name) ? name : null;
  },
  pageUrl: (key) => `https://t.me/${key}`,
  backend: { kind: "rss-bridge", bridge: "TelegramBridge", params: (key) => ({ username: key }) },
  cleanTitle: (title) => title.replace(/\s+-\s+Telegram$/, ""),
  // The public web preview says what it can't show; the post link opens it in Telegram anyway.
  cleanHtml: (html) => html
    .replace(/<div class="message_media_not_supported">[\s\S]*?<\/span>\s*<\/div>/g, "")
    .replace(/(?:Media is too big|This media is not supported in your browser|Please open Telegram to view this post|VIEW IN TELEGRAM)(?:\s*<br\s*\/?>)*/g, "")
    .replace(/Forwarded from&nbsp;<span class="tgme_widget_message_forwarded_from_name"><span dir="auto"><\/span><\/span>(?:<br\s*\/?>)*/g, ""),
  // A channel can have more than one name (t.me/breakingmash is t.me/mash), and its posts carry its main one.
  postId(_key, link) {
    if (!TELEGRAM_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    const at = s[0] === "s" ? 1 : 0;
    const channel = s[at]?.toLowerCase() ?? "";
    return TELEGRAM_NAME.test(channel) && /^\d{1,12}$/.test(s[at + 1] ?? "") && s.length === at + 2 ? `telegram:${channel}/${s[at + 1]}` : null;
  },
};

/** Bandcamp subdomains: letters, digits and hyphens. Labels and artists both live at <name>.bandcamp.com. */
const BANDCAMP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BANDCAMP_RESERVED = new Set(["www", "daily", "blog", "get", "help", "api", "m", "f4", "s4", "t4", "bcbits"]);

const bandcamp: BridgeService = {
  id: "bandcamp",
  example: "nilsfrahm",
  name: "Bandcamp",
  origin: server.sources.connectors.bridges.bandcamp,
  keyPattern: BANDCAMP_NAME,
  keyFromPage(url) {
    const m = /^([a-z0-9-]+)\.bandcamp\.com$/.exec(hostOf(url));
    if (!m || BANDCAMP_RESERVED.has(m[1]!) || !BANDCAMP_NAME.test(m[1]!)) return null;
    return m[1]!;
  },
  pageUrl: (key) => `https://${key}.bandcamp.com/`,
  // "releases" names each release by its own address; "changes" would repeat one whenever its track list changes.
  backend: { kind: "rss-bridge", bridge: "BandcampBridge", params: (key) => ({ context: "By band", band: key, type: "releases", limit: "20" }) },
  cleanTitle: (title) => title.replace(/\s+-\s+Bandcamp(?: Band)?$/, ""),
  postId(key, link) {
    if (hostOf(link) !== `${key}.bandcamp.com`) return null;
    const s = segmentsOf(link);
    return s.length === 2 && (s[0] === "album" || s[0] === "track") && /^[a-z0-9-]{1,200}$/i.test(s[1]!) ? `bandcamp:${key}/${s[0]}/${s[1]!.toLowerCase()}` : null;
  },
};

/** SoundCloud permalinks: letters, digits, hyphens and underscores. */
const SOUNDCLOUD_NAME = /^[a-z0-9_-]{2,64}$/;
const SOUNDCLOUD_RESERVED = new Set([
  "discover", "stream", "search", "upload", "you", "settings", "notifications", "messages", "pages", "terms-of-use", "jobs", "charts", "people", "tags",
  "pro", "mobile", "connect", "signin", "signup", "logout", "imprint", "popular", "feed", "for-artists", "artists", "creators", "help", "community-guidelines",
]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);

const soundcloud: BridgeService = {
  id: "soundcloud",
  example: "flume",
  name: "SoundCloud",
  origin: server.sources.connectors.bridges.soundcloud,
  keyPattern: SOUNDCLOUD_NAME,
  keyFromPage(url) {
    if (!SOUNDCLOUD_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    // The profile and its own listing tabs; a single track or set is a page of its own.
    if (s.length > 2 || (s.length === 2 && !["tracks", "albums", "sets", "popular-tracks", "reposts"].includes(s[1]!))) return null;
    return SOUNDCLOUD_NAME.test(name) && !SOUNDCLOUD_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://soundcloud.com/${key}`,
  backend: { kind: "rss-bridge", bridge: "SoundcloudBridge", params: (key) => ({ u: key, t: "all" }) },
  cleanTitle: (title) => title.replace(/\s+-\s+All\s+-\s+Soundcloud$/i, ""),
  postId(key, link) {
    if (!SOUNDCLOUD_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    if (s[0]?.toLowerCase() !== key) return null;
    if (s.length === 2 && /^[a-z0-9_-]{1,200}$/i.test(s[1]!)) return `soundcloud:${key}/${s[1]!.toLowerCase()}`;
    if (s.length === 3 && s[1] === "sets" && /^[a-z0-9_-]{1,200}$/i.test(s[2]!)) return `soundcloud:${key}/sets/${s[2]!.toLowerCase()}`;
    return null;
  },
};

/** Twitch logins: 4 to 25 letters, digits and underscores. */
const TWITCH_NAME = /^[a-z0-9][a-z0-9_]{3,24}$/;
const TWITCH_RESERVED = new Set([
  "directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops", "search", "downloads", "jobs", "p", "store", "turbo", "prime",
  "friends", "messages", "payments", "following", "broadcast", "dashboard", "login", "signup", "logout", "team", "event", "moderator", "popout", "embed",
]);
const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);

const twitch: BridgeService = {
  id: "twitch",
  example: "shroud",
  name: "Twitch",
  origin: server.sources.connectors.bridges.twitch,
  keyPattern: TWITCH_NAME,
  keyFromPage(url) {
    if (!TWITCH_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    if (s.length > 2 || (s.length === 2 && !["videos", "about", "schedule"].includes(s[1]!))) return null;
    return TWITCH_NAME.test(name) && !TWITCH_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://www.twitch.tv/${key}`,
  backend: { kind: "rss-bridge", bridge: "TwitchBridge", params: (key) => ({ channel: key, type: "all" }) },
  postId(_key, link) {
    if (!TWITCH_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    return s.length === 2 && s[0] === "videos" && /^\d{1,15}$/.test(s[1]!) ? `twitch:video/${s[1]}` : null;
  },
};

/** Mixcloud user names: letters, digits, hyphens and underscores, any case (the site ignores it). */
const MIXCLOUD_NAME = /^[a-z0-9_-]{2,50}$/;
const MIXCLOUD_RESERVED = new Set([
  "discover", "search", "live", "settings", "popular", "legal", "upload", "select", "developers", "explore", "notifications", "about", "pro", "support",
  "terms", "privacy", "categories", "dashboard", "login", "signup", "tag", "genres", "for-creators", "creators", "jobs", "help", "embed",
]);
const MIXCLOUD_HOSTS = new Set(["mixcloud.com", "www.mixcloud.com", "m.mixcloud.com"]);
/** An account's own listing pages (`/name/uploads/`): pages, not shows. */
const MIXCLOUD_TABS = new Set(["uploads", "favorites", "listens", "playlists", "stream"]);
/** A show's address: `/<account>/<show>/`, with a real account name and a show slug that isn't one of the account's pages. */
const mixcloudShow = (link: URL): { owner: string; slug: string } | null => {
  if (!MIXCLOUD_HOSTS.has(hostOf(link))) return null;
  const s = segmentsOf(link);
  const owner = s[0]?.toLowerCase() ?? "";
  const slug = s[1] ?? "";
  if (s.length !== 2 || !MIXCLOUD_NAME.test(owner) || MIXCLOUD_RESERVED.has(owner) || MIXCLOUD_TABS.has(slug.toLowerCase()) || !/^[a-z0-9_-]{1,200}$/i.test(slug)) return null;
  return { owner, slug: slug.toLowerCase() };
};

const mixcloud: BridgeService = {
  id: "mixcloud",
  example: "ntsradio",
  name: "Mixcloud",
  origin: server.sources.connectors.bridges.mixcloud,
  keyPattern: MIXCLOUD_NAME,
  keyFromPage(url) {
    if (!MIXCLOUD_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    if (s.length > 2 || (s.length === 2 && !MIXCLOUD_TABS.has(s[1]!))) return null;
    return MIXCLOUD_NAME.test(name) && !MIXCLOUD_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://www.mixcloud.com/${key}/`,
  backend: { kind: "rss-bridge", bridge: "MixCloudBridge", params: (key) => ({ u: key }) },
  cleanTitle: (title) => title.replace(/^MixCloud\s+-\s+/i, ""),
  // The backend mixes in shows the account listened to; only its own uploads have its name in their address.
  excluded(key, link) {
    const show = mixcloudShow(link);
    return !!show && show.owner !== key;
  },
  postId(key, link) {
    const show = mixcloudShow(link);
    return show && show.owner === key ? `mixcloud:${key}/${show.slug}` : null;
  },
};

const RUTUBE_HOSTS = new Set(["rutube.ru", "www.rutube.ru"]);

const rutube: BridgeService = {
  id: "rutube",
  example: "23460655",
  name: "Rutube",
  origin: server.sources.connectors.bridges.rutube,
  keyPattern: /^\d{1,12}$/,
  keyFromPage(url) {
    if (!RUTUBE_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    if (s[0] !== "channel" || !/^\d{1,12}$/.test(s[1] ?? "")) return null;
    return s.length === 2 || (s.length === 3 && ["videos", "about", "shorts"].includes(s[2]!)) ? s[1]! : null;
  },
  pageUrl: (key) => `https://rutube.ru/channel/${key}/`,
  backend: { kind: "rss-bridge", bridge: "RutubeBridge", params: (key) => ({ context: "По каналу", c: key }) },
  cleanTitle: (title) => title.replace(/\s+-\s+Rutube$/, ""),
  // Rutube's API gives Moscow time without a zone, which the backend labels UTC (checked 2026-11-08: a video
  // published at 13:48 UTC carried 16:24 when it was 13:48 UTC). Moscow keeps UTC+3 all year.
  dateCorrectionMinutes: -180,
  postId(_key, link) {
    if (!RUTUBE_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    return s.length === 2 && s[0] === "video" && /^[0-9a-f]{32}$/.test(s[1]!) ? `rutube:video/${s[1]}` : null;
  },
};

const appleMusic: BridgeService = {
  id: "applemusic",
  example: "909253",
  name: "Apple Music",
  origin: server.sources.connectors.bridges.appleMusic,
  keyPattern: /^\d{1,15}$/,
  keyFromPage(url) {
    if (hostOf(url) !== "music.apple.com") return null;
    // /<country>/artist/<name>/<id>, with or without the country and the name.
    const s = segmentsOf(url);
    const at = s.indexOf("artist");
    if (at < 0 || at > 1) return null;
    const id = s.slice(at + 1).find((p) => /^\d{1,15}$/.test(p));
    return id && s.length - at <= 3 ? id : null;
  },
  pageUrl: (key) => `https://music.apple.com/artist/${key}`,
  // The backend lists the artist's releases in no particular order, so ask for as many as it gives.
  backend: { kind: "rss-bridge", bridge: "AppleMusicBridge", params: (key) => ({ artist: key, limit: "50" }) },
  postId(_key, link) {
    if (hostOf(link) !== "music.apple.com") return null;
    const s = segmentsOf(link);
    const at = s.indexOf("album");
    const id = at >= 0 ? s.at(-1) : undefined;
    return id && /^\d{1,15}$/.test(id) ? `applemusic:album/${id}` : null;
  },
};

/** Instagram user names: letters, digits, periods and underscores, at most 30, no period first, last or twice in a row; the site ignores case. */
const INSTAGRAM_NAME = /^(?!.*\.\.)[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/;
/** The site's own pages; names that are also accounts with posts (creators, media, lite, legal, directory) are left out. */
const INSTAGRAM_RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer", "developers", "web", "api", "graphql", "emails",
  "challenge", "privacy", "terms", "s", "ar", "topics", "popular", "embed", "oauth", "session", "static", "press", "business", "blog",
  "help", "download", "nametag", "invites", "your_activity", "ads", "login", "signup",
]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
/** Instagram's picture servers. */
const INSTAGRAM_PICTURE_HOST = /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/;

/**
 * Whether a picture address is one only a stored copy of can be shown: Instagram's pictures refuse to be shown on other sites
 * (Cross-Origin-Resource-Policy: same-origin), so the app shows them from a kept copy or not at all.
 */
export function copyOnlyPicture(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    const u = new URL(address);
    const host = hostOf(u);
    return INSTAGRAM_PICTURE_HOST.test(host) || (INSTAGRAM_HOSTS.has(host) && /^\/(?:p|reel)\/[^/]+\/media\/?$/.test(u.pathname));
  } catch { return false; }
}
/** A post's short code, from `/p/<code>/` or `/reel/<code>/` (the same code space); case matters. */
const instagramShortcode = (link: URL): string | null => {
  if (!INSTAGRAM_HOSTS.has(hostOf(link))) return null;
  const s = segmentsOf(link);
  return s.length === 2 && (s[0] === "p" || s[0] === "reel") && /^[A-Za-z0-9_-]{5,64}$/.test(s[1]!) ? s[1]! : null;
};

/*
 * Read from the profile's embed widget (`instagram.com/<name>/embed/`), the page websites use to show
 * someone's latest posts: RSS-Bridge falls back to it when Instagram's other pages want a login, which
 * from a server address is always. It carries the latest six posts and could be closed by Instagram.
 */
const instagram: BridgeService = {
  id: "instagram",
  example: "natgeo",
  name: "Instagram",
  origin: server.sources.connectors.bridges.instagram,
  keyPattern: INSTAGRAM_NAME,
  keyFromPage(url) {
    if (!INSTAGRAM_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    // The profile and its own tabs; a post, reel or story is a page of its own.
    if (s.length > 2 || (s.length === 2 && !["reels", "tagged", "embed"].includes(s[1]!))) return null;
    return INSTAGRAM_NAME.test(name) && !INSTAGRAM_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://www.instagram.com/${key}/`,
  backend: { kind: "rss-bridge", bridge: "InstagramBridge", params: (key) => ({ context: "Username", u: key, media_type: "all" }) },
  cleanTitle: (title) => title.replace(/\s+-\s+Instagram$/, ""),
  // The embed widget names no owner per post, so a post's id is its short code alone (codes are global).
  postId(_key, link) {
    const code = instagramShortcode(link);
    return code ? `instagram:p/${code}` : null;
  },
  // Instagram's pictures can't be shown here (copyOnlyPicture) and the widget gives videos no address, so the post's text keeps only its
  // caption: the reader shows the post in Instagram's own embed, and the pictures go to keptPictures.
  cleanHtml: (html) => html
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, "")
    // A picture's link wraps it, and its alt is the caption unescaped, so the link runs to its end.
    .replace(/<a\b[^>]*>\s*<img\b[\s\S]*?<\/a>(?:\s*<br\s*\/?>)?/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    // The backend escapes captions that were escaped already ("it&amp;#039;s", which the reader undoes), and in a picture's caption
    // then links the "#039" as a hashtag.
    .replace(/&(?:amp;)?<a href="https:\/\/www\.instagram\.com\/explore\/tags\/(\d{1,7}|x[0-9a-f]{1,6})">#\1<\/a>;/gi, "&#$1;")
    .replace(/^(?:\s*<br\s*\/?>)+/i, ""),
  keptPictures(link, html) {
    const code = instagramShortcode(link);
    // `/p/<code>/media/` sends the post's first picture (a video's still) from a freshly signed address, so it never expires. The
    // other pictures of a carousel have only the signed addresses the widget gave, which expire after a few days.
    const more = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]!.replace(/&amp;/g, "&")).slice(1)
      .filter((u) => { try { const h = new URL(u); return h.protocol === "https:" && INSTAGRAM_PICTURE_HOST.test(hostOf(h)); } catch { return false; } });
    return { cover: code ? `https://www.instagram.com/p/${code}/media/?size=l` : null, more: [...new Set(more)].slice(0, 19) };
  },
  // RSS-Bridge serves an empty feed when it can't decode the widget's data, which a token in a signed address can break at random
  // (its escape repair reads "uDe2d" in "…AsjuDe2d…" as half an emoji). That can't be told from an account without posts or with its
  // widget switched off, which therefore also read as failing rather than as a source that never posts.
  emptyIsFailure: true,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANGADEX_HOSTS = new Set(["mangadex.org", "www.mangadex.org"]);

const mangadex: BridgeService = {
  id: "mangadex",
  example: "801513ba-a712-498c-8f57-cae55b38cc92",
  name: "MangaDex",
  origin: server.sources.connectors.bridges.mangadex,
  keyPattern: UUID,
  keyFromPage(url) {
    if (!MANGADEX_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const id = s[1]?.toLowerCase() ?? "";
    // /title/<uuid> and /title/<uuid>/<slug>; a chapter is a page of its own.
    return s[0] === "title" && s.length <= 3 && UUID.test(id) ? id : null;
  },
  pageUrl: (key) => `https://mangadex.org/title/${key}`,
  // The latest chapters in every language, newest first (one request whatever the number); chapters that are only a link to another site are left out.
  backend: { kind: "rss-bridge", bridge: "MangaDexBridge", params: (key) => ({ context: "Title Chapters", url: `https://mangadex.org/title/${key}`, limit: "50", images: "no" }) },
  cleanTitle: (title) => title.replace(/\s+Chapters$/, ""),
  postId(_key, link) {
    if (!MANGADEX_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    const id = s[1]?.toLowerCase() ?? "";
    return s.length === 2 && s[0] === "chapter" && UUID.test(id) ? `mangadex:chapter/${id}` : null;
  },
  // A title MangaDex doesn't know is answered as a title without chapters (a feed with no entries), as is a title nobody has uploaded to.
  emptyIsFailure: true,
};

/** VK Video channel handles: letters, digits, underscores and periods, any case (the site ignores it). */
const VK_NAME = /^[a-z0-9_][a-z0-9_.]{1,63}$/;
const VK_VIDEO_HOSTS = new Set(["vkvideo.ru", "www.vkvideo.ru", "m.vkvideo.ru"]);
const VK_SITE_HOSTS = new Set(["vk.com", "www.vk.com", "m.vk.com"]);
/** A channel's own tabs, all of which are the channel. */
const VK_TABS = new Set(["all", "clips", "playlists"]);

const vkvideo: BridgeService = {
  id: "vkvideo",
  example: "thoisoi",
  name: "VK Video",
  origin: server.sources.connectors.bridges.vkvideo,
  keyPattern: VK_NAME,
  keyFromPage(url) {
    let s = segmentsOf(url);
    // vkvideo.ru/@name, and vk.com/video/@name, which redirects there.
    if (VK_SITE_HOSTS.has(hostOf(url)) && s[0] === "video") s = s.slice(1);
    else if (!VK_VIDEO_HOSTS.has(hostOf(url))) return null;
    if (!s[0]?.startsWith("@") || s.length > 2 || (s.length === 2 && !VK_TABS.has(s[1]!))) return null;
    const name = s[0].slice(1).toLowerCase();
    return VK_NAME.test(name) ? name : null;
  },
  pageUrl: (key) => `https://vkvideo.ru/@${key}`,
  backend: { kind: "rss-bridge", bridge: "VkVideoBridge", params: (key) => ({ context: "Channel", u: `@${key}` }) },
  // A video's address is vkvideo.ru/video<owner>_<number>; the owner (a negative number for a community) is part of the video's identity.
  postId(_key, link) {
    if (!VK_VIDEO_HOSTS.has(hostOf(link))) return null;
    const s = segmentsOf(link);
    const m = s.length === 1 ? /^video(-?\d{1,12})_(\d{1,12})$/.exec(s[0]!) : null;
    return m ? `vkvideo:video/${m[1]}_${m[2]}` : null;
  },
};

/** A journal's articles as registered with Crossref. The key is the journal's ISSN without its hyphen. */
const crossref: BridgeService = {
  id: "crossref",
  example: "15481433",
  name: "Crossref",
  origin: "Crossref",
  keyPattern: /^\d{7}[\dX]$/,
  keyFromPage: (url) => issnFromPortalUrl(url),
  pageUrl: (key) => issnPortalUrl(key),
  backend: { kind: "crossref" },
  // DOIs are case-insensitive; the link escapes each part of the DOI (`#`, `<`), so its path is decoded once.
  postId(_key, link) {
    if (hostOf(link) !== "doi.org" || link.search || link.hash) return null;
    let doi: string;
    try { doi = decodeURIComponent(link.pathname.slice(1)); } catch { return null; }
    return /^10\.\d{4,9}\/\S+$/.test(doi) ? `doi:${doi.toLowerCase()}` : null;
  },
};

/**
 * A list of posts found on a page that publishes no feed (page-lists.ts), read by RSS-Bridge's XPathBridge. The key says which page, which
 * recipe and whether the page needs its character set repaired (page-feeds.ts); the page's own address names no source, so
 * only the detector makes one and a pasted address never maps here.
 */
const pageList: BridgeService = {
  id: "page",
  name: server.sources.connectors.pageLists.service,
  origin: server.sources.connectors.bridges.pageList,
  // A key is whatever the writer makes; it is read back whole (decodePageKey) before anything is asked of the bridge.
  keyPattern: new RegExp(`^[A-Za-z0-9_-]{1,${MAX_PAGE_KEY}}$`),
  validKey: (key) => decodePageKey(key) !== null,
  // A real list on a long-running page, for the weekly check that the bridge still reads one.
  example: examplePageKey({
    url: "https://www.anthropic.com/news",
    recipe: { item: "//li[contains(@class, '_row')]", title: ".//h3", link: ".//a/@href", date: ".//time" },
    fixEncoding: false,
  }),
  keyFromPage: () => null,
  pageUrl: (key) => pageOf(key).url,
  label: (key) => pageOf(key).url,
  backend: { kind: "rss-bridge", bridge: "XPathBridge", params: (key) => pageBridgeParams(pageOf(key)) },
  // The page's own title, as XPathBridge reads it, is the source's name, with the whitespace its markup puts in it; without one it says "XPathBridge".
  cleanTitle: (title) => (title.replace(/\s+/g, " ").trim() === "XPathBridge" ? "" : title.replace(/\s+/g, " ").trim()),
  fallbackTitle: (key) => pageHost(pageOf(key)),
  cleanPostTitle: (title) => title.replace(/\s+/g, " ").trim(),
  postId: (key, link) => {
    const source = decodePageKey(key);
    return source ? pagePostId(source, link) : null;
  },
  keepFragment: (key, link) => {
    const source = decodePageKey(key);
    return source ? keepsFragment(source, link) : false;
  },
  // A recipe that matches nothing, or a page it cannot read, is answered with an empty feed and no error.
  emptyIsFailure: true,
};

function examplePageKey(source: Parameters<typeof encodePageKey>[0]): string {
  const key = encodePageKey(source);
  if (!key) throw new Error("The page list used as the example is not a valid page source.");
  return key;
}

/** A key this service accepted, read; the bridge list only asks for keys it has checked. */
function pageOf(key: string): NonNullable<ReturnType<typeof decodePageKey>> {
  const source = decodePageKey(key);
  if (!source) throw new Error("Not a page list's key.");
  return source;
}

export const BRIDGE_SERVICES: readonly BridgeService[] = Object.freeze([telegram, bandcamp, soundcloud, twitch, mixcloud, rutube, appleMusic, instagram, mangadex, vkvideo, crossref, pageList]);

/** True for services collected by RSS-Bridge, which an installation may not run. */
export function needsRssBridge(service: BridgeService): boolean {
  return service.backend.kind === "rss-bridge";
}

export function bridgeService(id: string): BridgeService | undefined {
  return BRIDGE_SERVICES.find((s) => s.id === id);
}

export type BridgeTarget = { service: BridgeService; key: string };

/** The shape of a descriptor; what a key may be is each service's own rule (`keyPattern`, `validKey`). */
const DESCRIPTOR = /^bridge:([a-z0-9]{2,20})\/([^/\s]{1,400})$/;

/** The descriptor a bridged source keeps as its feed address. */
export function bridgeDescriptor(serviceId: string, key: string): string {
  return `bridge:${serviceId}/${key}`;
}

/** Whether a key is one this service answers: its pattern, and what the pattern can't say. */
export function bridgeKeyValid(service: BridgeService, key: string): boolean {
  return service.keyPattern.test(key) && (service.validKey?.(key) ?? true);
}

/** A descriptor (`bridge:telegram/durov`) of a listed service with a valid key, or null. */
export function parseBridgeDescriptor(value: string): BridgeTarget | null {
  const m = DESCRIPTOR.exec(value.trim());
  if (!m) return null;
  const service = bridgeService(m[1]!);
  return service && bridgeKeyValid(service, m[2]!) ? { service, key: m[2]! } : null;
}

/** The bridged source a page address names (a Telegram channel, a Bandcamp artist…), or null. */
export function bridgeTargetForPage(url: URL): BridgeTarget | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const service of BRIDGE_SERVICES) {
    const key = service.keyFromPage(url);
    if (key) return { service, key };
  }
  return null;
}

/** The engine-address signature: the router answers only addresses signed with the installation's bridge key. */
export function bridgeSignature(secret: string, serviceId: string, key: string): string {
  return createHmac("sha256", secret).update(`${serviceId}/${key}`).digest("base64url");
}

export function bridgeSignatureMatches(secret: string, serviceId: string, key: string, given: string): boolean {
  const want = Buffer.from(bridgeSignature(secret, serviceId, key));
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The router path of a source: `/b/<service>/<key>/<signature>`. */
export function bridgeRoutePath(secret: string, serviceId: string, key: string): string {
  return `/b/${serviceId}/${encodeURIComponent(key)}/${bridgeSignature(secret, serviceId, key)}`;
}
