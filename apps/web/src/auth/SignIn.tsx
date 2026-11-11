import { inApp } from "../app-base.ts";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Button, Check, Field, Icon, TextInput } from "@purss/ui";
import { ApiError, get, messageOf, post } from "../api/client.ts";
import { KeepAccount } from "../features/account/KeepAccount.tsx";
import { shortDate } from "../lib/format.ts";
import { sessionQuery } from "../api/queries.ts";
import { useSession } from "../api/hooks.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { passkeysAvailable } from "./PasswordForm.tsx";
import { platform } from "../platform/index.ts";

const PASSKEY_SIGNIN_FAILURE = "Sign-in failed. Try again, or use your password.";

/** Run a WebAuthn assertion against the server; used for sign-in and for step-up. */
export async function assertPasskey(verifyPath: string, sharedComputer = false): Promise<void> {
  const { challengeId, options } = await post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/passkey/login/options", { sharedComputer });
  let response;
  try {
    response = await platform.passkeys!.get(options);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError") throw new ApiError(0, "cancelled", PASSKEY_SIGNIN_FAILURE);
    throw new ApiError(0, "webauthn", PASSKEY_SIGNIN_FAILURE);
  }
  await post(verifyPath, { challengeId, response });
}

const OIDC_ERRORS = "That sign-in didn't work. Try again, or use another way in.";
const DELETING = "This account is being deleted. It can't be signed in to or kept any more.";

/** The provider sign-in's query: where to return afterwards, and whether this is a shared computer. */
function oidcQuery(next: string | undefined, shared: boolean): string {
  const q = new URLSearchParams();
  if (next) q.set("next", next);
  if (shared) q.set("shared", "1");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function SignInPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const session = useSession().data;
  const search = useSearch({ strict: false }) as { error?: string; next?: string; notice?: string; due?: string };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(search.error === "account_deleting" ? DELETING : search.error ? OIDC_ERRORS : "");
  const [notice, setNotice] = useState(search.notice === "deletion_requested" && search.due ? `Your account will be deleted on ${shortDate(search.due)}. Sign in before then to keep it.` : "");
  const [pending, setPending] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sharedComputer, setSharedComputer] = useState(false);

  async function done() {
    await qc.fetchQuery({ ...sessionQuery, staleTime: 0 });
    // Back to where sign-in was asked for (for example an app's connection request); validated by the route.
    if (search.next) router.history.push(search.next);
    else void navigate({ to: "/" });
  }
  /** A deleting account signed in: the server set a short-lived cookie that lets this browser keep it. */
  async function askToKeep() {
    try {
      const { dueAt } = await get<{ dueAt: string | null }>("/api/auth/deletion");
      if (dueAt) { setError(""); setPending(dueAt); } else setError("That took too long. Sign in again to keep your account.");
    } catch (err) { setError(messageOf(err)); }
  }
  /** Sign-in errors, with the deletion grace period handled here instead of shown as a failure. */
  function failed(err: unknown) {
    if (err instanceof ApiError && err.code === "deletion_pending") void askToKeep();
    else setError(messageOf(err));
  }
  // Arriving from a provider's sign-in for a deleting account.
  useEffect(() => { if (search.notice === "deletion_pending") void askToKeep(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function withPasskey() {
    setBusy(true); setWaiting(true); setError("");
    try { await assertPasskey("/api/auth/passkey/login/verify", sharedComputer); await done(); } catch (err) { failed(err); } finally { setBusy(false); setWaiting(false); }
  }
  async function withPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await post("/api/auth/password", { username: username.trim(), password, sharedComputer }); await done(); } catch (err) { failed(err); setPassword(""); } finally { setBusy(false); }
  }

  const providers = session?.installation.oidcProviders ?? [];
  const supported = passkeysAvailable();
  if (pending) {
    const dueAt = pending;
    return (
      <AuthFrame title="Keep your account?">
        <KeepAccount dueAt={dueAt} onKept={done} onLeft={() => { setPending(null); setNotice(`Your account will be deleted on ${shortDate(dueAt)}. Sign in before then to keep it.`); }} />
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Sign in" intro="Follow your sources. Keep what matters.">
      <div style={{ display: "grid", gap: 14 }}>
        {notice ? <p className="state" role="status"><Icon name="info" /><span>{notice}</span></p> : null}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Check checked={sharedComputer} onChange={setSharedComputer} hint="You'll be signed out when you close this browser, or after 8 hours.">This is a shared computer</Check>
        <form onSubmit={withPassword} style={{ display: "grid", gap: 10 }} aria-label="Sign in with a username and password">
          <Field label={session?.installation.accountEmail ? "Username or email address" : "Username"} htmlFor="si-u" hint={session?.installation.accountEmail ? "An email address works once you have confirmed it." : undefined}>
            <TextInput id="si-u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus />
          </Field>
          <Field label="Password" htmlFor="si-p">
            <TextInput id="si-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <div><Button variant="primary" type="submit" disabled={busy || !username.trim() || !password}>Sign in</Button></div>
        </form>
        {supported ? (
          <>
            <Button large disabled={busy} onClick={withPasskey} style={{ width: "100%" }}><Icon name="key" />{waiting ? "Waiting for your device…" : "Sign in with fingerprint, face or screen lock"}</Button>
            <p className="fine" style={{ textAlign: "center", marginTop: -8 }}>Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager.</p>
          </>
        ) : null}
        {providers.map((p) => (
          <a key={p.id} className="btn lg" style={{ width: "100%" }} href={`/api/auth/oidc/${encodeURIComponent(p.id)}/start${oidcQuery(search.next, sharedComputer)}`}>Continue with {p.label}</a>
        ))}
        {/* A reset link comes by email where this installation has account email; otherwise the administrator makes one at the server. */}
        <p className="fine" style={{ textAlign: "center" }}>
          {session?.installation.accountEmail
            ? <>Can't sign in? <a className="link" href={inApp("/reset-password")}>Reset your password by email</a></>
            : "Can't sign in? Ask this server's administrator for a password reset link."}
        </p>
        {/* With open sign-up an invitation is only ever followed from its email link, which fills in the code. */}
        <p className="fine" style={{ textAlign: "center" }}>
          {session?.installation.signup === "open"
            ? <>New here? <a className="link" href={inApp("/signup")}>Create an account</a></>
            : <>New here? <a className="link" href={inApp("/invite")}>Use an invitation</a></>}
        </p>
      </div>
    </AuthFrame>
  );
}
