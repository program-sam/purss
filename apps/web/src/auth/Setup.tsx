import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Check, Field, TextInput } from "@purss/ui";
import { post } from "../api/client.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { useNewAccount } from "./new-account.tsx";
import { usePasswordFields } from "./PasswordForm.tsx";
import { app } from "@purss/translations/app";

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
      footer={<Button variant="primary" type="submit" form="setup-form" disabled={account.busy || !valid || !code.trim() || !email.trim()}>{account.busy ? app.words.checking : app.words.continue}</Button>}
    >
      <form id="setup-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <Field label={mode === "setup" ? t.setupCode : app.words.invitationCode} htmlFor="auth-code">
          <TextInput id="auth-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus={!initialCode} aria-invalid={!!account.error} aria-describedby={account.error ? "auth-error" : undefined} />
        </Field>
        <Field label={app.words.emailAddress} htmlFor="auth-email" hint={mode === "setup" ? undefined : app.words.theOneYouWereInvitedWith}>
          <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus={!!initialCode && !initialEmail} maxLength={254} />
        </Field>
        <Field label={app.words.displayNameOptional} htmlFor="auth-name">
          <TextInput id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />
        </Field>
        {fields}
        <Check checked={sharedComputer} onChange={setSharedComputer} hint={app.words.signsOutWhenTheBrowserCloses}>{app.words.thisIsASharedComputer}</Check>
        {account.error ? <p id="auth-error" className="state note" role="alert">{account.error}</p> : null}
      </form>
    </AuthFrame>
  );
}
