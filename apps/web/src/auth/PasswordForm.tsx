import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { messageOf, put } from "../api/client.ts";
import { platform } from "../platform/index.ts";

export const PASSWORD_MIN = 10;
const USERNAME_RULE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/**
 * The username, password and password-again fields with their rules and hints. `username` is the lower-case name to send, and
 * `valid` says the three fields together can be saved.
 */
export function usePasswordFields(current: string | null = null): { fields: ReactNode; username: string; password: string; valid: boolean } {
  const [typed, setTyped] = useState(current ?? "");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const username = typed.trim().toLowerCase();
  const same = password === again;
  const valid = USERNAME_RULE.test(username) && [...password].length >= PASSWORD_MIN && same;
  const fields = (
    <>
      <Field label="Username" htmlFor="pw-u" hint="3 to 40 letters, digits, dots, dashes or underscores. Not case-sensitive.">
        <TextInput id="pw-u" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" />
      </Field>
      <Field label="Password" htmlFor="pw-p" hint={`At least ${PASSWORD_MIN} characters. A few unrelated words make a good one.`}>
        <TextInput id="pw-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Password again" htmlFor="pw-a">
        <TextInput id="pw-a" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={!!again && !same} />
      </Field>
      {again && !same ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>The two passwords are different.</p> : null}
    </>
  );
  return { fields, username, password, valid };
}

/** Changes the signed-in account's username and password. */
export function PasswordForm({ current, submitLabel, onDone, onCancel }: { current: string | null; submitLabel: string; onDone: () => void; onCancel?: () => void }) {
  const { fields, username, password, valid } = usePasswordFields(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError("");
    try { await put("/api/account/password", { username, password }); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12 }}>
      {fields}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" type="submit" disabled={busy || !valid}>{busy ? "Saving…" : submitLabel}</Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

/** Passkeys need HTTPS or localhost; elsewhere (a home server over plain HTTP) browsers refuse them. */
export function passkeysAvailable(): boolean {
  return platform.passkeys !== null;
}
