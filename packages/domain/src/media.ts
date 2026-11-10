/**
 * Media files offered by publishers (RSS enclosures): the direct audio or video file an item
 * links, never a web page, a streaming playlist or a video platform's page. The server only
 * reports it; players and the apps' downloads fetch it from the publisher (plan/25).
 */

export type MediaKind = "audio" | "video";
export type Enclosure = { url: string; type: string | null; length?: number | null };
export type MediaEnclosure = { url: string; kind: MediaKind; type: string | null; length: number | null };

const EXTENSION_KINDS: Record<string, MediaKind> = {
  mp3: "audio", m4a: "audio", aac: "audio", ogg: "audio", oga: "audio", opus: "audio", wav: "audio", flac: "audio",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
};

/** Streaming playlists and manifests: not a file, so never treated as one. */
const PLAYLISTS = new Set([
  "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl",
  "application/dash+xml", "audio/x-scpls", "video/vnd.mpeg.dash.mpd",
]);

const mediaType = (t: string | null | undefined) => (t ?? "").split(";")[0]!.trim().toLowerCase();

function kindOfType(t: string): MediaKind | null {
  if (PLAYLISTS.has(t)) return null;
  if (t.startsWith("audio/") || t === "application/ogg") return "audio";
  if (t.startsWith("video/")) return "video";
  return null;
}

function kindOfExtension(url: string): MediaKind | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const m = /\.([a-z0-9]{2,5})$/i.exec(u.pathname);
    return m ? EXTENSION_KINDS[m[1]!.toLowerCase()] ?? null : null;
  } catch {
    return null;
  }
}

const isWebAddress = (url: string) => /^https?:\/\//i.test(url);

/** The first audio or video file among an item's enclosures, by declared type or, when untyped, by file extension. */
export function pickMediaEnclosure(enclosures: readonly Enclosure[]): MediaEnclosure | null {
  for (const e of enclosures) {
    if (!e.url || !isWebAddress(e.url)) continue;
    const t = mediaType(e.type);
    const byType = t ? kindOfType(t) : null;
    if (byType) return { url: e.url, kind: byType, type: e.type, length: positive(e.length) };
    if (!t || t === "application/octet-stream" || t === "binary/octet-stream") {
      const byExtension = kindOfExtension(e.url);
      if (byExtension) return { url: e.url, kind: byExtension, type: e.type, length: positive(e.length) };
    }
  }
  return null;
}

const positive = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
