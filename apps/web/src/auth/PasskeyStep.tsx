import { useState } from "react";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Button, Icon } from "@purss/ui";
import { ApiError, messageOf, post } from "../api/client.ts";
import { platform } from "../platform/index.ts";

/** Registers a passkey for the signed-in account. Used after setup and from Settings. */
export async function registerPasskey(label: string | null): Promise<void> {
  const { challengeId, options } = await post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>("/api/auth/passkey/register/options");
  let response;
  try {
    response = await platform.passkeys!.create(options);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError") throw new ApiError(0, "cancelled", "The passkey wasn't added. You can try again whenever you like.");
    if (name === "InvalidStateError") throw new ApiError(0, "exists", "This device already has a passkey for PURSS.");
    throw new ApiError(0, "webauthn", "This browser or device couldn't set up a passkey.");
  }
  await post("/api/auth/passkey/register/verify", { challengeId, response, label });
}

/** After setup or joining: the chance to add a passkey to this account, or to skip it. */
export function PasskeyStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setBusy(true); setError("");
    try { await registerPasskey(null); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="hint">Add a passkey: your fingerprint, face or screen lock (Touch ID, Face ID, Windows Hello) or a password manager signs you in from then on. Your password keeps working.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={busy} onClick={add}>{busy ? "Waiting for your device…" : "Add a passkey"}</Button>
        <Button disabled={busy} onClick={onDone}>Skip for now</Button>
      </div>
      <p className="fine">You can add one later in Settings → Security.</p>
    </div>
  );
}
