import { Button, Icon } from "@purss/ui";
import { Facts, Page, Section } from "../features/shared/bits.tsx";
import { bytesLabel, plural, timeAgo } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { platform } from "../platform/index.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useDownloads, useDownloadSettings } from "./hooks.ts";
import { app } from "@purss/translations/app";

const t = app.downloads.downloadsPage;

/** Everything downloaded to this device, in the apps. Opens items in the reader, with or without a connection. */
export function DownloadsPage() {
  const list = useDownloads();
  const settings = useDownloadSettings();
  const nav = useNav();
  const overlays = useOverlays();
  const { toast } = useToasts();
  const downloads = platform.downloads;
  if (!downloads || !settings) return null;
  const done = list.filter((r) => r.state === "done");
  const used = downloads.usage();
  const auto = settings.autoToRead;

  return (
    <Page title={app.words.downloaded} lead={t.lead}>
      <Section title={t.deviceSection} actions={<Button onClick={() => overlays.open({ kind: "settings", tab: "device" })}><Icon name="gear" size="sm" />{t.downloadSettings}</Button>}>
        <Facts items={[
          { label: t.downloads, value: done.length ? `${plural(done.length, app.words.item)}, ${bytesLabel(used)}` : t.none },
          { label: app.words.automaticDownloads, value: auto ? t.automaticOn(settings.wifiOnly, bytesLabel(settings.limitBytes)) : app.words.off },
        ]} />
        <p className="fine">{t.copyNote}</p>
      </Section>
      <Section title={app.words.items}>
        {list.length ? (
          <ul className="fx-rows">
            {list.map((r) => (
              <li key={r.itemId} className="fx-row">
                <div className="fx-grow">
                  <b>{r.title || t.untitled}</b>
                  <span className="fine">
                    {r.sourceTitle ? t.sourcePrefix(r.sourceTitle) : ""}
                    {r.state === "done" ? t.doneLine(bytesLabel(r.bytes), r.media ? r.media.kind : null, r.origin === "auto", timeAgo(r.savedAt))
                      : r.state === "downloading" ? app.words.downloading : t.notDownloaded(r.error)}
                  </span>
                </div>
                <div className="fx-acts">
                  {r.state === "done" ? <Button onClick={() => nav.openItem(r.itemId)}>{app.words.open}</Button> : null}
                  {r.state !== "downloading" ? (
                    <Button aria-label={`Remove the download of ${r.title || "this item"}`} onClick={() => void downloads.remove(r.itemId).then(() => toast(t.removedToast))}><Icon name="trash" size="sm" /></Button>
                  ) : (
                    <Button onClick={() => void downloads.cancel(r.itemId).then(() => toast(app.words.stoppedTheDownloadNothingOfIt))}>{t.stop}</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="fine">{t.empty}</p>}
      </Section>
    </Page>
  );
}
