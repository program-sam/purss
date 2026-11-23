import { useCallback } from "react";
import { app } from "@purss/translations/app";
import type { ItemDTO } from "@purss/domain";
import { useDownload } from "../downloads/hooks.ts";
import { useDownloadMovesToRead } from "../downloads/to-read.ts";
import { platform } from "../platform/index.ts";
import { useToasts } from "../state/toasts.tsx";

const t = app.player.quickDownload;

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

/**
 * One click to download an item's audio or video (and its text) to this device, for use without a connection.
 * A podcast episode also goes to To listen; that message, with its Undo, follows the one about the download.
 */
export function useQuickDownload(): (item: ItemDTO) => Promise<void> {
  const { toast } = useToasts();
  const toRead = useDownloadMovesToRead();
  return useCallback(async (item: ItemDTO) => {
    const downloads = platform.downloads;
    if (!downloads || !offersQuickDownload(item) || downloads.get(item.id)?.state === "done") return;
    const waits = downloads.list().some((r) => r.state === "downloading");
    toast(waits ? t.queued : t.downloading);
    void toRead(item);
    await downloads.download(item.id);
    const r = downloads.get(item.id);
    if (r?.state === "failed") toast(t.failed(r.error ?? t.didntFinish), { tone: "error" });
  }, [toast, toRead]);
}
