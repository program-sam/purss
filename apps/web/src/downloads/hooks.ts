import { useEffect, useState, useSyncExternalStore } from "react";
import { platform } from "../platform/index.ts";
import type { DownloadSettings } from "@purss/domain";
import type { DeviceArticle, DownloadProgress, DownloadRecord } from "./types.ts";

const none = () => () => {};
const empty: readonly DownloadRecord[] = [];

/** This account's downloads on this device; empty where there are no downloads (the web). */
export function useDownloads(): readonly DownloadRecord[] {
  const d = platform.downloads;
  return useSyncExternalStore(d ? (fn) => d.subscribe(fn) : none, () => d?.list() ?? empty, () => empty);
}

/** One item's download, how far it has come while it runs, and whether it waits in the queue. */
export function useDownload(itemId: string): { record: DownloadRecord | undefined; progress: DownloadProgress | null; queued: boolean } {
  const d = platform.downloads;
  useDownloads();
  const progress = useSyncExternalStore(d ? (fn) => d.subscribe(fn) : none, () => d?.progress(itemId) ?? null, () => null);
  const queued = useSyncExternalStore(d ? (fn) => d.subscribe(fn) : none, () => d?.queued(itemId) ?? false, () => false);
  return { record: d?.get(itemId), progress, queued };
}

/** The article a download read from the publisher's page, kept on this device; null when there is none. */
export function useDeviceArticle(itemId: string): DeviceArticle | null {
  const { record } = useDownload(itemId);
  const key = record?.state === "done" && record.page?.state === "saved" ? `${itemId}@${record.savedAt}` : null;
  const [article, setArticle] = useState<{ key: string; value: DeviceArticle | null } | null>(null);
  useEffect(() => {
    const d = platform.downloads;
    if (!key || !d) return;
    let live = true;
    void d.article(itemId).then((value) => { if (live) setArticle({ key, value }); }, () => undefined);
    return () => { live = false; };
  }, [itemId, key]);
  return key && article?.key === key ? article.value : null;
}

export function useDownloadSettings(): DownloadSettings | null {
  const d = platform.downloads;
  // settings() reads storage and returns a new object each time, so the snapshot compared is its text:
  // a change of settings alone (no download changed) still re-renders.
  const text = useSyncExternalStore(d ? (fn) => d.subscribe(fn) : none, () => (d ? JSON.stringify(d.settings()) : null), () => null);
  return text === null ? null : (JSON.parse(text) as DownloadSettings);
}
