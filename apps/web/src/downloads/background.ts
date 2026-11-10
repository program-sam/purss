import type { DownloadSettings } from "@purss/domain";
import { ITEM_KINDS, MAX_DOWNLOAD_BYTES } from "@purss/domain";
import type { DownloadRecord } from "./types.ts";

/**
 * The contract with the apps' native background job (plan/38). The job runs while the app is closed,
 * so it can't use the page's storage: the page mirrors what the job needs into native storage, and the
 * job leaves what it downloaded in the downloads folder with a `record.json` beside the files, which
 * the page adopts as its own download record the next time it runs.
 */

/** What the page tells the native side whenever its downloads or their settings change. */
export type BackgroundState = {
  accountId: string;
  settings: DownloadSettings;
  /** Every item with a download record on this device, whatever its state: the job never fetches these again. */
  have: string[];
  /** Total bytes of this account's downloads. */
  usedBytes: number;
};

/** The file the background job writes last in an item's folder: present means the folder is complete. */
export const BACKGROUND_RECORD = "record.json";

/**
 * What the job writes. `status` says why a download failed, as DownloadError statuses: the server's
 * answer, 0 when the connection failed, -2 when the file was larger than the room left under the limit.
 */
export type BackgroundRecord = {
  itemId: string;
  title: string;
  sourceTitle: string;
  kind: DownloadRecord["kind"];
  state: "done" | "failed";
  status: number | null;
  media: DownloadRecord["media"];
  /** Size of item.json and annotations.json. */
  textBytes: number;
  savedAt: string;
};

const KINDS = new Set<string>(ITEM_KINDS);
const num = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isFinite(v) && v >= min;

/**
 * Read a record the job wrote into `accountId/itemId/`; null when it is damaged or doesn't belong
 * there (a media file must be in the same folder, so a record can never point elsewhere).
 */
export function parseBackgroundRecord(text: string | null, accountId: string, itemId: string): BackgroundRecord | null {
  if (!text) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!v || typeof v !== "object" || v.itemId !== itemId) return null;
  if (v.state !== "done" && v.state !== "failed") return null;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  let media: DownloadRecord["media"] = null;
  if (v.state === "done" && v.media !== null && v.media !== undefined) {
    const m = v.media as Record<string, unknown>;
    const file = typeof m.file === "string" ? m.file : "";
    if (!file.startsWith(`${accountId}/${itemId}/`) || file.slice(accountId.length + itemId.length + 2).includes("/") || file.includes("..")) return null;
    if (!num(m.bytes) || m.bytes > MAX_DOWNLOAD_BYTES || (m.kind !== "audio" && m.kind !== "video")) return null;
    media = { file, bytes: m.bytes, type: typeof m.type === "string" ? m.type : null, kind: m.kind };
  }
  return {
    itemId,
    title: str("title"),
    sourceTitle: str("sourceTitle"),
    kind: KINDS.has(str("kind")) ? (str("kind") as DownloadRecord["kind"]) : "article",
    state: v.state,
    status: typeof v.status === "number" && Number.isFinite(v.status) ? v.status : null,
    media,
    textBytes: num(v.textBytes) ? v.textBytes : 0,
    savedAt: str("savedAt") || new Date(0).toISOString(),
  };
}
