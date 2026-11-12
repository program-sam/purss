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

/**
 * Open sign-up starts with the email address (plan/21): /signup asks for it and sends a link, and /signup?token=… (the link) finishes the
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
      <AuthFrame title="Check your inbox">
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state" role="status"><Icon name="check" /><span>Check your inbox: we sent a link to finish creating your account to {sent}.</span></p>
          <p className="fine">If you don't see it, look in your spam folder. The link works once.</p>
          <div><button type="button" className="link" onClick={() => setSent(null)}>Use a different email address</button></div>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame
      title="Create your account"
      intro="Enter your email address. We'll send you a link to finish creating your account, and you'll sign in with that address."
      footer={<Button variant="primary" type="submit" form="signup-form" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send me the link"}</Button>}
    >
      <form id="signup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {providers.length ? (
          <>
            {providers.map((p) => <ProviderButton key={p.id} provider={p} href={`/api/auth/oidc/${encodeURIComponent(p.id)}/start${sharedComputer ? "?shared=1" : ""}`} />)}
            <Check checked={sharedComputer} onChange={setSharedComputer} hint="Signs out when the browser closes, or after 8 hours">This is a shared computer</Check>
            <p className="fine" style={{ textAlign: "center", marginTop: -4 }}>Or make an account with your email address:</p>
          </>
        ) : null}
        <Field label="Email address" htmlFor="auth-email">
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
      <AuthFrame title="Create your account">
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state note" role="alert"><Icon name="info" /><span>{link.error}</span></p>
          <div><a className="btn primary" href={inApp("/signup")}>Start again</a></div>
        </div>
      </AuthFrame>
    );
  }
  if (link.email === null) {
    return <AuthFrame title="Create your account"><p className="state" role="status"><span className="spin" aria-hidden="true" />Checking your link…</p></AuthFrame>;
  }
  return (
    <AuthFrame
      title="Finish creating your account"
      intro="Choose a password to finish. You'll sign in with this email address and that password."
      footer={<Button variant="primary" type="submit" form="signup-form" disabled={account.busy || !valid}>{account.busy ? "Creating your account…" : "Create my account"}</Button>}
    >
      <form id="signup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <Field label="Email address" htmlFor="auth-email">
          <TextInput id="auth-email" type="email" value={link.email} readOnly autoComplete="username" />
        </Field>
        <Field label="Display name (optional)" htmlFor="auth-name">
          <TextInput id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />
        </Field>
        {fields}
        <Check checked={sharedComputer} onChange={setSharedComputer} hint="Signs out when the browser closes, or after 8 hours">This is a shared computer</Check>
        {account.error ? <p id="auth-error" className="state note" role="alert">{account.error}</p> : null}
      </form>
    </AuthFrame>
  );
}
