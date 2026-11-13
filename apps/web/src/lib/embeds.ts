/**
 * A video page's own embedded player (plan/25): YouTube (its no-cookie player), Vimeo, Dailymotion, Odysee and Twitch.
 * The reader loads one only when the person presses play, so opening an item asks nothing of the platform. The
 * player is the platform's own, so the play counts as a view on that platform and its ads play as on its site.
 * Any other page, PeerTube included (every instance has its own address), still opens on its own site.
 * The page policies allow frames from `EMBED_ORIGINS` only (apps/api/src/server.ts, platform/csp.ts).
 */
export const EMBED_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://geo.dailymotion.com",
  "https://odysee.com",
  "https://player.twitch.tv",
  "https://clips.twitch.tv",
] as const;

export type Embed = { src: string; platform: string };

const YT_ID = /^[\w-]{11}$/;
const DM_ID = /^[a-z0-9]{5,12}$/i;

function host(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m)\./, "");
}

function youtube(u: URL): string | null {
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (h === "youtu.be") id = seg[0];
  else if (h === "youtube.com" || h === "music.youtube.com") {
    if (seg[0] === "watch") id = u.searchParams.get("v") ?? undefined;
    else if (seg[0] === "shorts" || seg[0] === "live" || seg[0] === "embed" || seg[0] === "v") id = seg[1];
  }
  if (!id || !YT_ID.test(id)) return null;
  const start = startSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`;
}

/** YouTube's `t`: `90`, `90s` or `1h2m3s`. */
function startSeconds(t: string | null): number {
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0;
}

function vimeo(u: URL): string | null {
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);
  const num = (s: string | undefined) => !!s && /^\d+$/.test(s);
  if (h === "player.vimeo.com") return seg[0] === "video" && num(seg[1]) && seg.length === 2 ? player(seg[1]!, u.searchParams.get("h")) : null;
  if (h !== "vimeo.com") return null;
  // vimeo.com/123, vimeo.com/123/abcdef (unlisted), /channels/name/123, /groups/name/videos/123, /showcase/1/video/123, /album/1/video/123
  if (num(seg[0]) && seg.length === 1) return player(seg[0]!, null);
  if (num(seg[0]) && seg.length === 2 && /^[a-f0-9]{6,}$/i.test(seg[1]!)) return player(seg[0]!, seg[1]!);
  if (seg[0] === "channels" && seg.length === 3 && num(seg[2])) return player(seg[2]!, null);
  if (seg[0] === "groups" && seg.length === 4 && seg[2] === "videos" && num(seg[3])) return player(seg[3]!, null);
  if ((seg[0] === "showcase" || seg[0] === "album") && seg.length === 4 && seg[2] === "video" && num(seg[3])) return player(seg[3]!, null);
  return null;

  function player(id: string, hash: string | null): string {
    return `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1${hash ? `&h=${hash}` : ""}`;
  }
}

function dailymotion(u: URL): string | null {
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (h === "dai.ly") id = seg[0];
  else if (h === "dailymotion.com") id = seg[0] === "video" ? seg[1] : seg[0] === "embed" && seg[1] === "video" ? seg[2] : undefined;
  id = id?.split("_")[0];
  return id && DM_ID.test(id) ? `https://geo.dailymotion.com/player.html?video=${id}&autoplay=1` : null;
}

/** odysee.com/@channel:a/video-name:b. The embed keeps the channel: a video's short id is only unique within its channel. */
function odysee(u: URL): string | null {
  if (host(u) !== "odysee.com") return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const claim = /^[^@$:][^:]*:[0-9a-f]+$/i;
  const ok = seg.length === 1 ? claim.test(seg[0]!) : seg.length === 2 && /^@[^:]+:[0-9a-f]+$/i.test(seg[0]!) && claim.test(seg[1]!);
  // The URL parser has already percent-encoded anything unsafe in a path segment.
  return ok ? `https://odysee.com/$/embed/${seg.join("/")}?autoplay=true` : null;
}

/** Twitch's player must be told the page's own host name, and refuses one that isn't served over https (localhost aside). */
function twitch(u: URL, page: { protocol: string; hostname: string } | null): string | null {
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);
  if (!page || !page.hostname || !(page.protocol === "https:" || (page.protocol === "http:" && page.hostname === "localhost"))) return null;
  const parent = encodeURIComponent(page.hostname);
  if (h === "twitch.tv" && seg[0] === "videos" && /^\d+$/.test(seg[1] ?? "") && seg.length === 2) return `https://player.twitch.tv/?video=${seg[1]}&parent=${parent}&autoplay=true`;
  const clip = h === "clips.twitch.tv" && seg.length === 1 ? seg[0] : h === "twitch.tv" && seg[1] === "clip" && seg.length === 3 ? seg[2] : undefined;
  if (clip && /^[\w-]+$/.test(clip)) return `https://clips.twitch.tv/embed?clip=${clip}&parent=${parent}&autoplay=true`;
  return null;
}

/**
 * The embedded player for a video page's address, or null when it isn't one we embed. `page` is where this app runs.
 * An app whose page isn't a web address (the desktop app on macOS and Linux at tauri://, the iPhone app at capacitor://)
 * sends the players no referrer and isn't an origin their framing rules allow: YouTube answers "Error 153", Twitch refuses
 * to be framed and Vimeo stays blank. There only Odysee's player, which plays, is embedded; the rest open on their site.
 */
export function embedFor(url: string | null | undefined, page: { protocol: string; hostname: string } | null = typeof location === "undefined" ? null : location): Embed | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const od = odysee(u);
  if (od) return { src: od, platform: "Odysee" };
  if (!page || (page.protocol !== "https:" && page.protocol !== "http:")) return null;
  const yt = youtube(u);
  if (yt) return { src: yt, platform: "YouTube" };
  const vm = vimeo(u);
  if (vm) return { src: vm, platform: "Vimeo" };
  const dm = dailymotion(u);
  if (dm) return { src: dm, platform: "Dailymotion" };
  const tw = twitch(u, page);
  if (tw) return { src: tw, platform: "Twitch" };
  return null;
}
