import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Check, Field, TextInput } from "@purss/ui";
import { post } from "../api/client.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { useNewAccount } from "./new-account.tsx";
import { usePasswordFields } from "./PasswordForm.tsx";

/** First run, or an invitation: make the account with an email address and a password, then optionally add a passkey. */
export function SetupPage({ mode = "setup", initialCode = "", initialEmail = "" }: { mode?: "setup" | "invite"; initialCode?: string; initialEmail?: string }) {
  const [code, setCode] = useState(initialCode);
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState("");
  const [sharedComputer, setSharedComputer] = useState(false);
  const { fields, password, valid } = usePasswordFields(email);
  const account = useNewAccount();

  function submit(e: FormEvent) {
    e.preventDefault();
    void account.submit(() => post(mode === "setup" ? "/api/setup/claim" : "/api/invites/accept", { code: code.trim(), email: email.trim(), displayName: name.trim() || null, password, sharedComputer }));
  }

  if (account.passkey) return account.passkey;
  return (
    <AuthFrame
      title={mode === "setup" ? "Set up your PURSS" : "Accept your invitation"}
      intro={mode === "setup"
        ? "Enter the setup code from the server. It was printed when the server started and is saved in the secrets folder of its data directory."
        : "Enter the invitation code you were sent, and the email address it was sent to, to create your account."}
      footer={<Button variant="primary" type="submit" form="setup-form" disabled={account.busy || !valid || !code.trim() || !email.trim()}>{account.busy ? "Checking…" : "Continue"}</Button>}
    >
      <form id="setup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <Field label={mode === "setup" ? "Setup code" : "Invitation code"} htmlFor="auth-code">
          <TextInput id="auth-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus={!initialCode} aria-invalid={!!account.error} aria-describedby={account.error ? "auth-error" : undefined} />
        </Field>
        <Field label="Email address" htmlFor="auth-email" hint={mode === "setup" ? undefined : "The one you were invited with"}>
          <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus={!!initialCode && !initialEmail} maxLength={254} />
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
