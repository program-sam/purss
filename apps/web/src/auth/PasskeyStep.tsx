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
    if (name === "NotAllowedError") throw new ApiError(0, "cancelled", "Fingerprint, face or screen lock wasn't added. You can try again whenever you like.");
    if (name === "InvalidStateError") throw new ApiError(0, "exists", "This device already has fingerprint, face or screen lock set up for PURSS.");
    throw new ApiError(0, "webauthn", "This browser or device couldn't set up fingerprint, face or screen lock.");
  }
  await post("/api/auth/passkey/register/verify", { challengeId, response, label });
}

/** After setup or joining: the chance to add fingerprint, face or screen lock to this account, or to skip it. */
export function PasskeyStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setBusy(true); setError("");
    try { await registerPasskey(null); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="hint">Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={busy} onClick={add}>{busy ? "Waiting for your device…" : "Add fingerprint, face or screen lock"}</Button>
        <Button disabled={busy} onClick={onDone}>Skip for now</Button>
      </div>
      <p className="fine">You can add it later in Settings → Security.</p>
    </div>
  );
}
