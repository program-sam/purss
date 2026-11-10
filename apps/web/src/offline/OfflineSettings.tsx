import { useEffect, useState } from "react";
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
    toast("Removed the offline copies from this device. Offline reading is off.");
  };

  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>App and offline reading</legend>
      <Check checked={enabled} disabled={!supported} onChange={toggle}
        hint="Saves your To read and In progress items, items kept with their text, and new unsorted items on this device. You can read them offline. Article images still need a connection. Turning this off or signing out removes the copies.">
        Offline reading on this device
      </Check>
      {!supported ? <p className="fine">This needs a secure address (HTTPS) and a browser that can keep offline copies, so it isn't available here.</p> : null}
      {enabled ? (
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
          <p className="fine" role="status">{savedSummary(status.savedCount, status.savedAt, status.running)}</p>
          {used !== null ? <p className="fine">Using {bytesLabel(used)} of this device's browser storage.</p> : null}
          <div><Button onClick={() => void remove()}>Remove offline copies</Button></div>
        </div>
      ) : null}
      {install.canInstall ? (
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          <div><Button onClick={() => void promptInstall()}>Install app</Button></div>
          <p className="fine">Opens in its own window, like any other app.</p>
        </div>
      ) : install.showAppleHint ? <p className="fine" style={{ marginTop: 10 }}>To install on an iPhone or iPad, tap Share, then Add to Home Screen.</p>
        : install.installedApp ? <p className="fine" style={{ marginTop: 10 }}>You're using the installed app.</p> : null}
    </fieldset>
  );
}
