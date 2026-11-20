import { inApp } from "../app-base.ts";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearch } from "@tanstack/react-router";
import { Button, Check, Field, Icon, TextInput } from "@purss/ui";
import { ApiError, messageOf, post } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { useNewAccount } from "./new-account.tsx";
import { usePasswordFields } from "./PasswordForm.tsx";
import { ProviderButton } from "./ProviderButton.tsx";
import { tryAgainAfter } from "./retry.ts";
import { app } from "@purss/copy/app";

const t = app.auth.signup;

/**
 * Open sign-up starts with the email address: /signup asks for it and sends a link, and /signup?token=… (the link) finishes the
 * account with a password. The first step answers the same whether or not the address already has an account.
 */
export function SignupPage() {
  const token = (useSearch({ strict: false }) as { token?: string }).token;
  return token ? <FinishSignup token={token} /> : <StartSignup />;
}

function StartSignup() {
  const providers = useSession().data?.installation.oidcProviders ?? [];
  const [email, setEmail] = useState("");
  const [sharedComputer, setSharedComputer] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await post("/api/signup/start", { email: email.trim() });
      setSent(email.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.retryAfterSeconds !== null ? tryAgainAfter(err.retryAfterSeconds) : messageOf(err));
    } finally { setBusy(false); }
  }

  if (sent !== null) {
    return (
      <AuthFrame title={t.checkInboxTitle}>
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state" role="status"><Icon name="check" /><span>{t.sentTo(sent)}</span></p>
          <p className="fine">{t.spamHint}</p>
          <div><button type="button" className="link" onClick={() => setSent(null)}>{t.useDifferentEmail}</button></div>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame
      title={t.createTitle}
      intro={t.createIntro}
      footer={<Button variant="primary" type="submit" form="signup-form" disabled={busy || !email.trim()}>{busy ? t.sending : t.sendLink}</Button>}
    >
      <form id="signup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {providers.length ? (
          <>
            {providers.map((p) => <ProviderButton key={p.id} provider={p} href={`/api/auth/oidc/${encodeURIComponent(p.id)}/start${sharedComputer ? "?shared=1" : ""}`} />)}
            <Check checked={sharedComputer} onChange={setSharedComputer} hint={t.sharedComputerHint}>{t.sharedComputer}</Check>
            <p className="fine" style={{ textAlign: "center", marginTop: -4 }}>{t.orMakeAccount}</p>
          </>
        ) : null}
        <Field label={t.emailLabel} htmlFor="auth-email">
          <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" spellCheck={false} autoCapitalize="none" autoFocus maxLength={254} />
        </Field>
        {error ? <p id="auth-error" className="state note" role="alert">{error}</p> : null}
      </form>
    </AuthFrame>
  );
}

/** The address the link is for, once the server has looked at it; or why the link doesn't work. */
function useSignupLink(token: string): { email: string | null; error: string } {
  const [state, setState] = useState<{ email: string | null; error: string }>({ email: null, error: "" });
  useEffect(() => {
    let live = true;
    post<{ email: string }>("/api/signup/check", { token }).then(
      (out) => { if (live) setState({ email: out.email, error: "" }); },
      (err) => { if (live) setState({ email: null, error: messageOf(err) }); },
    );
    return () => { live = false; };
  }, [token]);
  return state;
}

function FinishSignup({ token }: { token: string }) {
  const link = useSignupLink(token);
  const [name, setName] = useState("");
  const [sharedComputer, setSharedComputer] = useState(false);
  const { fields, password, valid } = usePasswordFields(link.email);
  const account = useNewAccount(true);

  function submit(e: FormEvent) {
    e.preventDefault();
    void account.submit(() => post("/api/signup", { token, displayName: name.trim() || null, password, sharedComputer }));
  }

  if (account.passkey) return account.passkey;
  if (link.error) {
    return (
      <AuthFrame title={t.createTitle}>
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state note" role="alert"><Icon name="info" /><span>{link.error}</span></p>
          <div><a className="btn primary" href={inApp("/signup")}>{t.startAgain}</a></div>
        </div>
      </AuthFrame>
    );
  }
  if (link.email === null) {
    return <AuthFrame title={t.createTitle}><p className="state" role="status"><span className="spin" aria-hidden="true" />{t.checkingLink}</p></AuthFrame>;
  }
  return (
    <AuthFrame
      title={t.finishTitle}
      intro={t.finishIntro}
      footer={<Button variant="primary" type="submit" form="signup-form" disabled={account.busy || !valid}>{account.busy ? t.creating : t.create}</Button>}
    >
      <form id="signup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <Field label={t.emailLabel} htmlFor="auth-email">
          <TextInput id="auth-email" type="email" value={link.email} readOnly autoComplete="username" />
        </Field>
        <Field label={t.displayName} htmlFor="auth-name">
          <TextInput id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />
        </Field>
        {fields}
        <Check checked={sharedComputer} onChange={setSharedComputer} hint={t.sharedComputerHint}>{t.sharedComputer}</Check>
        {account.error ? <p id="auth-error" className="state note" role="alert">{account.error}</p> : null}
      </form>
    </AuthFrame>
  );
}
