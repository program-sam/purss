import { useState } from "react";
import { OFFICIAL_PURSS_ORIGIN, parsePurssAddress, startingServer, UNENCRYPTED_NOTE } from "@purss/domain";
import { Button, Check, Icon, SelectInput } from "@purss/ui";
import { outboxAsText } from "../annotations/outbox.ts";
import { useOtherAccountsUnsent } from "../annotations/use-annotations.ts";
import { bytesLabel } from "../lib/format.ts";
import { deviceWrites, unsentTotal } from "../lib/unsent-writes.ts";
import { useUnsentOnDevice } from "../lib/use-unsent-on-device.ts";
import { platform } from "../platform/index.ts";
import { PhoneNotificationsSection } from "../shell/PhoneNotifications.tsx";
import { InterfaceUpdatesSection } from "../shell/InterfaceUpdates.tsx";
import { AppUpdateSection } from "../shell/AppUpdates.tsx";
import { DesktopAppSection } from "../shell/DesktopApp.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useDownloads, useDownloadSettings } from "./hooks.ts";
import { LIMIT_CHOICES } from "./types.ts";
import { app } from "@purss/translations/app";

const t = app.downloads.deviceTab;

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
  const unsent = useUnsentOnDevice();
  const others = useOtherAccountsUnsent();
  const { toast } = useToasts();
  const [busy, setBusy] = useState(false);
  if (!conn || !downloads || !settings) return null;
  const set = downloads.updateSettings.bind(downloads);
  const used = downloads.usage();
  const choices = [...new Set([...LIMIT_CHOICES, settings.limitBytes])].sort((a, b) => a - b);

  async function disconnect() {
    setBusy(true);
    // Counted from the device now, not from what the page last showed: what is deleted is what the device holds.
    const held = await deviceWrites.count().catch(() => unsent);
    const warn = unsentTotal(held) ? t.unsyncedLost(held) : "";
    if (!window.confirm(t.disconnectConfirm(warn))) { setBusy(false); return; }
    await conn!.disconnect();
  }

  const address = parsePurssAddress(conn.origin);
  const unencrypted = address.ok && address.unencrypted;
  const official = startingServer(null, OFFICIAL_PURSS_ORIGIN);
  const isOfficial = official.kind === "official" && official.origin === conn.origin;
  const otherCount = others.entries.length;
  const otherWords = t.otherWords(otherCount);
  async function copyOthers() {
    try {
      await navigator.clipboard.writeText(outboxAsText(others.entries));
      toast(t.copied(otherWords));
    } catch { toast(t.copyFailed); }
  }
  async function discardOthers() {
    if (!window.confirm(t.discardConfirm(otherWords))) return;
    await others.discard();
    toast(t.discarded);
  }

  return (
    <>
      {otherCount ? (
        <section className="field" aria-labelledby="dv-other">
          <div className="lbl" id="dv-other">{t.otherHeading}</div>
          <p className="fine">{t.otherNote(otherWords, otherCount)}</p>
          <div className="fx-acts-row"><Button onClick={() => void copyOthers()}>{t.copyAsText}</Button><Button onClick={() => void discardOthers()}>{t.discard}</Button></div>
        </section>
      ) : null}
      <section className="field" aria-labelledby="dv-ws">
        <div className="lbl" id="dv-ws">{t.connectionHeading}</div>
        <p className="fine">{app.words.connectedToSpaced}<b style={{ wordBreak: "break-all" }}>{conn.origin}</b>{isOfficial ? t.connectedTo.official : ""}{t.connectedTo.after}</p>
        {unencrypted ? <p className="p-warn"><Icon name="alert" /><span>{UNENCRYPTED_NOTE}</span></p> : null}
      </section>

      <InterfaceUpdatesSection />

      <AppUpdateSection />

      <DesktopAppSection />

      <PhoneNotificationsSection />

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{app.words.automaticDownloads}</legend>
        <Check checked={settings.autoToRead} onChange={(v) => set({ autoToRead: v })}>{t.toRead}</Check>
        {computer ? null : <Check checked={settings.wifiOnly} onChange={(v) => set({ wifiOnly: v })} hint={t.wifiOnlyHint}>{t.wifiOnly}</Check>}
        <label className="field" style={{ gap: 4, marginTop: 6 }}><span className="lbl">{t.stopAt}</span>
          <SelectInput value={String(settings.limitBytes)} onChange={(e) => set({ limitBytes: Number(e.target.value) })}>
            {choices.map((b) => <option key={b} value={b}>{bytesLabel(b)}</option>)}
          </SelectInput></label>
        <Check checked={settings.removeFinished} onChange={(v) => set({ removeFinished: v })} hint={t.removeFinishedHint}>{t.removeFinished}</Check>
        <p className="fine">{computer
          ? t.automaticOnComputer
          : t.automaticOnPhone}</p>
      </fieldset>

      <section className="field" aria-labelledby="dv-st">
        <div className="lbl" id="dv-st">{t.storageHeading}</div>
        <p className="fine">{t.storageUse.before}<b>{bytesLabel(used)}</b>{t.storageUse.after}</p>
        {used ? <div><Button onClick={() => void downloads.removeAll().then(() => toast(t.removedAll))}><Icon name="trash" size="sm" />{t.removeAll}</Button></div> : null}
      </section>

      {unsentTotal(unsent) ? (
        <p className="p-warn"><Icon name="alert" /><span>{t.unsyncedWarning(unsent)}</span></p>
      ) : null}
      <div><Button disabled={busy} onClick={() => void disconnect()}>{t.disconnect}</Button></div>
    </>
  );
}
