import { useEffect, useState } from "react";
import { app } from "@purss/copy/app";
import { Button, Check } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { bytesLabel } from "../lib/format.ts";
import { useToasts } from "../state/toasts.tsx";
import { offlineSupported, setOfflineReading, useOfflineReading } from "./device.ts";
import { promptInstall, useInstallState } from "./install.ts";
import { refreshPackStatus, usePackStatus } from "./pack-status.ts";
import { storageEstimate } from "./store.ts";
import { savedSummary } from "./summary.ts";
import { wipeOfflineCopies } from "./worker-link.ts";

const t = app.offline.settings;

/** Settings → General: keep the reading queue on this device, and install the app. Everything here belongs to this device, not the account. */
export function OfflineField() {
  const enabled = useOfflineReading();
  const supported = offlineSupported();
  const session = useSession();
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;
  const status = usePackStatus();
  const install = useInstallState();
  const { toast } = useToasts();
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    void refreshPackStatus(accountId);
    void storageEstimate().then((e) => setUsed(e ? e.usage : null));
  }, [accountId, enabled, status.running]);

  const toggle = (on: boolean) => {
    setOfflineReading(on);
    if (on) void navigator.storage?.persist?.();
    else void wipeOfflineCopies().then(() => refreshPackStatus(accountId));
  };
  const remove = async () => {
    await wipeOfflineCopies();
    setOfflineReading(false);
    await refreshPackStatus(accountId);
    toast(t.removed);
  };

  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.title}</legend>
      <Check checked={enabled} disabled={!supported} onChange={toggle}
        hint={t.hint}>
        {t.enabled}
      </Check>
      {!supported ? <p className="fine">{t.unsupported}</p> : null}
      {enabled ? (
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
          <p className="fine" role="status">{savedSummary(status.savedCount, status.savedAt, status.running)}</p>
          {used !== null ? <p className="fine">{t.using(bytesLabel(used))}</p> : null}
          <div><Button onClick={() => void remove()}>{t.remove}</Button></div>
        </div>
      ) : null}
      {install.canInstall ? (
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          <div><Button onClick={() => void promptInstall()}>{t.install}</Button></div>
          <p className="fine">{t.ownWindow}</p>
        </div>
      ) : install.showAppleHint ? <p className="fine" style={{ marginTop: 10 }}>{t.appleHint}</p>
        : install.installedApp ? <p className="fine" style={{ marginTop: 10 }}>{t.installed}</p> : null}
    </fieldset>
  );
}
