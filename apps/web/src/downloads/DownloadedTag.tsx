import { useDownload } from "./hooks.ts";
import { app } from "@purss/copy/app";

const t = app.downloads.downloadedTag;

/**
 * The mark on an item downloaded to this device (in the apps). Copies kept for offline reading get no
 * mark: keeping the reading list on the device is what the app does anyway.
 */
export function DownloadedTag({ itemId }: { itemId: string }) {
  const downloaded = useDownload(itemId).record?.state === "done";
  return downloaded ? <span className="dl-tag" title={t.title}>{t.label}</span> : null;
}
