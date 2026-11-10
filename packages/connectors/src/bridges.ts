import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Services followed through the installation's bridge (plan/41): pages that publish no feed of
 * their own, turned into one by a bundled RSS-Bridge behind the egress bridge router. This file is
 * the one catalogue both sides read: discovery maps a pasted page address to a source descriptor
 * (`bridge:<service>/<key>`), the worker and the API sign the engine address for it, and the router
 * checks the key, asks the backend and gives every entry a stable id taken from its post address,
 * so a later change of backend keeps a source's items.
 *
 * Only services that worked without credentials from both a home and a datacenter address are
 * listed. Each key pattern is the service's own handle syntax; a renamed handle is a new source.
 */

export type BridgeService = {
  id: string;
  /** What people call the service. */
  name: string;
  /** What one source on it is called ("Telegram channel"). */
  origin: string;
  /** The service's public handle syntax, after lower-casing. */
  keyPattern: RegExp;
  /** A long-running public account, for checking that the bridge still works (the weekly update check). */
  example: string;
  /** The key a page address names, or null for every other page on the service. */
  keyFromPage(url: URL): string | null;
  /** The public page of a key: the source's site address, and what OPML exports. */
  pageUrl(key: string): string;
  /** RSS-Bridge's bridge and parameters for a key. */
  rssBridge: { bridge: string; params(key: string): Record<string, string> };
  /** The stable id of a post, from its address, or null when the address isn't one of this key's posts. */
  postId(key: string, link: URL): string | null;
  /** A well-formed post the backend includes that isn't this source's own, left out on purpose (not a sign the output changed). */
  excluded?(key: string, link: URL): boolean;
  /** The source's name without the backend's decoration ("Nils Frahm - Bandcamp Band" → "Nils Frahm"). */
  cleanTitle?(title: string): string;
  /** A post's HTML without the backend's placeholders for media it couldn't show. */
  cleanHtml?(html: string): string;
  /** Minutes to add to the backend's dates, when it labels local times as UTC. */
  dateCorrectionMinutes?: number;
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
  origin: "Telegram channel",
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
  rssBridge: { bridge: "TelegramBridge", params: (key) => ({ username: key }) },
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
  origin: "Bandcamp artist",
  keyPattern: BANDCAMP_NAME,
  keyFromPage(url) {
    const m = /^([a-z0-9-]+)\.bandcamp\.com$/.exec(hostOf(url));
    if (!m || BANDCAMP_RESERVED.has(m[1]!) || !BANDCAMP_NAME.test(m[1]!)) return null;
    return m[1]!;
  },
  pageUrl: (key) => `https://${key}.bandcamp.com/`,
  // "releases" names each release by its own address; "changes" would repeat one whenever its track list changes.
  rssBridge: { bridge: "BandcampBridge", params: (key) => ({ context: "By band", band: key, type: "releases", limit: "20" }) },
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
  origin: "SoundCloud account",
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
  rssBridge: { bridge: "SoundcloudBridge", params: (key) => ({ u: key, t: "all" }) },
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
  origin: "Twitch videos",
  keyPattern: TWITCH_NAME,
  keyFromPage(url) {
    if (!TWITCH_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    if (s.length > 2 || (s.length === 2 && !["videos", "about", "schedule"].includes(s[1]!))) return null;
    return TWITCH_NAME.test(name) && !TWITCH_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://www.twitch.tv/${key}`,
  rssBridge: { bridge: "TwitchBridge", params: (key) => ({ channel: key, type: "all" }) },
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
  origin: "Mixcloud shows",
  keyPattern: MIXCLOUD_NAME,
  keyFromPage(url) {
    if (!MIXCLOUD_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    const name = s[0]?.toLowerCase() ?? "";
    if (s.length > 2 || (s.length === 2 && !MIXCLOUD_TABS.has(s[1]!))) return null;
    return MIXCLOUD_NAME.test(name) && !MIXCLOUD_RESERVED.has(name) ? name : null;
  },
  pageUrl: (key) => `https://www.mixcloud.com/${key}/`,
  rssBridge: { bridge: "MixCloudBridge", params: (key) => ({ u: key }) },
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
  origin: "Rutube channel",
  keyPattern: /^\d{1,12}$/,
  keyFromPage(url) {
    if (!RUTUBE_HOSTS.has(hostOf(url))) return null;
    const s = segmentsOf(url);
    if (s[0] !== "channel" || !/^\d{1,12}$/.test(s[1] ?? "")) return null;
    return s.length === 2 || (s.length === 3 && ["videos", "about", "shorts"].includes(s[2]!)) ? s[1]! : null;
  },
  pageUrl: (key) => `https://rutube.ru/channel/${key}/`,
  rssBridge: { bridge: "RutubeBridge", params: (key) => ({ context: "По каналу", c: key }) },
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
  origin: "Apple Music releases",
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
  rssBridge: { bridge: "AppleMusicBridge", params: (key) => ({ artist: key, limit: "50" }) },
  postId(_key, link) {
    if (hostOf(link) !== "music.apple.com") return null;
    const s = segmentsOf(link);
    const at = s.indexOf("album");
    const id = at >= 0 ? s.at(-1) : undefined;
    return id && /^\d{1,15}$/.test(id) ? `applemusic:album/${id}` : null;
  },
};

export const BRIDGE_SERVICES: readonly BridgeService[] = Object.freeze([telegram, bandcamp, soundcloud, twitch, mixcloud, rutube, appleMusic]);

export function bridgeService(id: string): BridgeService | undefined {
  return BRIDGE_SERVICES.find((s) => s.id === id);
}

export type BridgeTarget = { service: BridgeService; key: string };

const DESCRIPTOR = /^bridge:([a-z0-9]{2,20})\/([^/\s]{1,100})$/;

/** The descriptor a bridged source keeps as its feed address. */
export function bridgeDescriptor(serviceId: string, key: string): string {
  return `bridge:${serviceId}/${key}`;
}

/** A descriptor (`bridge:telegram/durov`) of a catalogued service with a valid key, or null. */
export function parseBridgeDescriptor(value: string): BridgeTarget | null {
  const m = DESCRIPTOR.exec(value.trim());
  if (!m) return null;
  const service = bridgeService(m[1]!);
  return service && service.keyPattern.test(m[2]!) ? { service, key: m[2]! } : null;
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
