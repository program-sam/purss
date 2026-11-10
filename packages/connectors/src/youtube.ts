import { decodeBody } from "./content-type.ts";
import type { SafeFetchResponse, SafeFetchResult } from "./safe-fetch.ts";

/*
 * YouTube address recognition and resolution. Only YouTube's own public feeds are
 * used (videos.xml for channels and playlists). A handle or video page is read only
 * to learn the channel id. Nothing here claims full channel history: an official feed
 * carries the latest few videos.
 */

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

export function isYoutubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
// Playlists that have an official feed: user playlists, channel uploads, album playlists.
const FEEDABLE_PLAYLIST = /^(?:PL|UU|OLAK5uy_|FL)[A-Za-z0-9_-]{10,}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export type YoutubeTarget =
  | { kind: "channel-id"; channelId: string }
  | { kind: "page"; path: string; label: "handle" | "user" | "custom" }
  | { kind: "video"; videoId: string; playlistId: string | null }
  | { kind: "playlist"; playlistId: string }
  | { kind: "feed"; channelId: string | null; playlistId: string | null; user: string | null }
  | { kind: "unsupported"; message: string };

/** Classify a YouTube URL without any network access. */
export function classifyYoutubeUrl(url: URL): YoutubeTarget {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const list = url.searchParams.get("list");
  const playlistId = list && FEEDABLE_PLAYLIST.test(list) ? list : null;
  if (host.endsWith("youtu.be")) {
    const id = segments[0] ?? "";
    return VIDEO_ID.test(id) ? { kind: "video", videoId: id, playlistId } : { kind: "unsupported", message: "That YouTube link doesn't point to a video, channel or playlist." };
  }
  const first = segments[0] ?? "";
  if (first === "feeds" && segments[1] === "videos.xml") {
    const channelId = url.searchParams.get("channel_id");
    const pl = url.searchParams.get("playlist_id");
    const user = url.searchParams.get("user");
    if ((channelId && CHANNEL_ID.test(channelId)) || (pl && FEEDABLE_PLAYLIST.test(pl)) || user) {
      return { kind: "feed", channelId: channelId && CHANNEL_ID.test(channelId) ? channelId : null, playlistId: pl && FEEDABLE_PLAYLIST.test(pl) ? pl : null, user };
    }
    return { kind: "unsupported", message: "That YouTube feed address is incomplete." };
  }
  if (first === "channel") {
    return segments[1] && CHANNEL_ID.test(segments[1]) ? { kind: "channel-id", channelId: segments[1] } : { kind: "unsupported", message: "That doesn't look like a YouTube channel address (channel ids start with UC)." };
  }
  if (first.startsWith("@") && first.length > 1) return { kind: "page", path: `/@${encodeURIComponent(first.slice(1))}`, label: "handle" };
  if (first === "user" && segments[1]) return { kind: "page", path: `/user/${encodeURIComponent(segments[1])}`, label: "user" };
  if (first === "c" && segments[1]) return { kind: "page", path: `/c/${encodeURIComponent(segments[1])}`, label: "custom" };
  if (first === "playlist") {
    if (list && FEEDABLE_PLAYLIST.test(list)) return { kind: "playlist", playlistId: list };
    return {
      kind: "unsupported",
      message: list ? "YouTube doesn't publish a feed for that kind of playlist (mixes, liked videos and watch-later lists have none)." : "That YouTube playlist link has no playlist id.",
    };
  }
  if (first === "watch") {
    const v = url.searchParams.get("v") ?? "";
    return VIDEO_ID.test(v) ? { kind: "video", videoId: v, playlistId } : { kind: "unsupported", message: "That YouTube link doesn't point to a video, channel or playlist." };
  }
  if ((first === "shorts" || first === "live" || first === "embed" || first === "v") && segments[1] && VIDEO_ID.test(segments[1])) {
    return { kind: "video", videoId: segments[1], playlistId };
  }
  if (segments.length === 0) {
    return { kind: "unsupported", message: "That's YouTube's home page. Paste a channel, video or playlist address." };
  }
  if (["feed", "results", "hashtag", "gaming", "trending", "premium", "account", "tv"].includes(first)) {
    return { kind: "unsupported", message: "That YouTube page isn't a channel. Paste a channel (youtube.com/@name), a video or a playlist address. Search results, your subscriptions and watch history can't be followed." };
  }
  return { kind: "unsupported", message: "We couldn't tell which YouTube channel that is. Try the channel's address, for example youtube.com/@name." };
}

export function channelFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function playlistFeedUrl(playlistId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
}

export function userFeedUrl(user: string): string {
  return `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(user)}`;
}

export type ChannelIdResult = { ok: true; channelId: string } | { ok: false; reason: "unsupported" | "unreachable" | "invalid" | "timeout" | "nofeed"; message: string };

/** YouTube did not answer in time. Not "couldn't reach": the same lookup usually works a moment later. */
export const YOUTUBE_SLOW = "YouTube was slow to answer. Try again in a moment; it usually works the second time.";

/** A handle YouTube has no page for. Handles get renamed, and a guessed one is often wrong, so this does not claim the channel doesn't exist. */
export function handleNotFoundMessage(path: string): string {
  const name = decodeURIComponent(path.split("/")[1] ?? "");
  const what = name.startsWith("@") ? `the handle ${name}` : "that address";
  return `YouTube has no page for ${what}. The channel may have a different handle now. Paste a link to one of its videos, or its youtube.com/channel/UC… address, and we'll find it that way.`;
}

const CONSENT_HINT = /consent\.youtube\.com|<form[^>]+action="https:\/\/consent\.youtube\.com/i;

/** Pull the channel id out of a channel or video page. Ambiguous pages are refused. */
export function channelIdFromHtml(html: string, mode: "channel" | "video"): ChannelIdResult {
  const found = new Set<string>();
  const add = (v: string | undefined) => {
    if (v && CHANNEL_ID.test(v)) found.add(v);
  };
  // Channel pages advertise their own feed and canonical address.
  for (const m of html.matchAll(/<link[^>]+rel=["']alternate["'][^>]*href=["']https?:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']https?:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})["'][^>]*rel=["']alternate["']/gi)) add(m[1]);
  if (mode === "channel") {
    for (const m of html.matchAll(/<link[^>]+rel=["']canonical["'][^>]*href=["']https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["']/gi)) add(m[1]);
    for (const m of html.matchAll(/<meta[^>]+itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/gi)) add(m[1]);
    if (found.size === 0) {
      const m = /"channelMetadataRenderer":\{[^}]{0,3000}?"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
      add(m?.[1]);
    }
  } else {
    // A watch page names the uploader in its microdata and player details.
    for (const m of html.matchAll(/<meta[^>]+itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/gi)) add(m[1]);
    if (found.size === 0) {
      const m = /"videoDetails":\{[^}]{0,4000}?"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
      add(m?.[1]);
    }
  }
  if (found.size === 1) return { ok: true, channelId: [...found][0]! };
  if (found.size > 1) return { ok: false, reason: "unsupported", message: "That YouTube page points at more than one channel, so we can't tell which one you mean. Paste the channel's own address." };
  if (CONSENT_HINT.test(html)) {
    return { ok: false, reason: "unreachable", message: "YouTube asked for cookie consent before showing that page, so we couldn't look the channel up. Paste the channel address that contains /channel/UC… instead." };
  }
  return { ok: false, reason: "unsupported", message: "We couldn't find which YouTube channel that page belongs to." };
}

/** Read a successful channel/video page response into a channel id. */
export function channelIdFromResponse(result: SafeFetchResult, mode: "channel" | "video", path = ""): ChannelIdResult {
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "aborted") return { ok: false, reason: "timeout", message: YOUTUBE_SLOW };
    return { ok: false, reason: result.reason === "invalid" ? "invalid" : "unreachable", message: result.message };
  }
  return channelIdFromHtmlResponse(result.response, mode, path);
}

function channelIdFromHtmlResponse(response: SafeFetchResponse, mode: "channel" | "video", path: string): ChannelIdResult {
  if (response.status === 404 || response.status === 410) {
    return mode === "channel" && path ? { ok: false, reason: "nofeed", message: handleNotFoundMessage(path) } : { ok: false, reason: "unreachable", message: "YouTube has no page at that address." };
  }
  if (response.status >= 400) return { ok: false, reason: "unreachable", message: `YouTube didn't show that page (error ${response.status}). Try again later.` };
  try {
    if (new URL(response.url).hostname.endsWith("consent.youtube.com")) {
      return { ok: false, reason: "unreachable", message: "YouTube asked for cookie consent before showing that page, so we couldn't look the channel up. Paste the channel address that contains /channel/UC… instead." };
    }
  } catch {
    /* ignore */
  }
  return channelIdFromHtml(decodeBody(response.body, response.contentType), mode);
}

/** What an oEmbed answer (YouTube's, or any provider's) says about a page: title, uploader, site and thumbnail. */
export function parseOembed(body: string): { title: string | null; authorName: string | null; authorUrl: string | null; providerName: string | null; thumbnailUrl: string | null } {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
    const web = (v: unknown) => {
      const u = text(v, 2000);
      return u && /^https?:\/\//i.test(u) ? u : null;
    };
    return { title: text(data.title, 300), authorName: text(data.author_name, 200), authorUrl: web(data.author_url), providerName: text(data.provider_name, 100), thumbnailUrl: web(data.thumbnail_url) };
  } catch {
    return { title: null, authorName: null, authorUrl: null, providerName: null, thumbnailUrl: null };
  }
}
