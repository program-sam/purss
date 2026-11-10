import { Button, Icon } from "@purss/ui";
import { Facts, Page, Section } from "../features/shared/bits.tsx";
import { bytesLabel, plural, timeAgo } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { platform } from "../platform/index.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useDownloads, useDownloadSettings } from "./hooks.ts";

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
    <Page title="Downloaded" lead="Items saved on this device for reading and listening offline.">
      <Section title="On this device" actions={<Button onClick={() => overlays.open({ kind: "settings", tab: "device" })}><Icon name="gear" size="sm" />Download settings</Button>}>
        <Facts items={[
          { label: "Downloads", value: done.length ? `${plural(done.length, "item")}, ${bytesLabel(used)}` : "None yet" },
          { label: "Automatic downloads", value: auto ? `On${settings.wifiOnly ? ", on Wi-Fi only" : ""}, up to ${bytesLabel(settings.limitBytes)}` : "Off" },
        ]} />
        <p className="fine">A download is a copy on this device. PURSS keeps no audio or video files, so if the publisher removes one, your download may be the only copy. Removing a download never changes your PURSS.</p>
      </Section>
      <Section title="Items">
        {list.length ? (
          <ul className="fx-rows">
            {list.map((r) => (
              <li key={r.itemId} className="fx-row">
                <div className="fx-grow">
                  <b>{r.title || "Untitled"}</b>
                  <span className="fine">
                    {r.sourceTitle ? `${r.sourceTitle} · ` : ""}
                    {r.state === "done" ? `${bytesLabel(r.bytes)}${r.media ? `, with its ${r.media.kind === "video" ? "video" : "audio"}` : ""} · ${r.origin === "auto" ? "automatic, " : ""}${timeAgo(r.savedAt) || "just now"}`
                      : r.state === "downloading" ? "Downloading…" : `Not downloaded: ${r.error ?? "the download didn't finish."}`}
                  </span>
                </div>
                <div className="fx-acts">
                  {r.state === "done" ? <Button onClick={() => nav.openItem(r.itemId)}>Open</Button> : null}
                  {r.state !== "downloading" ? (
                    <Button aria-label={`Remove the download of ${r.title || "this item"}`} onClick={() => void downloads.remove(r.itemId).then(() => toast("Removed the download from this device."))}><Icon name="trash" size="sm" /></Button>
                  ) : (
                    <Button onClick={() => void downloads.cancel(r.itemId).then(() => toast("Stopped the download. Nothing of it was kept."))}>Stop</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="fine">Nothing downloaded yet. Open an item and choose Download to this device, or turn on automatic downloads.</p>}
      </Section>
    </Page>
  );
}
