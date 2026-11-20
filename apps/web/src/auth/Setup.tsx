import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Check, Field, TextInput } from "@purss/ui";
import { post } from "../api/client.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { useNewAccount } from "./new-account.tsx";
import { usePasswordFields } from "./PasswordForm.tsx";
import { app } from "@purss/copy/app";

const t = app.auth.setup;

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
      title={mode === "setup" ? t.setupTitle : t.inviteTitle}
      intro={mode === "setup"
        ? t.setupIntro
        : t.inviteIntro}
      footer={<Button variant="primary" type="submit" form="setup-form" disabled={account.busy || !valid || !code.trim() || !email.trim()}>{account.busy ? t.checking : t.continue}</Button>}
    >
      <form id="setup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <Field label={mode === "setup" ? t.setupCode : t.invitationCode} htmlFor="auth-code">
          <TextInput id="auth-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus={!initialCode} aria-invalid={!!account.error} aria-describedby={account.error ? "auth-error" : undefined} />
        </Field>
        <Field label={t.emailLabel} htmlFor="auth-email" hint={mode === "setup" ? undefined : t.invitedEmailHint}>
          <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus={!!initialCode && !initialEmail} maxLength={254} />
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
