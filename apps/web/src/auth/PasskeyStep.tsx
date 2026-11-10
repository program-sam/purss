import { useState } from "react";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Button, Icon } from "@purss/ui";
import { ApiError, messageOf, post } from "../api/client.ts";
import { PasswordForm, passkeysAvailable } from "./PasswordForm.tsx";
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

/** After setup or joining: add a passkey, or a username and password where passkeys can't work. */
export function PasskeyStep({ onDone }: { onDone: () => void }) {
  const supported = passkeysAvailable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [usePassword, setUsePassword] = useState(!supported);

  async function add() {
    setBusy(true); setError("");
    try { await registerPasskey(null); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  if (usePassword) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        {supported ? <p className="hint">Fingerprint, face or screen lock works with Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager.</p> : null}
        <p className="hint">A password works on any computer.</p>
        <PasswordForm current={null} submitLabel="Save and continue" onDone={onDone} />
        <p className="fine">
          {supported ? <><button type="button" className="link" onClick={() => setUsePassword(false)}>Add fingerprint, face or screen lock</button>. </> : null}
          Or <button type="button" className="link" onClick={onDone}>skip for now</button>. If you lose this device and your recovery codes, you lose this account.
        </p>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="hint">Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager. No password to type.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={add}>{busy ? "Waiting for your device…" : "Add fingerprint, face or screen lock"}</Button>
        <Button onClick={() => setUsePassword(true)}>Use a username and password</Button>
        <Button onClick={onDone}>Skip for now</Button>
      </div>
      <p className="fine">If you skip and then lose this device and your recovery codes, you lose this account. You can add a way to sign in later in Settings → Security.</p>
    </div>
  );
}
