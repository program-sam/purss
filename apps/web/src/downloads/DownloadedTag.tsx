import { useDownload } from "./hooks.ts";

/**
 * The mark on an item downloaded to this device (in the apps). Copies kept for offline reading get no
 * mark: keeping the reading list on the device is what the app does anyway.
 */
export function DownloadedTag({ itemId }: { itemId: string }) {
  const downloaded = useDownload(itemId).record?.state === "done";
  return downloaded ? <span className="dl-tag" title="Downloaded to this device. It works without a connection.">Downloaded</span> : null;
}
