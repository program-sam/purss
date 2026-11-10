import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { messageOf, put } from "../api/client.ts";
import { platform } from "../platform/index.ts";

export const PASSWORD_MIN = 10;
const USERNAME_RULE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** Sets or changes the signed-in account's username and password. */
export function PasswordForm({ current, submitLabel, onDone, onCancel }: { current: string | null; submitLabel: string; onDone: () => void; onCancel?: () => void }) {
  const [username, setUsername] = useState(current ?? "");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = username.trim().toLowerCase();
  const nameOk = USERNAME_RULE.test(name);
  const long = [...password].length >= PASSWORD_MIN;
  const same = password === again;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || !long || !same) return;
    setBusy(true); setError("");
    try { await put("/api/account/password", { username: name, password }); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <Field label="Username" htmlFor="pw-u" hint="3 to 40 letters, digits, dots, dashes or underscores. Not case-sensitive.">
        <TextInput id="pw-u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" />
      </Field>
      <Field label="Password" htmlFor="pw-p" hint={`At least ${PASSWORD_MIN} characters. A few unrelated words make a good one.`}>
        <TextInput id="pw-p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Password again" htmlFor="pw-a">
        <TextInput id="pw-a" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={!!again && !same} />
      </Field>
      {again && !same ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>The two passwords are different.</p> : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" type="submit" disabled={busy || !nameOk || !long || !same}>{busy ? "Saving…" : submitLabel}</Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

/** Passkeys need HTTPS or localhost; elsewhere (a home server over plain HTTP) browsers refuse them. */
export function passkeysAvailable(): boolean {
  return platform.passkeys !== null;
}
