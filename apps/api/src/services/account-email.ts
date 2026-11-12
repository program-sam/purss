import { appUrl } from "@purss/domain";
import { z } from "zod";
import type { AccountEmail } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { accountEmail, checkNewPassword, writePassword } from "../auth/passwords.ts";
import { signOutEverywhere } from "../auth/sign-out.ts";
import { HttpError, addSeconds, nowIso, parse } from "../http.ts";
import { maskAddress, mailConfigured, sendLater } from "../mail/mailer.ts";
import { emailChangedMail, passwordChangedMail, resetMail, verifyMail } from "../mail/templates.ts";
import { randomToken, sha256 } from "../secrets.ts";

/*
 * An account's email address (plan/21, plan/27): every account has one, it is what the account signs in with, and each
 * address belongs to one account (compared without regard to case). Wherever outgoing email is set up an address is
 * proven by a link it received: sign-up and invitations make accounts with confirmed addresses, and a new address takes
 * effect only once confirmed, so a confirmed address receives password-reset links. Without outgoing email the
 * administrator makes every account, so addresses are taken as typed. Account linking and the administrator role never
 * look at it, and sign-in, sign-up and reset answers never reveal whether an address has an account.
 */

export const VERIFY_HOURS = 48;
export const RESET_MINUTES = 60;
const RESETS_PER_HOUR = 3;

export const emailSchema = z.string().trim().max(254).pipe(z.email({ message: "That doesn't look like an email address." }));

/** Whether addresses are sent links (confirmation, sign-up, password reset): wherever a mail server is set up, in any mode. */
export function accountEmailAvailable(app: App): boolean {
  return mailConfigured(app);
}

function requireAvailable(app: App): void {
  if (!accountEmailAvailable(app)) throw new HttpError(404, "not_available", "This server doesn't send email.");
}

/** The address waiting for its confirmation link to become the account's, if any. */
function pendingAddress(app: App, accountId: string, current: string | null): string | null {
  const row = app.db.get<{ email: string }>(
    "SELECT email FROM email_tokens WHERE account_id = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1", accountId, nowIso());
  return row && row.email !== current ? row.email : null;
}

export function getAccountEmail(app: App, accountId: string): AccountEmail {
  const row = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  const address = row?.email ?? null;
  return { available: accountEmailAvailable(app), address, confirmed: !!row?.email_verified_at, pending: accountEmailAvailable(app) ? pendingAddress(app, accountId, address) : null };
}

const takenByAnother = () => new HttpError(409, "email_in_use", "Another account already uses this email address.");

function usedByAnother(app: App, accountId: string, email: string): boolean {
  return !!app.db.get("SELECT 1 FROM accounts WHERE lower(email) = lower(?) AND id <> ?", email.trim(), accountId);
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
 * Change the account's address. Where email is set up the new address is sent a confirmation link and becomes the
 * account's only when it is used (confirmEmail); until then the current address stays, so the account can always be
 * signed in to. Without outgoing email the change applies at once.
 */
export function setAccountEmail(app: App, accountId: string, rawEmail: string): AccountEmail {
  const email = parse(emailSchema, rawEmail);
  if (!accountEmailAvailable(app)) {
    app.db.tx(() => {
      if (usedByAnother(app, accountId, email)) throw takenByAnother();
      app.db.run("UPDATE accounts SET email = ?, email_verified_at = NULL WHERE id = ?", email, accountId);
      audit(app, accountId, "email_set", accountId, "success", maskAddress(email));
    });
    return getAccountEmail(app, accountId);
  }
  const token = app.db.tx(() => {
    const before = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
    const same = before?.email?.toLowerCase() === email.toLowerCase();
    if (same && before?.email_verified_at) {
      // Back to the confirmed address: a pending change is dropped.
      app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND purpose = 'verify' AND used_at IS NULL", accountId);
      return null;
    }
    // Whether another account has it is told only to whoever proves the address (confirmEmail), not here.
    const target = same ? before!.email! : email;
    audit(app, accountId, "email_set", accountId, "success", maskAddress(target));
    return { value: issueToken(app, accountId, "verify", target, VERIFY_HOURS * 3600), target };
  });
  if (token) sendVerification(app, accountId, token.target, token.value);
  return getAccountEmail(app, accountId);
}

/** Send a fresh confirmation link to the address waiting for one: a pending new address, else an unconfirmed current one. */
export function resendVerification(app: App, accountId: string): AccountEmail {
  requireAvailable(app);
  const row = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  const target = pendingAddress(app, accountId, row?.email ?? null) ?? (row?.email && !row.email_verified_at ? row.email : null);
  if (!target) return getAccountEmail(app, accountId);
  const token = app.db.tx(() => issueToken(app, accountId, "verify", target, VERIFY_HOURS * 3600));
  sendVerification(app, accountId, target, token);
  return getAccountEmail(app, accountId);
}

const SPENT = "That link has expired or was already used.";

/**
 * Confirm an address from the link in the message. Works signed in or not: the link is the proof. A link for a new
 * address makes it the account's (unless another account has it by now) and tells the previous confirmed address.
 */
export function confirmEmail(app: App, token: string): void {
  requireAvailable(app);
  const changed = app.db.tx(() => {
    const row = app.db.get<{ account_id: string; email: string }>(
      "SELECT account_id, email FROM email_tokens WHERE id = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?", sha256(token), nowIso());
    const account = row ? app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", row.account_id) : null;
    // An account whose data was removed has no address left to confirm or change.
    if (!row || !account?.email) throw new HttpError(400, "link_spent", `${SPENT} Send a new one from Settings → Security.`);
    if (row.email !== account.email && usedByAnother(app, row.account_id, row.email)) throw takenByAnother();
    app.db.run("UPDATE email_tokens SET used_at = ? WHERE id = ?", nowIso(), sha256(token));
    app.db.run("UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?", row.email, nowIso(), row.account_id);
    audit(app, row.account_id, "email_verify", row.account_id, "success");
    if (row.email === account.email) return null;
    // Links made for the old address (a reset in flight) stop working with it.
    app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND used_at IS NULL", row.account_id);
    return { accountId: row.account_id, previous: account.email_verified_at ? account.email : null, now: row.email };
  });
  if (changed?.previous) sendLater(app, "email_changed", changed.accountId, emailChangedMail(changed.previous, { masked: maskAddress(changed.now) }));
}

type ResetTarget = { id: string; email: string };

/**
 * Ordinary, active accounts with a password and a confirmed address. Administrators reset with the
 * operator's `password-reset-link`. An account in its deletion grace period can still reset its password
 * (then signing in offers to keep it); one whose removal has started can't.
 */
function resetTarget(app: App, email: string): ResetTarget | undefined {
  return app.db.get<ResetTarget>(
    `SELECT a.id, a.email FROM accounts a JOIN sign_in_methods m ON m.account_id = a.id AND m.kind = 'password'
     WHERE lower(a.email) = lower(?) AND a.status = 'active' AND a.email_verified_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.account_id = a.id AND d.state = 'purging')
       AND NOT EXISTS (SELECT 1 FROM role_grants r WHERE r.account_id = a.id AND r.role = 'admin')`, email.trim());
}

const sameAccount = <T extends { id: string }>(t: T | undefined, accountId: string): T | undefined => (t?.id === accountId ? t : undefined);

/** What a reset link made at the server (hostResetLink) holds in place of the address a link was sent to. */
const MADE_AT_SERVER = "";

/** An active account with a password whose removal hasn't started: whoever holds a reset link made at the server for it may choose a new password. */
function hostResetTarget(app: App, accountId: string): { id: string; email: string | null } | undefined {
  return app.db.get<{ id: string; email: string | null }>(
    `SELECT a.id, CASE WHEN a.email_verified_at IS NOT NULL THEN a.email END AS email
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

/** Send a reset link to a confirmed address. Says nothing about whether it has an account. */
export function requestPasswordReset(app: App, email: string): void {
  requireAvailable(app);
  const t = resetTarget(app, email);
  if (t) {
    const recent = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ? AND purpose = 'reset' AND created_at > ?", t.id, addSeconds(-3600))!.n;
    if (recent >= RESETS_PER_HOUR) return;
    const token = app.db.tx(() => {
      // Spent links are kept for the count above; only unused ones are replaced.
      app.db.run("UPDATE email_tokens SET expires_at = ? WHERE account_id = ? AND purpose = 'reset' AND used_at IS NULL", nowIso(), t.id);
      const value = randomToken(32);
      app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, 'reset', ?, ?, ?)",
        sha256(value), t.id, t.email, nowIso(), addSeconds(RESET_MINUTES * 60));
      audit(app, t.id, "password_reset_request", t.id, "success");
      return value;
    });
    sendLater(app, "reset", t.id, resetMail(t.email, { link: link(app, "/reset-password", token), minutes: RESET_MINUTES }));
  }
}

/**
 * Choose a new password with a reset link. The address stays; the account is signed out
 * everywhere (sessions, connected apps, assistants: auth/sign-out.ts), and its confirmed address is told.
 */
export async function resetPassword(app: App, token: string, password: string): Promise<void> {
  const id = sha256(token);
  const row = app.db.get<{ account_id: string; email: string }>(
    "SELECT account_id, email FROM email_tokens WHERE id = ? AND purpose = 'reset' AND used_at IS NULL AND expires_at > ?", id, nowIso());
  const spent = () => new HttpError(400, "link_spent", `${SPENT} Ask for a new one on the sign-in page.`);
  // A link sent by email only works for an account that still qualifies for one; a link made at the server needs only a usable account.
  const targetNow = (): { id: string; email: string | null } | undefined => !row ? undefined
    : row.email === MADE_AT_SERVER ? hostResetTarget(app, row.account_id)
    : sameAccount(resetTarget(app, row.email), row.account_id);
  const target = targetNow();
  if (!row || !target) throw spent();
  checkNewPassword(password, accountEmail(app, target.id));
  const claimed = app.db.run("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", nowIso(), id);
  if (claimed.changes !== 1) throw spent();
  // Hashing takes a while: the account may have started being removed meanwhile.
  await writePassword(app, target.id, password, (write) => app.db.tx(() => {
    if (targetNow()?.id !== target.id) throw spent();
    write();
  }));
  app.db.tx(() => {
    signOutEverywhere(app, target.id, "everything");
    audit(app, target.id, "password_reset", target.id, "success");
  });
  if (target.email) sendLater(app, "password_changed", target.id, passwordChangedMail(target.email));
}
