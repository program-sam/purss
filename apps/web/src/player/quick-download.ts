import { useCallback } from "react";
import type { ItemDTO } from "@purss/domain";
import { useDownload } from "../downloads/hooks.ts";
import { platform } from "../platform/index.ts";
import { useToasts } from "../state/toasts.tsx";

/** Where an item's quick download to this device stands. */
export type QuickDownloadState = "none" | "queued" | "busy" | "failed" | "done";

/** Rows and cards offer a quick download for an item with an audio or video file, in the apps only: the server keeps no media files. */
export const offersQuickDownload = (item: ItemDTO): boolean => !!item.media && !!platform.downloads;

/** The state the row's download button shows; null when it isn't offered. */
export function useQuickDownloadState(item: ItemDTO): QuickDownloadState | null {
  const { record: device, queued } = useDownload(item.id);
  if (!offersQuickDownload(item)) return null;
  if (queued) return "queued";
  if (device?.state === "downloading") return "busy";
  if (device?.state === "failed") return "failed";
  return device?.state === "done" ? "done" : "none";
}

/** One click to download an item's audio or video (and its text) to this device, for use without a connection. */
export function useQuickDownload(): (item: ItemDTO) => Promise<void> {
  const { toast } = useToasts();
  return useCallback(async (item: ItemDTO) => {
    const downloads = platform.downloads;
    if (!downloads || !offersQuickDownload(item) || downloads.get(item.id)?.state === "done") return;
    const waits = downloads.list().some((r) => r.state === "downloading");
    toast(waits ? "Queued: it downloads after the one in progress." : "Downloading to this device.");
    await downloads.download(item.id);
    const r = downloads.get(item.id);
    if (r?.state === "failed") toast(`Download failed: ${r.error ?? "it didn't finish."}`, { tone: "error" });
  }, [toast]);
}
