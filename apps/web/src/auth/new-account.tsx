import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, messageOf } from "../api/client.ts";
import { sessionQuery } from "../api/queries.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { PasskeyStep } from "./PasskeyStep.tsx";
import { passkeysAvailable } from "./PasswordForm.tsx";
import { tryAgainAfter } from "./retry.ts";

/**
 * What happens around making an account, whichever way it is made (setup, an invitation, the link from open sign-up): the button stays
 * busy until the account exists or is refused, and a second press (or Enter) meanwhile does nothing; a refusal is worded for the person
 * (`retryTime`: with the time a refused request may be tried again); and afterwards comes the offer of a passkey, where the browser has them.
 * `passkey` is the page to show instead of the form once the account exists.
 */
export function useNewAccount(retryTime = false): { busy: boolean; error: string; submit: (make: () => Promise<unknown>) => Promise<void>; passkey: ReactNode } {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [passkeyStep, setPasskeyStep] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function finish() {
    await qc.invalidateQueries({ queryKey: sessionQuery.queryKey });
    void navigate({ to: "/" });
  }

  async function submit(make: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    try {
      await make();
    } catch (err) {
      setError(retryTime && err instanceof ApiError && err.retryAfterSeconds !== null ? tryAgainAfter(err.retryAfterSeconds) : messageOf(err));
      sending.current = false;
      setBusy(false);
      return;
    }
    // The account exists now: the button stays busy from here.
    // The server started a session; fetch it so later requests carry the page's CSRF token (they fetch it again if this fails).
    await qc.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => undefined);
    // Fingerprint, face or screen lock is offered only where the browser can do it.
    if (passkeysAvailable()) setPasskeyStep(true);
    else await finish();
  }

  const passkey = passkeyStep ? <AuthFrame title="Fingerprint, face or screen lock"><PasskeyStep onDone={finish} /></AuthFrame> : null;
  return { busy, error, submit, passkey };
}
