import { inApp } from "../app-base.ts";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearch } from "@tanstack/react-router";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { messageOf, post } from "../api/client.ts";
import { AuthFrame } from "./AuthFrame.tsx";

/*
 * Pages opened from links in account emails (plan/27): confirming an address, and
 * asking for and using a password-reset link.
 */

const useToken = () => (useSearch({ strict: false }) as { token?: string }).token ?? "";

/** /verify-email?token=…: confirms on open; works signed in or not. */
export function VerifyEmailPage() {
  const token = useToken();
  const session = useSession().data;
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [error, setError] = useState("");
  const sent = useRef(false);
  // Wait until the session is known: a signed-in browser's change needs the page's change token, and asking before it
  // arrives is refused once and then repeated.
  useEffect(() => {
    if (sent.current || !session) return;
    sent.current = true;
    if (!token) { setState("failed"); setError("This page needs the link from the email."); return; }
    post("/api/email/verify", { token }).then(() => setState("done"), (err) => { setError(messageOf(err)); setState("failed"); });
  }, [token, session]);
  const signedIn = session?.state === "signed_in";
  return (
    <AuthFrame title="Confirm your email address">
      <div aria-live="polite" style={{ display: "grid", gap: 14 }}>
        {state === "working" ? <p className="state"><span className="spin" aria-hidden="true" />Confirming…</p> : null}
        {state === "done" ? <p className="state"><Icon name="check" /><span>Your email address is confirmed. Messages about your account will go there.</span></p> : null}
        {state === "failed" ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        {state !== "working" && signedIn ? <div><a className="btn primary" href={inApp("/")}>Go to your PURSS</a></div> : null}
        {state !== "working" && !signedIn ? (
          <>
            <p>Sign in with your fingerprint, face or screen lock, your password (username or email address) or a recovery code.</p>
            <div><a className="btn primary" href={inApp("/signin")}>Sign in</a></div>
            {session?.installation.signup === "open" ? <p className="fine">Didn't finish creating your account, or never saw its recovery codes? You can <a className="link" href={inApp("/signup")}>create it again</a>.</p> : null}
          </>
        ) : null}
      </div>
    </AuthFrame>
  );
}

/** /reset-password: ask for a link; /reset-password?token=…: choose a new password. */
export function ResetPasswordPage() {
  const token = useToken();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await post("/api/password-reset", { identifier: identifier.trim() }); setDone(true); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function choose(e: FormEvent) {
    e.preventDefault();
    if (password !== again) { setError("The two passwords don't match."); return; }
    setBusy(true); setError("");
    try { await post("/api/password-reset/confirm", { token, password }); setDone(true); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const alert = error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null;
  if (!token) {
    return (
      <AuthFrame title="Reset your password" intro={done ? undefined : "Enter your username or email address. If the account has a confirmed email, we'll send a link to choose a new password."}>
        {done ? (
          <div style={{ display: "grid", gap: 14 }}>
            <p className="state"><Icon name="check" /><span>If that account has a confirmed email, we've sent a link. It works once, for an hour. Check your spam folder.</span></p>
            <div><a className="link" href={inApp("/signin")}>Back to sign in</a></div>
          </div>
        ) : (
          <form onSubmit={ask} style={{ display: "grid", gap: 14 }}>
            <Field label="Username or email address" htmlFor="rp-id">
              <TextInput id="rp-id" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus maxLength={300} />
            </Field>
            {alert}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><Button variant="primary" type="submit" disabled={busy || !identifier.trim()}>Send a link</Button><a className="link" href={inApp("/signin")}>Back to sign in</a></div>
            <p className="fine">Administrators reset with a recovery code or the server's operator tool instead.</p>
          </form>
        )}
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Choose a new password">
      {done ? (
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state"><Icon name="check" /><span>Your password is changed. You were signed out on every device; sign in again with your new password.</span></p>
          <div><a className="btn primary" href={inApp("/signin")}>Sign in</a></div>
        </div>
      ) : (
        <form onSubmit={choose} style={{ display: "grid", gap: 14 }}>
          <Field label="New password" htmlFor="rp-new" hint="At least 10 characters.">
            <TextInput id="rp-new" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </Field>
          <Field label="New password again" htmlFor="rp-again">
            <TextInput id="rp-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </Field>
          {alert}
          <div><Button variant="primary" type="submit" disabled={busy || !password || !again}>Save new password</Button></div>
        </form>
      )}
    </AuthFrame>
  );
}
