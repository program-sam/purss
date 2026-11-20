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
import { useDownloadMovesToRead } from "./to-read.ts";
import { pageToDownload } from "@purss/domain";
import { useNav } from "../nav.ts";
import type { DownloadProgress } from "./types.ts";
import { app } from "@purss/copy/app";

const t = app.downloads.downloadSection;

/** " 23.4 MB of 65.6 MB (36%)", or just the bytes so far while the whole size isn't known. */
function progressText(p: DownloadProgress | null): string {
  if (!p || p.bytes <= 0) return "";
  const share = progressFraction(p);
  return share === null ? t.progressSoFar(bytesLabel(p.bytes)) : t.progressOf(bytesLabel(p.bytes), bytesLabel(p.total!), Math.round(share * 100));
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
  const toRead = useDownloadMovesToRead();
  const [busy, setBusy] = useState(false);
  if (!downloads) return null;

  const media = item.media;
  const page = pageToDownload(item);
  const what = media ? t.whatMedia(media.kind, media.length ? fileSize(media.length) : null)
    : page ? t.whatPage
    : t.whatText;
  const fromWhere = media ? t.fromPublisherFile
    : page ? t.fromPublisherPage : "";

  async function download() {
    setBusy(true);
    void toRead(item);
    try { await downloads!.download(item.id); } finally { setBusy(false); }
    const r = downloads!.get(item.id);
    if (r?.state === "done") toast(t.downloadedToast(bytesLabel(r.bytes)));
  }
  async function again() {
    setBusy(true);
    try { await downloads!.remove(item.id); await downloads!.download(item.id); } finally { setBusy(false); }
    const r = downloads!.get(item.id);
    if (r?.state === "done") toast(r.page?.state === "saved" ? t.downloadedFullArticle : t.downloadedSummaryOnly);
  }
  async function remove() {
    setBusy(true);
    try {
      if (snap.now?.itemId === item.id && snap.now.from === "device") await player.close();
      const bytes = record?.bytes ?? 0;
      await downloads!.remove(item.id);
      toast(t.removedToast(bytes ? bytesLabel(bytes) : null));
    } finally { setBusy(false); }
  }

  return (
    <section className="field media-box" aria-label="On this device">
      {queued ? (
        <div className="media-saved">
          <div className="dl-state" role="status">
            <DownloadRing progress={null} queued />
            <p>{record?.state === "downloading" ? t.queuedResume : t.queuedNew}</p>
          </div>
          <Button onClick={() => void downloads.cancel(item.id)}>{t.leaveQueue}</Button>
        </div>
      ) : !record ? (
        <div className="media-saved">
          <p className="fine">{t.offer(what, !!media, fromWhere)}</p>
          <Button disabled={busy} onClick={() => void download()}><Icon name="download" size="sm" />{t.download}</Button>
        </div>
      ) : record.state === "downloading" ? (
        <div className="media-saved">
          <div className="dl-state" role="status">
            <DownloadRing progress={progress} />
            <p>{t.downloading}{progressText(progress)}</p>
          </div>
          <Button onClick={() => void downloads.cancel(item.id).then(() => toast(app.words.stoppedTheDownloadNothingOfIt))}>{t.stop}</Button>
        </div>
      ) : record.state === "failed" ? (
        <div className="media-saved">
          <div className="dl-state failed">
            <Icon name="alert" />
            <p><span className="dl-head">{t.notDownloaded}</span> {record.error ?? t.didntFinish}</p>
          </div>
          <div className="fx-acts-row">
            <Button disabled={busy} onClick={() => void download()}>{app.words.tryAgain}</Button>
            <Button disabled={busy} onClick={() => void remove()}>{app.words.dismiss}</Button>
          </div>
        </div>
      ) : (
        <div className="media-saved">
          <div className="dl-state">
            <span className="dl-badge lg" aria-hidden="true"><Icon name="check" /></span>
            <div>
              <p className="dl-head">{t.downloaded(record.origin === "auto")}</p>
              <p className="fine">{t.savedLine(bytesLabel(record.bytes), media ? t.playsAndReads : record.page?.state === "saved" ? t.articleReads : t.reads)}<button type="button" className="link" onClick={() => nav.goPath("/downloads")}>{t.allDownloads}</button></p>
            </div>
          </div>
          <Button disabled={busy} onClick={() => void remove()}><Icon name="trash" size="sm" />{t.remove}</Button>
          {record.page?.state === "failed" ? (
            <div className="dl-state failed dl-page">
              <Icon name="alert" />
              <p><span className="dl-head">{t.onlySummary}</span> {record.page.error} <button type="button" className="link" disabled={busy} onClick={() => void again()}>{app.words.tryAgain}</button></p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
