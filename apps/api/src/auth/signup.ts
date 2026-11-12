import { appUrl } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, consumeRateLimit, nowIso } from "../http.ts";
import { sendLater, signupOpen } from "../mail/mailer.ts";
import { accountExistsMail, signupMail } from "../mail/templates.ts";
import { randomToken, sha256 } from "../secrets.ts";
import { VERIFY_HOURS } from "../services/account-email.ts";
import { createAccount, emailInUse, openSignup } from "./accounts.ts";
import type { PreparedPassword } from "./passwords.ts";

/*
 * Open sign-up (hosted, with working email) starts with the address: a single-use link goes there, and the account is made
 * only when the link is used, so every account made this way has a confirmed address and an address nobody confirmed holds
 * nothing. The answer to the first step is always the same; an address that already has an account is sent a note saying
 * so instead of a link, so whether an address has an account stays private.
 */

/** Messages one address can be sent by sign-up in an hour, so sign-up can't be used to flood a mailbox. */
const MAILS_PER_ADDRESS = 3;

/** Send the link that finishes sign-up (or the "you already have an account" note). Says nothing about which. */
export function startSignup(app: App, email: string): void {
  if (!signupOpen(app)) throw new HttpError(403, "closed", "New accounts are by invitation only here.");
  const address = email.trim();
  if (!consumeRateLimit(`signup-mail:${address.toLowerCase()}`, MAILS_PER_ADDRESS, 60 * 60_000).allowed) return;
  const origin = app.config.publicOrigin;
  if (emailInUse(app, address)) {
    sendLater(app, "account_exists", null, accountExistsMail(address, { signIn: `${origin}${appUrl("/")}`, reset: `${origin}${appUrl("/reset-password")}`, origin }));
    return;
  }
  const token = randomToken(32);
  app.db.run("INSERT INTO signup_requests (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)", sha256(token), address, nowIso(), addSeconds(VERIFY_HOURS * 3600));
  sendLater(app, "signup", null, signupMail(address, { link: `${origin}${appUrl("/signup")}?token=${encodeURIComponent(token)}`, hours: VERIFY_HOURS, origin }));
}

const spent = () => new HttpError(400, "link_spent", "That link has expired or was already used. Start again to get a new one.");

function pendingRequest(app: App, token: string): { email: string } {
  const row = app.db.get<{ email: string }>("SELECT email FROM signup_requests WHERE id = ? AND used_at IS NULL AND expires_at > ?", sha256(token), nowIso());
  if (!row) throw spent();
  return row;
}

/** The address a sign-up link is for, to show on the page that finishes it. */
export function signupRequestEmail(app: App, token: string): string {
  if (!signupOpen(app)) throw new HttpError(403, "closed", "New accounts are by invitation only here.");
  return pendingRequest(app, token).email;
}

/**
 * Finish sign-up with the link: the account is made with the confirmed address, under open sign-up's capacity and
 * bookkeeping (openSignup), and the link is spent in the same transaction.
 */
export function finishSignup(app: App, token: string, displayName: string | null, password: PreparedPassword, address: string, attemptRetryAt: number | null = null): { accountId: string } {
  return openSignup(app, address, attemptRetryAt, () => {
    const { email } = pendingRequest(app, token);
    app.db.run("UPDATE signup_requests SET used_at = ? WHERE id = ?", nowIso(), sha256(token));
    const { accountId } = createAccount(app, { email, emailConfirmed: true, displayName, admin: false, allocationBytes: app.config.defaultAllocationBytes, grantedBy: null, password });
    audit(app, accountId, "email_verify", accountId, "success", "signup");
    return accountId;
  });
}
