import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { OFFICIAL_WORKSPACE_ORIGIN, parseWorkspaceAddress, startingServer, UNENCRYPTED_NOTE } from "@purss/domain";
import type { ConnectInfo, ConnectSignupInput, ConnectTokenResult } from "@purss/domain";
import { Button, Field, Icon, IconSprite, TextInput } from "@purss/ui";
import { AuthFrame } from "../../auth/AuthFrame.tsx";
import { ProviderButton } from "../../auth/ProviderButton.tsx";
import { checkInfo, connectPageUrl, parsePending, passkeysOffered, pkce, providersOffered, providerStartUrl, readCallback, REDIRECT_URI, signinOffered, signupOffer } from "./connect.ts";
import { inviteFromLink, tokenFromLink } from "../../lib/email-links.ts";
import type { Connection, Pending } from "./connect.ts";
import type { Passkeys } from "../types.ts";

/**
 * The apps' first screen (plan/31): straight to signing in on the official server (OFFICIAL_WORKSPACE_ORIGIN), or
 * on the server chosen before; an address is asked only after *Use another server*, or when there is no official
 * server. After a check that the server is a PURSS: signing in right
 * here (an email address and password; a forgotten password is reset by email) or creating an
 * account (an invitation code; where sign-up is open, a link emailed to the address, which finishes in the browser). A passkey or a linked account
 * needs the system browser: PURSS's Connect page, with the code back at purss://connect.
 *
 * The phone apps and the desktop app (plan/42) share this screen; what differs is their `ConnectShell`.
 */

/** What the screen needs from the app it runs in. */
export interface ConnectShell {
  /** Open PURSS's Connect page in the system browser. */
  openBrowser(url: string): Promise<void>;
  /** Close it again where the app can (an in-app browser tab). */
  closeBrowser(): void;
  /** Addresses handed to the app (purss://connect), while it runs and the one that started it. Returns a function that stops listening. */
  onCallback(listener: (url: string) => void): () => void;
  /** The name PURSS shows for this device. */
  deviceName(): Promise<string>;
  /** Keep the connection in the system's secure storage. */
  save(connection: Connection): Promise<void>;
  /** The device's own passkeys, or null where the app can't use them (PURSS may still offer them). */
  passkeys: Passkeys | null;
  /** The link to PURSS's sign-in in the browser, as worded for this app: with and without its own passkeys. */
  browserSignin: { withPasskeys: string; withoutPasskeys: string };
}

const PENDING_KEY = "purss:connect-pending";
const ADDRESS_KEY = "purss:connect-address";
const TIMEOUT_MS = 15_000;

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: stop.signal, credentials: "omit", headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** A PURSS the address led to, and what it lets the app do itself. */
type Workspace = { origin: string; info: ConnectInfo; signup: { start: string | null; passwordMin: number } | null; passkeys: boolean; providers: { id: string; label: string; start: string }[] };
type SigninFields = { method: "password"; email: string; password: string } | { method: "passkey" };
/** What signing in came to: an error to show, an account set to be deleted that can still be kept, or (empty) connected. */
type SigninAnswer = { error?: string; keep?: { token: string; dueAt: string } };

type Phase = { kind: "address" } | { kind: "checking" } | { kind: "opening"; origin: string } | { kind: "unreachable"; origin: string } | { kind: "waiting"; pending: Pending; page: string } | { kind: "finishing" }
  | { kind: "signin"; ws: Workspace }
  | { kind: "signup"; ws: Workspace; start: string | null; passwordMin: number };

const errorMessage = (body: unknown, fallback: string) => (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;
const offline = (err: unknown) => !(err instanceof Error) || !err.message || /fetch|network|abort/i.test(err.message);

export function ConnectScreen({ notice, shell }: { notice: string | null; shell: ConnectShell }) {
  const deviceName = () => shell.deviceName();
  const saveConnection = (c: Connection) => shell.save(c);
  const [start0] = useState(() => startingServer(localStorage.getItem(ADDRESS_KEY), OFFICIAL_WORKSPACE_ORIGIN));
  const official = startingServer(null, OFFICIAL_WORKSPACE_ORIGIN);
  const officialOrigin = official.kind === "official" ? official.origin : null;
  const [address, setAddress] = useState(start0.kind === "other" ? start0.address : "");
  const [phase, setPhase] = useState<Phase>(() => start0.kind === "official" ? { kind: "opening", origin: start0.origin } : { kind: "address" });
  const [error, setError] = useState("");
  const pendingRef = useRef<Pending | null>(parsePending(localStorage.getItem(PENDING_KEY), Date.now()));

  async function finish(url: string) {
    const pending = pendingRef.current;
    const back = readCallback(url, pending ? { state: pending.state, issuer: pending.issuer } : null);
    if (back.kind === "ignored" || !pending) return;
    shell.closeBrowser();
    pendingRef.current = null;
    localStorage.removeItem(PENDING_KEY);
    if (back.kind === "declined") { restart(pending.origin, "You chose not to connect this app."); return; }
    if (back.kind === "error") { restart(pending.origin, back.message); return; }
    setPhase({ kind: "finishing" });
    try {
      const out = await getJson(`${pending.origin}/api/connect/token`, { method: "POST", body: JSON.stringify({ client: "mobile", code: back.code, codeVerifier: pending.verifier, redirectUri: REDIRECT_URI }) });
      const token = (out.body as Partial<ConnectTokenResult> | null)?.token;
      if (out.status !== 200 || typeof token !== "string") throw new Error((out.body as { error?: { message?: string } } | null)?.error?.message ?? "PURSS didn't accept the connection. Start again.");
      await saveConnection({ origin: pending.origin, token, passkeys: pending.passkeys === true });
      location.reload();
    } catch (err) {
      restart(pending.origin, err instanceof Error && err.message && !/fetch|network|abort/i.test(err.message) ? err.message : "Couldn't reach PURSS to finish connecting. Check your connection and start again.");
    }
  }

  // The browser hands the answer to purss://connect: while the app runs, or by starting it again if the system closed it meanwhile.
  useEffect(() => {
    const stop = shell.onCallback((url) => void finish(url));
    const pending = pendingRef.current;
    if (pending) setPhase({ kind: "waiting", pending, page: "" });
    else if (start0.kind === "official") void open(start0.origin);
    else if (start0.address) void open(start0.address);
    return stop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Back to where connecting starts (the server's sign-in), keeping a message to show there. */
  function restart(origin: string, message: string) {
    setError(message);
    void open(origin, message);
  }

  /** The address typed after *Use another server*. */
  function start(e?: FormEvent) {
    e?.preventDefault();
    void open(address, "", true);
  }

  /**
   * Check the server, then sign in here (a PURSS too old to offer that goes straight to the browser).
   * The server the app starts on is opened without asking; if it can't be reached, the screen says so and
   * offers to try again. Only an address typed by the person (`typed`) goes back to the address field.
   */
  async function open(input: string, keepError = "", typed = false) {
    setError(keepError);
    const n = parseWorkspaceAddress(input);
    if (!n.ok) { setPhase({ kind: "address" }); setError(n.message); return; }
    setPhase(typed ? { kind: "checking" } : { kind: "opening", origin: n.origin });
    const failed = (message: string) => { setError(message); setPhase(typed ? { kind: "address" } : { kind: "unreachable", origin: n.origin }); };
    try {
      const out = await getJson(`${n.origin}/api/connect/info`);
      const checked = out.status === 200 ? checkInfo(out.body) : { ok: false as const, message: out.status === 404 ? "That address answers, but it isn't a PURSS." : "PURSS didn't answer properly. Try again later." };
      if (!checked.ok) { failed(checked.message); return; }
      localStorage.setItem(ADDRESS_KEY, n.origin);
      const ws: Workspace = { origin: n.origin, info: checked.info, signup: signupOffer(checked.info), passkeys: shell.passkeys !== null && passkeysOffered(checked.info), providers: providersOffered(checked.info) };
      if (!signinOffered(checked.info)) { await openBrowser(ws); return; }
      setPhase({ kind: "signin", ws });
    } catch {
      failed(typed ? "Couldn't reach that address. Check it, and that this device is online." : "Couldn't reach PURSS. Check that this device is online and try again.");
    }
  }

  /** *Use another server*, or back to the official one. */
  function chooseServer(other: boolean) {
    setError("");
    if (!other && officialOrigin) { void open(officialOrigin); return; }
    setPhase({ kind: "address" });
  }

  /**
   * Passkeys and linked accounts: approve this app on PURSS's Connect page in the system browser. With `provider` (Continue with
   * Google) the browser starts at that provider's sign-in and ends on the same page. Never the app's own web view: Google refuses it.
   */
  async function openBrowser(ws: Workspace, provider?: Workspace["providers"][number]) {
    const p = await pkce();
    const pending: Pending = { origin: ws.origin, issuer: ws.info.origin, verifier: p.verifier, state: p.state, startedAt: Date.now(), passkeys: ws.passkeys };
    pendingRef.current = pending;
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const request = { challenge: p.challenge, state: p.state, deviceName: await deviceName() };
    const page = provider ? providerStartUrl(provider.start, ws.info.connect.page, request) : connectPageUrl(ws.info.connect.page, request);
    setPhase({ kind: "waiting", pending, page });
    await shell.openBrowser(page);
  }

  /** Sign in (or keep an account set to be deleted, with the token sign-in gave) and connect. */
  async function signIn(ws: Workspace, input: SigninFields | { keepToken: string }): Promise<SigninAnswer> {
    const origin = ws.origin;
    try {
      const keeping = "keepToken" in input;
      let body: Record<string, unknown> = { ...input };
      if (!keeping && input.method === "passkey") {
        const challenge = await getJson(`${origin}/api/connect/passkey/options`, { method: "POST", body: "{}" });
        const { challengeId, options } = (challenge.body ?? {}) as { challengeId?: string; options?: Parameters<Passkeys["get"]>[0] };
        if (challenge.status !== 200 || !challengeId || !options) return { error: errorMessage(challenge.body, "PURSS didn't start the sign-in. Try again.") };
        try { body = { method: "passkey", challengeId, response: await shell.passkeys!.get(options) }; } catch (err) {
          return { error: (err as Error).name === "NotAllowedError" ? "That didn't sign you in. Try your fingerprint, face or screen lock again, or use your password." : "This phone couldn't use fingerprint, face or screen lock for this PURSS." };
        }
      }
      const out = await getJson(`${origin}/api/connect/${keeping ? "keep-account" : "signin"}`, { method: "POST", body: JSON.stringify({ ...body, client: "mobile", deviceName: await deviceName() }) });
      const error = (out.body as { error?: { code?: string; dueAt?: string; keepToken?: string } } | null)?.error;
      if (out.status === 409 && error?.code === "deletion_pending" && error.keepToken && error.dueAt) return { keep: { token: error.keepToken, dueAt: error.dueAt } };
      const token = (out.body as Partial<ConnectTokenResult> | null)?.token;
      if (out.status !== 200 || typeof token !== "string") return { error: errorMessage(out.body, out.status === 429 ? "Too many attempts. Wait a while and try again." : "PURSS didn't sign you in. Try again.") };
      await saveConnection({ origin, token, passkeys: ws.passkeys });
      location.reload();
      return {};
    } catch (err) {
      return { error: offline(err) ? "Couldn't reach PURSS. Check your connection and try again." : (err as Error).message };
    }
  }

  async function setNewPassword(origin: string, token: string, password: string): Promise<string | null> {
    try {
      const out = await getJson(`${origin}/api/password-reset/confirm`, { method: "POST", body: JSON.stringify({ token, password }) });
      return out.status === 200 ? null : errorMessage(out.body, "PURSS didn't set the new password. Ask for a new link and try again.");
    } catch {
      return "Couldn't reach PURSS. Check your connection and try again.";
    }
  }

  async function requestReset(origin: string, email: string): Promise<string | null> {
    try {
      const out = await getJson(`${origin}/api/password-reset`, { method: "POST", body: JSON.stringify({ email }) });
      return out.status === 200 ? null : errorMessage(out.body, out.status === 429 ? "Too many requests. Wait a while and try again." : "PURSS didn't take the request. Try again.");
    } catch {
      return "Couldn't reach PURSS. Check your connection and try again.";
    }
  }

  /** Open sign-up: PURSS emails a link that finishes the account in the browser. It answers the same for any address. */
  async function startSignup(start: string, email: string): Promise<string | null> {
    try {
      const out = await getJson(start, { method: "POST", body: JSON.stringify({ email }) });
      return out.status === 200 ? null : errorMessage(out.body, out.status === 429 ? "Too many attempts. Wait a while and try again." : "PURSS didn't take the request. Try again.");
    } catch {
      return "Couldn't reach PURSS. Check your connection and try again.";
    }
  }

  /** Accept an invitation and connect. */
  async function createAccount(ws: Workspace, input: Omit<ConnectSignupInput, "client" | "deviceName">): Promise<string | null> {
    const origin = ws.origin;
    try {
      const out = await getJson(`${origin}/api/connect/signup`, { method: "POST", body: JSON.stringify({ ...input, client: "mobile", deviceName: await deviceName() }) });
      const token = (out.body as Partial<ConnectTokenResult> | null)?.token;
      if (out.status !== 200 || typeof token !== "string") {
        return errorMessage(out.body, out.status === 429 ? "Too many attempts. Wait a while and try again." : "PURSS didn't create the account. Try again.");
      }
      await saveConnection({ origin, token, passkeys: ws.passkeys });
      location.reload();
      return null;
    } catch (err) {
      return offline(err) ? "Couldn't reach PURSS. Check your connection and try again." : (err as Error).message;
    }
  }

  function cancel() {
    const pendingOrigin = pendingRef.current?.origin ?? (phase.kind === "waiting" ? phase.pending.origin : officialOrigin ?? address);
    pendingRef.current = null;
    localStorage.removeItem(PENDING_KEY);
    shell.closeBrowser();
    restart(pendingOrigin, "");
  }

  const typed = parseWorkspaceAddress(address);
  const unencrypted = typed.ok && typed.unencrypted;
  const officialHost = officialOrigin ? new URL(officialOrigin).host : "";
  const serverLine = (origin: string) => (
    <p className="fine">
      Server: {origin.replace(/^https?:\/\//, "")} · <button type="button" className="link" onClick={() => chooseServer(true)}>Use another server</button>
    </p>
  );

  return (
    <>
      <IconSprite />
      <AuthFrame title={phase.kind === "signin" ? "Sign in" : phase.kind === "signup" ? "Create your account" : "Connect to your PURSS"}
        intro={phase.kind === "address" || phase.kind === "checking" ? "Type the address of your own PURSS, or of another hosted one." : undefined}>
        <div style={{ display: "grid", gap: 14 }}>
          {notice ? <p className="state note" role="status"><Icon name="info" /><span>{notice}</span></p> : null}
          {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
          {phase.kind === "address" || phase.kind === "checking" ? (
            <form onSubmit={start} style={{ display: "grid", gap: 12 }}>
              <Field label="PURSS address" htmlFor="cn-a" hint="e.g. purss.example.org">
                <TextInput id="cn-a" type="url" inputMode="url" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="url" spellCheck={false} autoCapitalize="none" placeholder="purss.example.org" />
              </Field>
              {unencrypted ? <p className="p-warn"><Icon name="alert" /><span>{UNENCRYPTED_NOTE}</span></p> : null}
              <div><Button variant="primary" type="submit" disabled={phase.kind === "checking" || !address.trim()}>{phase.kind === "checking" ? "Checking…" : "Continue"}</Button></div>
              {officialOrigin ? <p className="fine"><button type="button" className="link" disabled={phase.kind === "checking"} onClick={() => chooseServer(false)}>Use the official server ({officialHost})</button></p> : null}
            </form>
          ) : phase.kind === "opening" ? (
            <p className="state" role="status"><span className="spin" aria-hidden="true" />Opening your PURSS…</p>
          ) : phase.kind === "unreachable" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div><Button variant="primary" onClick={() => void open(phase.origin)}>Try again</Button></div>
              {serverLine(phase.origin)}
            </div>
          ) : phase.kind === "signin" ? (
            <SigninForm ws={phase.ws} onSignIn={(input) => signIn(phase.ws, input)} onReset={(id) => requestReset(phase.ws.origin, id)} onNewPassword={(token, pw) => setNewPassword(phase.ws.origin, token, pw)}
              browserLabel={phase.ws.passkeys ? shell.browserSignin.withPasskeys : shell.browserSignin.withoutPasskeys}
              onBrowser={() => void openBrowser(phase.ws).catch(() => { setPhase({ kind: "signin", ws: phase.ws }); setError("Couldn't open the browser. Try again."); })}
              providers={phase.ws.providers}
              onProvider={(provider) => void openBrowser(phase.ws, provider).catch(() => { setPhase({ kind: "signin", ws: phase.ws }); setError("Couldn't open the browser. Try again."); })}
              onSignup={phase.ws.signup ? () => setPhase({ kind: "signup", ws: phase.ws, ...phase.ws.signup! }) : null}
              server={serverLine(phase.ws.origin)} />
          ) : phase.kind === "signup" ? (
            <SignupForm start={phase.start} passwordMin={phase.passwordMin} onSubmit={(input) => createAccount(phase.ws, input)} onStart={(email) => startSignup(phase.start!, email)} onBack={() => setPhase({ kind: "signin", ws: phase.ws })}
              providers={phase.start !== null ? phase.ws.providers : []} onProvider={(provider) => void openBrowser(phase.ws, provider).catch(() => { setPhase({ kind: "signup", ws: phase.ws, start: phase.start, passwordMin: phase.passwordMin }); setError("Couldn't open the browser. Try again."); })} />
          ) : phase.kind === "waiting" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <p className="state" role="status"><span className="spin" aria-hidden="true" />Waiting for you to approve this app in the browser…</p>
              <p className="fine">Sign in if asked, check that it names this device, then press Connect. You'll return here by yourself.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {phase.page ? <Button onClick={() => void shell.openBrowser(phase.page)}>Open the browser again</Button> : null}
                <Button onClick={cancel}>Start again</Button>
              </div>
            </div>
          ) : (
            <p className="state" role="status"><span className="spin" aria-hidden="true" />Connecting…</p>
          )}
        </div>
      </AuthFrame>
    </>
  );
}

/**
 * A new account: with an invitation code, the address it was sent to, a name and a password; where sign-up is open (`start`), with an
 * email address, which PURSS sends a link to that finishes the account in the browser.
 */
function SignupForm({ start, passwordMin, onSubmit, onStart, onBack, providers, onProvider }: {
  start: string | null; passwordMin: number; onSubmit: (input: Omit<ConnectSignupInput, "client" | "deviceName">) => Promise<string | null>; onStart: (email: string) => Promise<string | null>; onBack: () => void;
  providers: Workspace["providers"]; onProvider: (provider: Workspace["providers"][number]) => void;
}) {
  // Where anyone may sign up, an email address is asked; someone with an invitation can use it instead (it may carry more room).
  const [withInvite, setWithInvite] = useState(start === null);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = email.trim() !== "" && (!withInvite || (inviteFromLink(code).length >= 4 && [...password].length >= passwordMin));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError("");
    const failed = withInvite
      ? await onSubmit({ invitation: inviteFromLink(code), email: email.trim(), displayName: name.trim() || null, password })
      : await onStart(email.trim());
    if (failed) setError(failed); else if (!withInvite) setSent(email.trim());
    setBusy(false);
  }

  if (sent !== null) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <p className="state" role="status"><Icon name="check" /><span>Check your inbox: we sent a link to finish creating your account to {sent}.</span></p>
        <p className="fine">Open the link on this device. It finishes in your browser; then come back here and sign in with that email address and the password you chose.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={onBack}>Back to signing in</Button>
          <Button onClick={() => setSent(null)}>Use a different email address</Button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }} aria-label="Create an account">
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {providers.length ? (
        <>
          {providers.map((p) => <ProviderButton key={p.id} provider={p} disabled={busy} onClick={() => onProvider(p)} />)}
          <p className="fine" style={{ textAlign: "center" }}>Opens in your browser. Or make an account here with an email address:</p>
        </>
      ) : null}
      {withInvite ? (
        <Field label="Invitation code" htmlFor="su-c" hint="Or paste the invitation link">
          <TextInput id="su-c" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={300} />
        </Field>
      ) : null}
      <Field label="Email address" htmlFor="su-e" hint={withInvite ? "The one you were invited with" : "We'll email you a link"}>
        <TextInput id="su-e" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={withInvite ? "username" : "email"} spellCheck={false} autoCapitalize="none" maxLength={254} />
      </Field>
      {start !== null ? <p className="fine"><button type="button" className="link" onClick={() => setWithInvite(!withInvite)}>{withInvite ? "Sign up with an email address instead" : "I have an invitation code"}</button></p> : null}
      {withInvite ? (
        <>
          <Field label="Your name (optional)" htmlFor="su-n">
            <TextInput id="su-n" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} />
          </Field>
          <Field label="Password" htmlFor="su-p" hint={`${passwordMin}+ characters`}>
            <TextInput id="su-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={256} />
          </Field>
        </>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" type="submit" disabled={!ready || busy}>{withInvite ? (busy ? "Creating…" : "Create account") : busy ? "Sending…" : "Send me the link"}</Button>
        <Button onClick={onBack} disabled={busy}>Back</Button>
      </div>
      {withInvite ? <p className="fine">You can add fingerprint, face or screen lock later, under Settings → Security.</p> : null}
    </form>
  );
}

/** Signing in here: an email address and password; a passkey or linked account through the browser. */
function SigninForm({ ws, onSignIn, onReset, onNewPassword, onBrowser, browserLabel, providers, onProvider, onSignup, server }: {
  ws: Workspace; onSignIn: (input: SigninFields | { keepToken: string }) => Promise<SigninAnswer>; onReset: (email: string) => Promise<string | null>;
  onNewPassword: (token: string, password: string) => Promise<string | null>;
  onBrowser: () => void; browserLabel: string; providers: Workspace["providers"]; onProvider: (provider: Workspace["providers"][number]) => void;
  onSignup: (() => void) | null; server: ReactNode;
}) {
  const [mode, setMode] = useState<"password" | "reset" | "reset-sent" | "reset-done">("password");
  const [link, setLink] = useState("");
  const [newPassword, setNewPasswordText] = useState("");
  const [keep, setKeep] = useState<{ token: string; dueAt: string } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = mode === "password" ? email.trim() !== "" && password !== "" : email.trim() !== "";
  const go = (m: typeof mode) => { setMode(m); setError(""); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError("");
    if (mode === "reset") {
      const failed = await onReset(email.trim());
      setBusy(false);
      if (failed) setError(failed); else go("reset-sent");
      return;
    }
    const out = await onSignIn({ method: "password", email: email.trim(), password });
    if (out.keep) { setKeep(out.keep); setBusy(false); return; }
    if (out.error) { setError(out.error); setBusy(false); if (mode === "password") setPassword(""); }
  }

  async function keepAccount() {
    if (!keep || busy) return;
    setBusy(true); setError("");
    const out = await onSignIn({ keepToken: keep.token });
    if (out.error) { setError(out.error); setBusy(false); setKeep(null); }
  }

  if (keep) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <p className="state note" role="status"><Icon name="alert" /><span>This account is set to be deleted on {new Date(keep.dueAt).toLocaleDateString()}. Keep it, and nothing is deleted.</span></p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" disabled={busy} onClick={() => void keepAccount()}>{busy ? "Keeping…" : "Keep my account"}</Button>
          <Button disabled={busy} onClick={() => { setKeep(null); setPassword(""); }}>Not now</Button>
        </div>
      </div>
    );
  }

  async function passkey() {
    if (busy) return;
    setBusy(true); setError("");
    const out = await onSignIn({ method: "passkey" });
    if (out.keep) { setKeep(out.keep); setBusy(false); return; }
    if (out.error) { setError(out.error); setBusy(false); }
  }

  async function choosePassword(e: FormEvent) {
    e.preventDefault();
    const token = tokenFromLink(link);
    if (!token || !newPassword || busy) return;
    setBusy(true); setError("");
    const failed = await onNewPassword(token, newPassword);
    setBusy(false);
    if (failed) setError(failed); else { setNewPasswordText(""); setLink(""); go("reset-done"); }
  }

  if (mode === "reset-sent") {
    const token = tokenFromLink(link);
    return (
      <form onSubmit={choosePassword} style={{ display: "grid", gap: 12 }} aria-label="Choose a new password">
        <p className="state" role="status"><Icon name="check" /><span>If that email address has an account, a link to set a new password is on its way.</span></p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Field label="The link from the email" htmlFor="si-l" hint="Paste it from the email">
          <TextInput id="si-l" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" inputMode="url" />
        </Field>
        {link && !token ? <p className="fine" role="alert">That isn't the link from the email. Copy the whole link and try again.</p> : null}
        <Field label="New password" htmlFor="si-np" hint={ws.signup ? `${ws.signup.passwordMin}+ characters` : undefined}>
          <TextInput id="si-np" type="password" value={newPassword} onChange={(e) => setNewPasswordText(e.target.value)} autoComplete="new-password" maxLength={256} />
        </Field>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" type="submit" disabled={!token || !newPassword || busy}>{busy ? "Saving…" : "Set the new password"}</Button>
          <Button onClick={() => go("password")} disabled={busy}>Back to signing in</Button>
        </div>
      </form>
    );
  }
  if (mode === "reset-done") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <p className="state" role="status"><Icon name="check" /><span>Your new password is set. Sign in with it.</span></p>
        <div><Button variant="primary" onClick={() => go("password")}>Sign in</Button></div>
      </div>
    );
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }} aria-label="Sign in">
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <Field label="Email address" htmlFor="si-u" hint={mode === "reset" ? "We'll email a reset link" : undefined}>
        <TextInput id="si-u" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" maxLength={300} />
      </Field>
      {mode === "password" ? (
        <Field label="Password" htmlFor="si-p">
          <TextInput id="si-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={256} />
        </Field>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" type="submit" disabled={!ready || busy}>{busy ? (mode === "reset" ? "Sending…" : "Signing in…") : mode === "reset" ? "Send the link" : "Sign in"}</Button>
      </div>
      {ws.passkeys && mode !== "reset" ? <div><Button disabled={busy} onClick={() => void passkey()}><Icon name="key" />Sign in with fingerprint, face or screen lock</Button></div> : null}
      {mode !== "reset" ? providers.map((p) => <ProviderButton key={p.id} provider={p} disabled={busy} onClick={() => onProvider(p)} />) : null}
      <p className="fine" style={{ display: "flex", gap: "6px 14px", flexWrap: "wrap" }}>
        {mode !== "password" ? <button type="button" className="link" onClick={() => go("password")}>Use an email address and password</button> : null}
        {mode === "password" && ws.info.signin.passwordReset ? <button type="button" className="link" onClick={() => go("reset")}>Forgot your password?</button> : null}
        {mode === "reset" ? <button type="button" className="link" onClick={() => go("reset-sent")}>I already have a link</button> : null}
        <button type="button" className="link" onClick={onBrowser}>{browserLabel}</button>
      </p>
      {onSignup ? <p className="fine">New here? <button type="button" className="link" onClick={onSignup}>Create an account</button></p> : null}
      {server}
    </form>
  );
}

