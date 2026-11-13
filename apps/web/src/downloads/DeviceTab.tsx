import { useState } from "react";
import { OFFICIAL_WORKSPACE_ORIGIN, parseWorkspaceAddress, startingServer, UNENCRYPTED_NOTE } from "@purss/domain";
import { Button, Check, Icon, SelectInput } from "@purss/ui";
import { outboxAsText } from "../annotations/outbox.ts";
import { useOtherAccountsUnsent, useWaitingCount } from "../annotations/use-annotations.ts";
import { bytesLabel } from "../lib/format.ts";
import { platform } from "../platform/index.ts";
import { PhoneNotificationsSection } from "../shell/PhoneNotifications.tsx";
import { InterfaceUpdatesSection } from "../shell/InterfaceUpdates.tsx";
import { AppUpdateSection } from "../shell/AppUpdates.tsx";
import { DesktopAppSection } from "../shell/DesktopApp.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useDownloads, useDownloadSettings } from "./hooks.ts";
import { LIMIT_CHOICES } from "./types.ts";

/**
 * Settings → This device, in the apps: the server this app is connected to, updates of the app from it and new versions of it, notifications on this phone, automatic downloads and
 * what they take on this device, the way to the browser for what stays there, and disconnecting.
 */
export function DeviceTab() {
  const conn = platform.connection;
  const computer = platform.desktop !== null;
  const downloads = platform.downloads;
  const settings = useDownloadSettings();
  useDownloads();
  const unsynced = useWaitingCount();
  const others = useOtherAccountsUnsent();
  const { toast } = useToasts();
  const [busy, setBusy] = useState(false);
  if (!conn || !downloads || !settings) return null;
  const set = downloads.updateSettings.bind(downloads);
  const used = downloads.usage();
  const choices = [...new Set([...LIMIT_CHOICES, settings.limitBytes])].sort((a, b) => a - b);

  async function disconnect() {
    const warn = unsynced ? ` ${unsynced === 1 ? "1 highlight or note hasn't" : `${unsynced} highlights or notes haven't`} synced yet and will be lost.` : "";
    if (!window.confirm(`Disconnect this app from PURSS? Everything it keeps on this device, downloads included, is removed.${warn}`)) return;
    setBusy(true);
    await conn!.disconnect();
  }

  const address = parseWorkspaceAddress(conn.origin);
  const unencrypted = address.ok && address.unencrypted;
  const official = startingServer(null, OFFICIAL_WORKSPACE_ORIGIN);
  const isOfficial = official.kind === "official" && official.origin === conn.origin;
  const otherCount = others.entries.length;
  const otherWords = otherCount === 1 ? "1 highlight or note" : `${otherCount} highlights or notes`;
  async function copyOthers() {
    try {
      await navigator.clipboard.writeText(outboxAsText(others.entries));
      toast(`Copied ${otherWords} as text.`);
    } catch { toast("Couldn't copy to the clipboard."); }
  }
  async function discardOthers() {
    if (!window.confirm(`Discard ${otherWords} written with another account? They haven't been sent, so they will be lost.`)) return;
    await others.discard();
    toast("Discarded.");
  }

  return (
    <>
      {otherCount ? (
        <section className="field" aria-labelledby="dv-other">
          <div className="lbl" id="dv-other">Unsent from another account</div>
          <p className="fine">{otherWords} from another account {otherCount === 1 ? "hasn't" : "haven't"} been sent. {otherCount === 1 ? "It'll be" : "They'll be"} sent if that account connects this app again. You can copy {otherCount === 1 ? "it" : "them"} as text or discard {otherCount === 1 ? "it" : "them"}.</p>
          <div className="fx-acts-row"><Button onClick={() => void copyOthers()}>Copy as text</Button><Button onClick={() => void discardOthers()}>Discard</Button></div>
        </section>
      ) : null}
      <section className="field" aria-labelledby="dv-ws">
        <div className="lbl" id="dv-ws">Server</div>
        <p className="fine">Connected to <b style={{ wordBreak: "break-all" }}>{conn.origin}</b>{isOfficial ? ", the official server" : ""}. To use another server, disconnect this app below and choose it when you connect again.</p>
        {unencrypted ? <p className="p-warn"><Icon name="alert" /><span>{UNENCRYPTED_NOTE}</span></p> : null}
      </section>

      <InterfaceUpdatesSection />

      <AppUpdateSection />

      <DesktopAppSection />

      <PhoneNotificationsSection />

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Automatic downloads</legend>
        <Check checked={settings.autoToRead} onChange={(v) => set({ autoToRead: v })}>To read podcast episodes</Check>
        {computer ? null : <Check checked={settings.wifiOnly} onChange={(v) => set({ wifiOnly: v })} hint="Downloads you start yourself always go ahead.">Only on Wi-Fi</Check>}
        <label className="field" style={{ gap: 4, marginTop: 6 }}><span className="lbl">Stop automatic downloads at</span>
          <SelectInput value={String(settings.limitBytes)} onChange={(e) => set({ limitBytes: Number(e.target.value) })}>
            {choices.map((b) => <option key={b} value={b}>{bytesLabel(b)}</option>)}
          </SelectInput></label>
        <Check checked={settings.removeFinished} onChange={(v) => set({ removeFinished: v })} hint="Once an item is marked Finished or Ignored, or played to the end, its download is removed from this device. Nothing changes in your PURSS.">Remove downloads when finished</Check>
        <p className="fine">{computer
          ? "Automatic downloads happen while the app is running, also with its window closed."
          : "Automatic downloads happen while the app is open, and while it is closed about once an hour, when the phone allows it (battery and storage not low)."}</p>
      </fieldset>

      <section className="field" aria-labelledby="dv-st">
        <div className="lbl" id="dv-st">Storage on this device</div>
        <p className="fine">Downloads use <b>{bytesLabel(used)}</b> on this device.</p>
        {used ? <div><Button onClick={() => void downloads.removeAll().then(() => toast("Removed every download from this device."))}><Icon name="trash" size="sm" />Remove all downloads</Button></div> : null}
      </section>

      {unsynced ? (
        <p className="p-warn"><Icon name="alert" /><span>{unsynced === 1 ? "1 highlight or note hasn't" : `${unsynced} highlights or notes haven't`} synced yet. Disconnecting deletes {unsynced === 1 ? "it" : "them"}. Go online first to keep {unsynced === 1 ? "it" : "them"}.</span></p>
      ) : null}
      <div><Button disabled={busy} onClick={() => void disconnect()}>Disconnect this app</Button></div>
    </>
  );
}
