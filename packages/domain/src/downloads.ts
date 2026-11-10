import { z } from "zod";
import type { ItemDTO, ItemMedia } from "./api.ts";
import type { ItemKind } from "./query.ts";
import type { WorkflowState } from "./workflow.ts";

/**
 * Automatic downloads to a phone or tablet (plan/31, plan/38): which items the device's settings ask
 * for, and what each takes. One set of rules for the app while it is open and for the native
 * background job, which asks PURSS (`POST /api/downloads/plan`) instead of deciding itself.
 */

export type DownloadSettings = {
  /** Download To read podcast episodes automatically. */
  autoToRead: boolean;
  /** Automatic downloads only on Wi-Fi (downloads you start yourself always go ahead). */
  wifiOnly: boolean;
  /** Automatic downloads never take the total above this. */
  limitBytes: number;
  /** Remove a download once its item is finished (marked Finished or Ignored, or played to the end). */
  removeFinished: boolean;
};

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { autoToRead: false, wifiOnly: true, limitBytes: 2 * 1024 ** 3, removeFinished: false };

export type DeviceConnection = "wifi" | "cellular" | "none" | "unknown";

/** What the rules need to know about an item. `media` is null when there is nothing the device could download. */
export type DownloadCandidate = {
  id: string;
  kind: ItemKind;
  workflow: WorkflowState;
  durationSeconds: number | null;
  publishedAt: string | null;
  discoveredAt: string;
  media: { kind: "audio" | "video"; length: number | null } | null;
};

/** Closer than this to the end counts as played to the end (as the player's own rule). */
export const PLAYED_WITHIN_SECONDS = 15;
/** Size assumed for a file whose size nobody declared: about 128 kbit/s for its length, or this much. */
export const UNKNOWN_SIZE_BYTES = 100 * 1024 ** 2;
/** The largest file the apps download, whatever the limit for automatic downloads. */
export const MAX_DOWNLOAD_BYTES = 4 * 1024 ** 3;

/** What a device fetches for an item's media file: always the publisher's own file (the server keeps none). */
export function mediaToDownload(media: ItemMedia): { url: string; type: string | null; declaredBytes: number | null; file: string } {
  return { url: media.url, type: media.type, declaredBytes: media.length, file: `media${mediaExtension(media.type, media.url)}` };
}

/** A publisher's file is fetched only over a secure connection, as the web player does. */
export const publisherFileAllowed = (url: string) => /^https:\/\//i.test(url);

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".intranet", ".corp", ".home", ".private"];

/**
 * A publisher's page is fetched by a device only over a secure connection, and only from a public host
 * name: never an address written as numbers, this device, or a name that only means something on a
 * local network (the names PURSS refuses too).
 */
export function publisherPageAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  return host !== "localhost" && !LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * The page a download fetches for an item's article on the device: an item without audio or video whose
 * PURSS copy is only the feed's summary (or none, when the feed's text was too large to store).
 * Null when PURSS already has the text, or there is no page a device may fetch.
 */
export function pageToDownload(item: { media: unknown; url: string | null; summaryOnly: boolean; contentOmitted: boolean }): string | null {
  if (item.media || !item.url || !(item.summaryOnly || item.contentOmitted)) return null;
  return publisherPageAllowed(item.url) ? item.url : null;
}

export function downloadCandidate(it: ItemDTO): DownloadCandidate {
  const m = it.media;
  // Nothing to fetch automatically: a publisher's file over plain http would only fail.
  const fetchable = !!m && publisherFileAllowed(m.url);
  return {
    id: it.id, kind: it.kind, workflow: it.workflow, durationSeconds: it.durationSeconds, publishedAt: it.publishedAt, discoveredAt: it.discoveredAt,
    media: m && fetchable ? { kind: m.kind, length: m.length } : null,
  };
}

/** Bytes a candidate's media file is expected to take: the feed's declared size, or a cautious guess. */
export function expectedBytes(c: DownloadCandidate): number {
  const m = c.media;
  if (!m) return 0;
  if (m.length && m.length > 0) return m.length;
  if (c.durationSeconds && c.durationSeconds > 0) return Math.round(c.durationSeconds * 16_000);
  return UNKNOWN_SIZE_BYTES;
}

/** Whether automatic downloads may run on this connection. */
export function connectionAllows(settings: Pick<DownloadSettings, "wifiOnly">, connection: DeviceConnection): boolean {
  if (connection === "none") return false;
  return settings.wifiOnly ? connection === "wifi" : true;
}

/** Whether an item is one the settings ask to have downloaded. */
export function wanted(settings: Pick<DownloadSettings, "autoToRead">, c: DownloadCandidate): boolean {
  if (!c.media) return false;
  if (settings.autoToRead && c.workflow === "toread" && c.kind === "podcast" && c.media.kind === "audio") return true;
  return false;
}

const dateOf = (c: DownloadCandidate) => Date.parse(c.publishedAt ?? c.discoveredAt) || 0;

/** The lists automatic downloads choose from, each its first 200 items, newest first (only To read items are wanted). */
export const CANDIDATE_FILTERS = ["toread"] as const;
export const CANDIDATES_PER_FILTER = 200;

/**
 * What to download now (the connection was already checked): wanted items not on the device yet (and
 * not failed before; `have` holds every item with a download record), To read first, newest first, each
 * only if it fits under the limit with everything already downloaded. A file that doesn't fit is
 * skipped; a smaller one after it may still fit.
 */
export function chooseDownloads(settings: Pick<DownloadSettings, "autoToRead" | "limitBytes">, candidates: readonly DownloadCandidate[], have: ReadonlySet<string>, usedBytes: number): DownloadCandidate[] {
  const order = (c: DownloadCandidate) => (c.workflow === "toread" ? 0 : c.workflow === "inprogress" ? 1 : 2);
  const list = [...new Map(candidates.map((c) => [c.id, c])).values()]
    .filter((c) => wanted(settings, c) && !have.has(c.id))
    .sort((a, b) => order(a) - order(b) || dateOf(b) - dateOf(a) || (a.id < b.id ? -1 : 1));
  const out: DownloadCandidate[] = [];
  let total = usedBytes;
  for (const c of list) {
    const size = expectedBytes(c);
    if (total + size > settings.limitBytes) continue;
    total += size;
    out.push(c);
  }
  return out;
}

/** After an automatic download finished: it stays only if the total is still within the limit. */
export function fitsAfterDownload(settings: Pick<DownloadSettings, "limitBytes">, usedBytesIncludingIt: number): boolean {
  return usedBytesIncludingIt <= settings.limitBytes;
}

export type ItemNow = { workflow: string; playback: { positionSeconds: number; durationSeconds: number | null } | null };

/** Finished: marked Finished or Ignored, or its media played to the end. */
export function isFinished(item: ItemNow): boolean {
  if (item.workflow === "finished" || item.workflow === "ignored") return true;
  const p = item.playback;
  return !!p && p.durationSeconds !== null && p.durationSeconds > 0 && p.positionSeconds >= p.durationSeconds - PLAYED_WITHIN_SECONDS;
}

/** Whether cleanup removes a download now. Never one still downloading. */
export function removeWhenFinished(settings: Pick<DownloadSettings, "removeFinished">, state: "downloading" | "done" | "failed", item: ItemNow): boolean {
  return settings.removeFinished && state === "done" && isFinished(item);
}

/** A file extension for a media type or address, so the player and the system know what the file is. */
export function mediaExtension(type: string | null, url: string): string {
  const t = (type ?? "").toLowerCase().split(";")[0]!.trim();
  const known: Record<string, string> = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg",
    "audio/opus": ".opus", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  };
  if (known[t]) return known[t]!;
  const m = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(url.split("?")[0] ?? "");
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

// ---------- POST /api/downloads/plan ----------

/** Item ids are this PURSS's own; the device lists every item it has a download record for. */
export const downloadPlanRequestSchema = z.object({
  autoToRead: z.boolean(),
  limitBytes: z.number().int().positive().max(1024 ** 4),
  usedBytes: z.number().int().min(0).max(1024 ** 4),
  have: z.array(z.string().min(1).max(64)).max(5000),
});
export type DownloadPlanRequest = z.infer<typeof downloadPlanRequestSchema>;

/** One download to start, in order. `media.url` is the publisher's https file. */
export type DownloadPlanItem = {
  id: string;
  expectedBytes: number;
  media: { kind: "audio" | "video"; url: string; type: string | null; declaredBytes: number | null; file: string };
};
export type DownloadPlan = { items: DownloadPlanItem[] };

/** Settings as a device stored them; anything unreadable falls back to the defaults, field by field. */
export function parseDownloadSettings(raw: string | null, defaults: DownloadSettings = DEFAULT_DOWNLOAD_SETTINGS): DownloadSettings {
  let v: Record<string, unknown> = {};
  try { v = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>; } catch { /* defaults */ }
  if (!v || typeof v !== "object") v = {};
  const bool = (k: keyof DownloadSettings) => (typeof v[k] === "boolean" ? (v[k] as boolean) : (defaults[k] as boolean));
  const limit = typeof v.limitBytes === "number" && Number.isFinite(v.limitBytes) && v.limitBytes > 0 ? v.limitBytes : defaults.limitBytes;
  return { autoToRead: bool("autoToRead"), wifiOnly: bool("wifiOnly"), removeFinished: bool("removeFinished"), limitBytes: limit };
}
