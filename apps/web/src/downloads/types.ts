import type { DownloadSettings, ItemKind } from "@purss/domain";

/**
 * "Downloaded": copies on this device only (plan/31). The server keeps no audio or video files, so the
 * media file always comes straight from the publisher. An item downloaded here keeps its readable
 * text, its highlights and notes, and its audio or video file when it has one.
 */

export type DownloadOrigin = "manual" | "auto";

export type DownloadRecord = {
  itemId: string;
  title: string;
  sourceTitle: string;
  kind: ItemKind;
  origin: DownloadOrigin;
  state: "downloading" | "done" | "failed";
  /** Plain words when it failed. */
  error: string | null;
  /** The media file, when the item has one and it was downloaded (from the publisher). */
  media: { file: string; bytes: number; type: string | null; kind: "audio" | "video" } | null;
  /**
   * The publisher's article, for an item PURSS has only a summary of: read from its page on this
   * device and kept here only (never in PURSS). Null when none was needed.
   */
  page: { state: "saved"; bytes: number } | { state: "failed"; error: string } | null;
  /** Everything this download takes on the device: the media file and the saved text. */
  bytes: number;
  /** When it was downloaded, or last refreshed from the server. */
  savedAt: string;
};

/** An article read from the publisher's page on this device: clean HTML, kept only here. */
export type DeviceArticle = { title: string | null; html: string; url: string; savedAt: string };

/** A download in progress: the bytes fetched so far and, when known, the file's whole size. */
export type DownloadProgress = { bytes: number; total: number | null };

export const LIMIT_CHOICES = [500 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 5 * 1024 ** 3, 10 * 1024 ** 3] as const;

/** The device's side of downloads, used by screens through `platform.downloads`. */
export interface DeviceDownloads {
  /** This account's downloads, newest first. */
  list(): readonly DownloadRecord[];
  get(itemId: string): DownloadRecord | undefined;
  subscribe(listener: () => void): () => void;
  /** How far the item's download has come, while it runs. */
  progress(itemId: string): DownloadProgress | null;
  /** Whether the item waits in the queue behind the download in progress. */
  queued(itemId: string): boolean;
  /** Download an item (its text, highlights and notes, and its media file when it has one). */
  download(itemId: string, origin?: DownloadOrigin): Promise<void>;
  remove(itemId: string): Promise<void>;
  /** Take a download out of the queue, or stop it in progress; nothing of it is kept. */
  cancel(itemId: string): Promise<void>;
  /** Remove every download of every account on this device. */
  removeAll(): Promise<void>;
  /** Total bytes of this account's downloads on this device. */
  usage(): number;
  settings(): DownloadSettings;
  updateSettings(patch: Partial<DownloadSettings>): void;
  /** A device address the player can play for this item's media, or null when it isn't downloaded. */
  playable(itemId: string): Promise<string | null>;
  /** The article read from the publisher's page on this device, when the download kept one. */
  article(itemId: string): Promise<DeviceArticle | null>;
  /** The downloaded answer for an API read (an item and its annotations), for when the network can't answer. */
  answer(path: string): Promise<Response | null>;
  /** Refresh downloaded items from the server, apply the automatic rules and the cleanup. */
  sync(): Promise<void>;
  /** Which account the downloads shown belong to (they are kept per account). */
  setAccount(accountId: string | null): void;
}
