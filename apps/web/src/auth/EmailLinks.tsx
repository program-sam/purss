import { inApp } from "../app-base.ts";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearch } from "@tanstack/react-router";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { messageOf, post } from "../api/client.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { app } from "@purss/copy/app";

const t = app.auth.emailLinks;

/*
 * Pages opened from links in account emails: confirming an address, and
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
    if (!token) { setState("failed"); setError(t.verify.needsLink); return; }
    post("/api/email/verify", { token }).then(() => setState("done"), (err) => { setError(messageOf(err)); setState("failed"); });
  }, [token, session]);
  const signedIn = session?.state === "signed_in";
  return (
    <AuthFrame title={t.verify.title}>
      <div aria-live="polite" style={{ display: "grid", gap: 14 }}>
        {state === "working" ? <p className="state"><span className="spin" aria-hidden="true" />{t.verify.confirming}</p> : null}
        {state === "done" ? <p className="state"><Icon name="check" /><span>{t.verify.confirmed}</span></p> : null}
        {state === "failed" ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        {state !== "working" && signedIn ? <div><a className="btn primary" href={inApp("/")}>{t.verify.goToYourPurss}</a></div> : null}
        {state !== "working" && !signedIn ? (
          <>
            <p>{t.verify.signInPrompt}</p>
            <div><a className="btn primary" href={inApp("/signin")}>{t.verify.signIn}</a></div>
          </>
        ) : null}
      </div>
    </AuthFrame>
  );
}

/** /reset-password: ask for a link; /reset-password?token=…: choose a new password. */
export function ResetPasswordPage() {
  const session = useSession().data;
  const token = useToken();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await post("/api/password-reset", { email: email.trim() }); setDone(true); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function choose(e: FormEvent) {
    e.preventDefault();
    if (password !== again) { setError(t.reset.passwordsDontMatch); return; }
    setBusy(true); setError("");
    try { await post("/api/password-reset/confirm", { token, password }); setDone(true); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const alert = error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null;
  if (!token) {
    return (
      <AuthFrame title={t.reset.askTitle} intro={done ? undefined : t.reset.askIntro}>
        {done ? (
          <div style={{ display: "grid", gap: 14 }}>
            <p className="state"><Icon name="check" /><span>{t.reset.sent}</span></p>
            <div><a className="link" href={inApp("/signin")}>{t.reset.backToSignIn}</a></div>
          </div>
        ) : (
          <form onSubmit={ask} style={{ display: "grid", gap: 14 }}>
            <Field label={t.reset.emailLabel} htmlFor="rp-id">
              <TextInput id="rp-id" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus maxLength={300} />
            </Field>
            {alert}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><Button variant="primary" type="submit" disabled={busy || !email.trim()}>{t.reset.sendLink}</Button><a className="link" href={inApp("/signin")}>{t.reset.backToSignIn}</a></div>
            {session?.installation.mode === "hosted"
              ? session.installation.accountEmail ? null : <p className="fine">{t.reset.resetEmailsUnavailable}</p>
              : session ? <p className="fine">{t.reset.administratorsGetLink}</p> : null}
          </form>
        )}
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={t.reset.chooseTitle}>
      {done ? (
        <div style={{ display: "grid", gap: 14 }}>
          <p className="state"><Icon name="check" /><span>{t.reset.changed}</span></p>
          <div><a className="btn primary" href={inApp("/signin")}>{t.reset.signIn}</a></div>
        </div>
      ) : (
        <form onSubmit={choose} style={{ display: "grid", gap: 14 }}>
          <Field label={t.reset.newPasswordLabel} htmlFor="rp-new" hint={t.reset.newPasswordHint}>
            <TextInput id="rp-new" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </Field>
          <Field label={t.reset.newPasswordAgainLabel} htmlFor="rp-again">
            <TextInput id="rp-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </Field>
          {alert}
          <div><Button variant="primary" type="submit" disabled={busy || !password || !again}>{t.reset.saveNewPassword}</Button></div>
        </form>
      )}
    </AuthFrame>
  );
}
