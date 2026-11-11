import { appUrl } from "@purss/domain";
import { z } from "zod";
import type { AccountEmail } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { checkNewPassword, writePassword } from "../auth/passwords.ts";
import { signOutEverywhere } from "../auth/sign-out.ts";
import { HttpError, addSeconds, nowIso, parse } from "../http.ts";
import { maskAddress, mailConfigured, sendLater } from "../mail/mailer.ts";
import { emailChangedMail, passwordChangedMail, resetMail, verifyMail } from "../mail/templates.ts";
import { randomToken, sha256 } from "../secrets.ts";

/*
 * An account's email address and what it is used for (plan/27): wherever outgoing email is set
 * up, a confirmed address receives a password-reset link; only hosted open sign-up requires one.
 * Once confirmed it can be typed in place of the username for a password sign-in (auth/passwords.ts), only
 * when exactly one account has it; account linking and the administrator role never look at it, several
 * accounts may share one, and answers never reveal whether an address or username exists.
 */

export const VERIFY_HOURS = 48;
export const RESET_MINUTES = 60;
const RESETS_PER_HOUR = 3;

export const emailSchema = z.string().trim().max(254).pipe(z.email({ message: "That doesn't look like an email address." }));

/**
 * Account addresses, confirmation and password reset are offered whenever the installation has a
 * mail server set up, in any mode. Without one there is no address field at all.
 */
export function accountEmailAvailable(app: App): boolean {
  return mailConfigured(app);
}

function requireAvailable(app: App): void {
  if (!accountEmailAvailable(app)) throw new HttpError(404, "not_available", "Email isn't used for accounts on this installation.");
}

export function getAccountEmail(app: App, accountId: string): AccountEmail {
  const row = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  return { available: accountEmailAvailable(app), address: row?.email ?? null, confirmed: !!row?.email_verified_at };
}

function issueToken(app: App, accountId: string, purpose: "verify" | "reset", email: string, seconds: number): string {
  app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND purpose = ? AND used_at IS NULL", accountId, purpose);
  const token = randomToken(32);
  app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    sha256(token), accountId, purpose, email, nowIso(), addSeconds(seconds));
  return token;
}

const link = (app: App, path: string, token: string) => `${app.config.publicOrigin}${appUrl(path)}?token=${encodeURIComponent(token)}`;

function sendVerification(app: App, accountId: string, email: string, token: string): void {
  sendLater(app, "verify", accountId, verifyMail(email, { link: link(app, "/verify-email", token), hours: VERIFY_HOURS }));
}

/**
 * Set the account's address (unconfirmed) and send a confirmation link; a previously confirmed
 * address is told about the change. Run inside the caller's transaction where there is one.
 */
export function setAccountEmail(app: App, accountId: string, rawEmail: string): AccountEmail {
  requireAvailable(app);
  const email = parse(emailSchema, rawEmail);
  const sent = app.db.tx(() => {
    const before = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
    if (before?.email && before.email.toLowerCase() === email.toLowerCase() && before.email_verified_at) return null;
    app.db.run("UPDATE accounts SET email = ?, email_verified_at = NULL WHERE id = ?", email, accountId);
    app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND used_at IS NULL", accountId);
    const token = issueToken(app, accountId, "verify", email, VERIFY_HOURS * 3600);
    audit(app, accountId, "email_set", accountId, "success", maskAddress(email));
    return { token, previous: before?.email_verified_at && before.email ? before.email : null };
  });
  if (sent) {
    sendVerification(app, accountId, email, sent.token);
    if (sent.previous && sent.previous.toLowerCase() !== email.toLowerCase()) sendLater(app, "email_changed", accountId, emailChangedMail(sent.previous, { masked: maskAddress(email) }));
  }
  return getAccountEmail(app, accountId);
}

/** Send a fresh confirmation link to the account's unconfirmed address. */
export function resendVerification(app: App, accountId: string): AccountEmail {
  requireAvailable(app);
  const row = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  if (!row?.email) throw new HttpError(400, "no_email", "Add an email address first.");
  if (row.email_verified_at) return getAccountEmail(app, accountId);
  const token = app.db.tx(() => issueToken(app, accountId, "verify", row.email!, VERIFY_HOURS * 3600));
  sendVerification(app, accountId, row.email, token);
  return getAccountEmail(app, accountId);
}

const SPENT = "That link has expired or was already used.";

/** Confirm an address from the link in the message. Works signed in or not: the link is the proof. */
export function confirmEmail(app: App, token: string): void {
  requireAvailable(app);
  app.db.tx(() => {
    const row = app.db.get<{ account_id: string; email: string }>(
      "SELECT account_id, email FROM email_tokens WHERE id = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?", sha256(token), nowIso());
    const account = row ? app.db.get<{ email: string | null }>("SELECT email FROM accounts WHERE id = ?", row.account_id) : null;
    if (!row || account?.email !== row.email) throw new HttpError(400, "link_spent", `${SPENT} Send a new one from Settings → Security.`);
    app.db.run("UPDATE email_tokens SET used_at = ? WHERE id = ?", nowIso(), sha256(token));
    app.db.run("UPDATE accounts SET email_verified_at = ? WHERE id = ?", nowIso(), row.account_id);
    audit(app, row.account_id, "email_verify", row.account_id, "success");
  });
}

type ResetTarget = { id: string; email: string; username: string };

/**
 * Ordinary, active accounts with a password and a confirmed address. Administrators reset with the
 * operator's `password-reset-link`. An account in its deletion grace period can still reset its password
 * (then signing in offers to keep it); one whose removal has started can't.
 */
function resetTargets(app: App, identifier: string): ResetTarget[] {
  const value = identifier.trim();
  const base = `SELECT a.id, a.email, m.label AS username FROM accounts a JOIN sign_in_methods m ON m.account_id = a.id AND m.kind = 'password'
    WHERE a.status = 'active' AND a.email IS NOT NULL AND a.email_verified_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.account_id = a.id AND d.state = 'purging')
      AND NOT EXISTS (SELECT 1 FROM role_grants r WHERE r.account_id = a.id AND r.role = 'admin')`;
  return value.includes("@")
    ? app.db.all<ResetTarget>(`${base} AND lower(a.email) = lower(?) LIMIT 5`, value)
    : app.db.all<ResetTarget>(`${base} AND m.label = ? LIMIT 1`, value.toLowerCase());
}

/** What a reset link made at the server (hostResetLink) holds in place of the address a link was sent to. */
const MADE_AT_SERVER = "";

/** An active account with a password whose removal hasn't started: whoever holds a reset link made at the server for it may choose a new password. */
function hostResetTarget(app: App, accountId: string): { id: string; email: string | null; username: string } | undefined {
  return app.db.get<{ id: string; email: string | null; username: string }>(
    `SELECT a.id, CASE WHEN a.email_verified_at IS NOT NULL THEN a.email END AS email, m.label AS username
     FROM accounts a JOIN sign_in_methods m ON m.account_id = a.id AND m.kind = 'password'
     WHERE a.id = ? AND a.status = 'active' AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.account_id = a.id AND d.state = 'purging')`, accountId);
}

/**
 * A single-use reset link for an account, made at the server by its operator (cli.ts `password-reset-link`) for someone who
 * can't sign in and has no email to receive one: on installations without outgoing email, and for administrators, who don't
 * reset by email. It is the same link the email flow sends, and works without email being set up. Run inside the caller's transaction.
 */
export function hostResetLink(app: App, accountId: string): { link: string; minutes: number } {
  if (!hostResetTarget(app, accountId)) throw new HttpError(404, "no_password", "That account has no password to reset.");
  return { link: link(app, "/reset-password", issueToken(app, accountId, "reset", MADE_AT_SERVER, RESET_MINUTES * 60)), minutes: RESET_MINUTES };
}

/** Send reset links for a username or a confirmed address. Says nothing about whether either exists. */
export function requestPasswordReset(app: App, identifier: string): void {
  requireAvailable(app);
  for (const t of resetTargets(app, identifier)) {
    const recent = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ? AND purpose = 'reset' AND created_at > ?", t.id, addSeconds(-3600))!.n;
    if (recent >= RESETS_PER_HOUR) continue;
    const token = app.db.tx(() => {
      // Spent links are kept for the count above; only unused ones are replaced.
      app.db.run("UPDATE email_tokens SET expires_at = ? WHERE account_id = ? AND purpose = 'reset' AND used_at IS NULL", nowIso(), t.id);
      const value = randomToken(32);
      app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, 'reset', ?, ?, ?)",
        sha256(value), t.id, t.email, nowIso(), addSeconds(RESET_MINUTES * 60));
      audit(app, t.id, "password_reset_request", t.id, "success");
      return value;
    });
    sendLater(app, "reset", t.id, resetMail(t.email, { link: link(app, "/reset-password", token), username: t.username, minutes: RESET_MINUTES }));
  }
}

/**
 * Choose a new password with a reset link. The username stays; the account is signed out
 * everywhere (sessions, connected apps, assistants: auth/sign-out.ts), and its confirmed address is told.
 */
export async function resetPassword(app: App, token: string, password: string): Promise<void> {
  const id = sha256(token);
  const row = app.db.get<{ account_id: string; email: string }>(
    "SELECT account_id, email FROM email_tokens WHERE id = ? AND purpose = 'reset' AND used_at IS NULL AND expires_at > ?", id, nowIso());
  const spent = () => new HttpError(400, "link_spent", `${SPENT} Ask for a new one on the sign-in page.`);
  // A link sent by email only works for an account that still qualifies for one; a link made at the server needs only a usable account.
  const targetNow = (): { id: string; email: string | null; username: string } | undefined => !row ? undefined
    : row.email === MADE_AT_SERVER ? hostResetTarget(app, row.account_id)
    : resetTargets(app, row.email).find((t) => t.id === row.account_id);
  const target = targetNow();
  if (!row || !target) throw spent();
  checkNewPassword(target.username, password);
  const claimed = app.db.run("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", nowIso(), id);
  if (claimed.changes !== 1) throw spent();
  // Hashing takes a while: the account may have started being removed meanwhile.
  await writePassword(app, target.id, target.username, password, (write) => app.db.tx(() => {
    if (targetNow()?.id !== target.id) throw spent();
    write();
  }));
  app.db.tx(() => {
    signOutEverywhere(app, target.id, "everything");
    audit(app, target.id, "password_reset", target.id, "success");
  });
  if (target.email) sendLater(app, "password_changed", target.id, passwordChangedMail(target.email));
}
