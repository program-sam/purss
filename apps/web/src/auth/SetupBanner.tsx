import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../api/queries.ts";
import { messageOf, post } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { useOverlays } from "../state/overlays.tsx";

/** Persistent reminder for accounts that still rely on this device and their recovery codes. */
export function SetupBanner() {
  const session = useSession().data;
  const overlays = useOverlays();
  if (session?.state !== "signed_in" || !session.account) return null;
  const { needsSetup, recoveryGeneration, recoveryAcknowledged } = session.account;
  return (
    <>
      {needsSetup ? (
        <div role="region" aria-label="Finish setting up" className="setup-note">
          <strong>Finish setting up</strong>
          <span>If you lose this device and your recovery codes, you lose this account.</span>
          <button type="button" className="link" onClick={() => overlays.open({ kind: "settings", tab: "security" })}>Add a way to sign in</button>
        </div>
      ) : null}
      {recoveryGeneration > 0 && !recoveryAcknowledged ? <RecoveryCodesBanner generation={recoveryGeneration} /> : null}
    </>
  );
}

/** Recovery codes were made but never confirmed as saved (the page was closed first): ask, until they are confirmed or replaced by new ones. */
function RecoveryCodesBanner({ generation }: { generation: number }) {
  const qc = useQueryClient();
  const overlays = useOverlays();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function saved() {
    setBusy(true); setError("");
    try {
      await post("/api/account/recovery-codes/acknowledge", { generation });
      await qc.invalidateQueries({ queryKey: keys.session });
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <div role="region" aria-label="Recovery codes" className="setup-note">
      <strong>Did you save your recovery codes?</strong>
      <span>They can't be shown again.</span>
      <button type="button" className="link" disabled={busy} onClick={() => void saved()}>Yes, I saved them</button>
      <button type="button" className="link" onClick={() => overlays.open({ kind: "settings", tab: "security" })}>Make new ones</button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
