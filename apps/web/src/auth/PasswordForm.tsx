import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { messageOf, put } from "../api/client.ts";
import { platform } from "../platform/index.ts";

export const PASSWORD_MIN = 10;

/**
 * The password and password-again fields with their rules and hints. `email` is the address the password goes with, which it
 * may not be the same as. `replacing`: they follow the current password, so they are labelled as the new one. `valid` says the
 * fields together can be saved.
 */
export function usePasswordFields(email: string | null = null, replacing = false): { fields: ReactNode; password: string; valid: boolean } {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const same = password === again;
  const address = email?.trim().toLowerCase();
  const isEmail = !!address && password.toLowerCase() === address;
  const valid = [...password].length >= PASSWORD_MIN && same && !isEmail;
  const fields = (
    <>
      <Field label={replacing ? "New password" : "Password"} htmlFor="pw-p" hint={`${PASSWORD_MIN}+ characters`}>
        <TextInput id="pw-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label={replacing ? "New password again" : "Password again"} htmlFor="pw-a">
        <TextInput id="pw-a" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={!!again && !same} />
      </Field>
      {again && !same ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>The two passwords are different.</p> : null}
      {isEmail ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>The password can't be the same as your email address.</p> : null}
    </>
  );
  return { fields, password, valid };
}

/**
 * Changes the signed-in account's password, which takes the current one (`hasPassword`), or adds a first one to an account
 * made with a provider (that needs a recent sign-in, confirmed before the form opens).
 */
export function PasswordForm({ email, hasPassword, submitLabel, onDone, onCancel }: { email: string | null; hasPassword: boolean; submitLabel: string; onDone: () => void; onCancel?: () => void }) {
  const { fields, password, valid } = usePasswordFields(email, hasPassword);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = valid && (!hasPassword || current !== "");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError("");
    try { await put("/api/account/password", hasPassword ? { currentPassword: current, password } : { password }); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12 }}>
      {hasPassword ? (
        <Field label="Current password" htmlFor="pw-c">
          <TextInput id="pw-c" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
      ) : null}
      {fields}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" type="submit" disabled={busy || !ready}>{busy ? "Saving…" : submitLabel}</Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

/** Passkeys need HTTPS or localhost; elsewhere (a home server over plain HTTP) browsers refuse them. */
export function passkeysAvailable(): boolean {
  return platform.passkeys !== null;
}
