import { useState } from "react";
import type { ItemDetail } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { bytesLabel } from "../lib/format.ts";
import { fileSize } from "../player/logic.ts";
import { usePlayer } from "../player/PlayerProvider.tsx";
import { platform } from "../platform/index.ts";
import { useToasts } from "../state/toasts.tsx";
import { DownloadRing, progressFraction } from "./DownloadRing.tsx";
import { useDownload } from "./hooks.ts";
import { pageToDownload } from "@purss/domain";
import { useNav } from "../nav.ts";
import type { DownloadProgress } from "./types.ts";

/** " 23.4 MB of 65.6 MB (36%)", or just the bytes so far while the whole size isn't known. */
function progressText(p: DownloadProgress | null): string {
  if (!p || p.bytes <= 0) return "";
  const share = progressFraction(p);
  return share === null ? ` ${bytesLabel(p.bytes)}` : ` ${bytesLabel(p.bytes)} of ${bytesLabel(p.total!)} (${Math.round(share * 100)}%)`;
}

/**
 * "On this device" in the reader, in the apps only: download the item (its text, highlights and notes,
 * and its audio or video file) for use without a connection. The file comes straight from the publisher.
 */
export function DownloadSection({ item }: { item: ItemDetail }) {
  const downloads = platform.downloads;
  const { record, progress, queued } = useDownload(item.id);
  const { player, snap } = usePlayer();
  const { toast } = useToasts();
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  if (!downloads) return null;

  const media = item.media;
  const page = pageToDownload(item);
  const what = media ? `its text, your highlights and notes, and the ${media.kind === "video" ? "video" : "audio"} file${media.length ? ` (about ${fileSize(media.length)})` : ""}`
    : page ? "the full article (your PURSS has only the summary, so it's read from the publisher's page) and your highlights and notes"
    : "its text and your highlights and notes";
  const fromWhere = media ? " The file comes straight from the publisher, who sees this device's address."
    : page ? " The page comes straight from the publisher, who sees this device's address." : "";

  async function download() {
    setBusy(true);
    try { await downloads!.download(item.id); } finally { setBusy(false); }
    const r = downloads!.get(item.id);
    if (r?.state === "done") toast(`Downloaded to this device · ${bytesLabel(r.bytes)}`);
  }
  async function again() {
    setBusy(true);
    try { await downloads!.remove(item.id); await downloads!.download(item.id); } finally { setBusy(false); }
    const r = downloads!.get(item.id);
    if (r?.state === "done") toast(r.page?.state === "saved" ? "Downloaded the full article to this device." : "Downloaded to this device, still with the summary only.");
  }
  async function remove() {
    setBusy(true);
    try {
      if (snap.now?.itemId === item.id && snap.now.from === "device") await player.close();
      const bytes = record?.bytes ?? 0;
      await downloads!.remove(item.id);
      toast(`Removed the download from this device${bytes ? `, freeing ${bytesLabel(bytes)}` : ""}. Nothing changed in your PURSS.`);
    } finally { setBusy(false); }
  }

  return (
    <section className="field media-box" aria-label="On this device">
      {queued ? (
        <div className="media-saved">
          <div className="dl-state" role="status">
            <DownloadRing progress={null} queued />
            <p>Waiting to download, after the download in progress.</p>
          </div>
          <Button onClick={() => void downloads.cancel(item.id)}>Take out of the queue</Button>
        </div>
      ) : !record ? (
        <div className="media-saved">
          <p className="fine">Download {what} to read{media ? " and play" : ""} offline.{fromWhere} Downloads stay on this device.</p>
          <Button disabled={busy} onClick={() => void download()}><Icon name="download" size="sm" />Download to this device</Button>
        </div>
      ) : record.state === "downloading" ? (
        <div className="media-saved">
          <div className="dl-state" role="status">
            <DownloadRing progress={progress} />
            <p>Downloading to this device…{progressText(progress)}</p>
          </div>
          <Button onClick={() => void downloads.cancel(item.id).then(() => toast("Stopped the download. Nothing of it was kept."))}>Stop download</Button>
        </div>
      ) : record.state === "failed" ? (
        <div className="media-saved">
          <div className="dl-state failed">
            <Icon name="alert" />
            <p><span className="dl-head">Not downloaded.</span> {record.error ?? "The download didn't finish."}</p>
          </div>
          <div className="fx-acts-row">
            <Button disabled={busy} onClick={() => void download()}>Try again</Button>
            <Button disabled={busy} onClick={() => void remove()}>Dismiss</Button>
          </div>
        </div>
      ) : (
        <div className="media-saved">
          <div className="dl-state">
            <span className="dl-badge lg" aria-hidden="true"><Icon name="check" /></span>
            <div>
              <p className="dl-head">Downloaded to this device{record.origin === "auto" ? " automatically" : ""}</p>
              <p className="fine">{bytesLabel(record.bytes)} · {media ? "plays and reads" : record.page?.state === "saved" ? "the full article, shown below, reads" : "reads"} without a connection. <button type="button" className="link" onClick={() => nav.goPath("/downloads")}>All downloads</button></p>
            </div>
          </div>
          <Button disabled={busy} onClick={() => void remove()}><Icon name="trash" size="sm" />Remove download</Button>
          {record.page?.state === "failed" ? (
            <div className="dl-state failed dl-page">
              <Icon name="alert" />
              <p><span className="dl-head">Only the summary was saved.</span> {record.page.error} <button type="button" className="link" disabled={busy} onClick={() => void again()}>Try again</button></p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
