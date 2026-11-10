import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Check, Field, TextInput } from "@purss/ui";
import { ApiError, messageOf, post } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { sessionQuery } from "../api/queries.ts";
import type { RecoveryCodes } from "../api/types.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { PasskeyStep } from "./PasskeyStep.tsx";
import { finishSignupAttempt, signupAttempt } from "./signup-attempt.ts";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel.tsx";

type Step = "code" | "codes" | "passkey";

/** First run: claim the installation with the setup code, keep recovery codes, optionally add a passkey. */
export function SetupPage({ mode = "setup", initialCode = "" }: { mode?: "setup" | "invite" | "signup"; initialCode?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);
  const [sharedComputer, setSharedComputer] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The button stays busy until the account is made or refused, and a second press (or Enter) while it works does nothing.
  const sending = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    let out: RecoveryCodes;
    try {
      out = mode === "signup"
        ? await post<RecoveryCodes>("/api/signup", { displayName: name.trim() || null, email: email.trim(), sharedComputer, attempt: signupAttempt() })
        : await post<RecoveryCodes>(mode === "setup" ? "/api/setup/claim" : "/api/invites/accept", { code: code.trim(), displayName: name.trim() || null, sharedComputer });
    } catch (err) {
      if (mode === "signup" && err instanceof ApiError && err.retryAfterSeconds !== null) {
        const now = new Date();
        const retryAt = new Date(now.getTime() + err.retryAfterSeconds * 1000);
        const dateKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const day = dateKey(retryAt) === dateKey(now) ? ""
          : dateKey(retryAt) === dateKey(tomorrow) ? " tomorrow"
          : ` on ${retryAt.toLocaleDateString()}`;
        setError(`Try again after ${retryAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}${day}`);
      } else setError(messageOf(err));
      sending.current = false;
      setBusy(false);
      return;
    }
    // The account exists now: the button stays busy from here, and the codes are shown whatever happens next.
    if (mode === "signup") finishSignupAttempt();
    setCodes(out.recoveryCodes);
    setGeneration(out.recoveryGeneration);
    // The server started a session; fetch it so later requests carry the page's CSRF token (they fetch it again if this fails).
    await qc.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => undefined);
    setStep("codes");
  }

  async function finish() {
    await qc.invalidateQueries({ queryKey: sessionQuery.queryKey });
    void navigate({ to: "/" });
  }

  if (step === "codes") {
    return <AuthFrame title="Keep your recovery codes"><RecoveryCodesPanel codes={codes} generation={generation} onSaved={() => setStep("passkey")} /></AuthFrame>;
  }
  if (step === "passkey") {
    return <AuthFrame title="How you'll sign in"><PasskeyStep onDone={finish} /></AuthFrame>;
  }
  return (
    <AuthFrame
      title={mode === "setup" ? "Set up your PURSS" : mode === "invite" ? "Accept your invitation" : "Create your account"}
      intro={mode === "setup"
        ? "Enter the setup code from the server. It was printed when the server started and is saved in the secrets folder of its data directory."
        : mode === "invite" ? "Enter the invitation code you were sent to create your account."
        : "We'll email you a link to confirm your address. Then you'll save recovery codes and choose how to sign in."}
      footer={<Button variant="primary" type="submit" form="setup-form" disabled={busy || (mode !== "signup" ? !code.trim() : !email.trim())}>{busy ? (mode === "signup" ? "Creating your account…" : "Checking…") : "Continue"}</Button>}
    >
      <form id="setup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {mode !== "signup" ? (
          <Field label={mode === "setup" ? "Setup code" : "Invitation code"} htmlFor="auth-code">
            <TextInput id="auth-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus aria-invalid={!!error} aria-describedby={error ? "auth-error" : undefined} />
          </Field>
        ) : null}
        {mode === "signup" ? (
          <Field label="Email address" htmlFor="auth-email" hint="Used only for account messages, such as password resets.">
            <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" spellCheck={false} autoCapitalize="none" autoFocus maxLength={254} />
          </Field>
        ) : null}
        <Check checked={sharedComputer} onChange={setSharedComputer} hint="You'll be signed out when you close this browser, or after 8 hours.">This is a shared computer</Check>
        <Field label="Display name (optional)" htmlFor="auth-name" hint="Only used to tell accounts apart.">
          <TextInput id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />
        </Field>
        {error ? <p id="auth-error" className="state note" role="alert">{error}</p> : null}
      </form>
    </AuthFrame>
  );
}
