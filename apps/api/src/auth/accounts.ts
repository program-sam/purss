import type { IncomingMessage, ServerResponse } from "node:http";
import { newId } from "@purss/domain";
import type { SessionInfo } from "@purss/domain";
import { STEP_UP_SECONDS } from "../app.ts";
import type { App, Ctx, Principal } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, consumeRateLimit, nowIso, setCookie } from "../http.ts";
import { hashSecret, humanCode, normalizeCode, randomToken, sha256, verifySecret, writeSecret, readSecret, removeSecret } from "../secrets.ts";
import { normalizeEmail, storePassword, verifyPassword, writePassword } from "./passwords.ts";
import { canConfirm, linkedProviders } from "./providers.ts";
import type { PreparedPassword } from "./passwords.ts";
import { enqueue } from "../services/jobs.ts";
import { mailConfigured, signupOpen } from "../mail/mailer.ts";
import { accountEmailAvailable, resendVerification } from "../services/account-email.ts";
import { isAccountUsable, refuseDeletingSignIn } from "../services/deletion.ts";
import { initialPlan } from "../services/plans.ts";
import { runAccountCreated } from "../services/account-hooks.ts";
import { DEVICE_SESSION_PREFIX, IDLE_DAYS, idleCutoff } from "../connect/devices.ts";

export const SESSION_COOKIE = "purss_session";
const SESSION_DAYS = 30;
const SHARED_SESSION_SECONDS = 8 * 60 * 60;

// ---------- installation state ----------

export function getInstallation(app: App, key: string): string | null {
  return app.db.get<{ value: string }>("SELECT value FROM installation WHERE key = ?", key)?.value ?? null;
}
export function setInstallation(app: App, key: string, value: string): void {
  app.db.run("INSERT INTO installation (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export function accountCount(app: App): number {
  return app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n;
}

/**
 * First-run protection: an unclaimed installation has a one-time setup code written
 * to the secrets directory (readable only by the operator), never a first-visitor-wins page.
 */
export function ensureClaimCode(app: App): string | null {
  if (accountCount(app) > 0) {
    removeSecret(app.config.secretsDir, "setup-code");
    return null;
  }
  const existing = readSecret(app.config.secretsDir, "setup-code");
  if (existing && getInstallation(app, "claim_hash")) return existing;
  const code = humanCode(5);
  setInstallation(app, "claim_hash", hashSecret(normalizeCode(code)));
  writeSecret(app.config.secretsDir, "setup-code", code);
  return code;
}

// ---------- accounts ----------

/**
 * Whether an account has this address (compared without regard to case). Each address belongs to one account
 * (accounts_email), confirmed or not.
 */
export function emailInUse(app: App, email: string): boolean {
  return !!app.db.get("SELECT 1 FROM accounts WHERE lower(email) = lower(?)", email.trim());
}

/**
 * Every account is made with its email address and password (hashed beforehand: preparePassword), except one made by
 * signing in with a provider (signupWithProvider), which has no password until its owner adds one. `emailConfirmed` says
 * whether the address was proven (a link it received, or a provider that vouched for it). An address another account
 * has is refused (409 email_in_use).
 */
export function createAccount(app: App, opts: { email: string; emailConfirmed: boolean; displayName: string | null; admin: boolean; allocationBytes: number | null; grantedBy: string | null; password: PreparedPassword | null }): { accountId: string; workspaceId: string } {
  const accountId = newId("acc");
  const workspaceId = newId("wsp");
  const now = nowIso();
  if (emailInUse(app, opts.email)) throw new HttpError(409, "email_in_use", "An account with this email address already exists. Sign in instead, or reset its password.");
  app.db.run("INSERT INTO accounts (id, display_name, email, email_verified_at, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    accountId, opts.displayName, opts.email.trim(), opts.emailConfirmed ? now : null, initialPlan(app), now);
  if (opts.password) storePassword(app, accountId, opts.password);
  app.db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES (?, ?, ?)", workspaceId, accountId, now);
  app.db.run("INSERT INTO storage_accounts (account_id, allocation_bytes) VALUES (?, ?)", accountId, opts.allocationBytes);
  if (opts.admin) app.db.run("INSERT INTO role_grants (account_id, role, granted_at, granted_by) VALUES (?, 'admin', ?, ?)", accountId, now, opts.grantedBy);
  // Each account gets its own engine user (never one shared upstream user).
  const engineUserId = newId("eng");
  const username = `purss${engineUserId.slice(-12)}`;
  app.db.run("INSERT INTO engine_users (id, account_id, workspace_id, username, created_at) VALUES (?, ?, ?, ?, ?)", engineUserId, accountId, workspaceId, username, now);
  enqueue(app, "engine.provision", { engineUserId, username }, { accountId, workspaceId, idempotencyKey: `provision:${engineUserId}`, maxAttempts: 20 });
  // Such as the installation's news source with its newest posts (services/news.ts), from the first visit on.
  runAccountCreated(app, accountId, workspaceId);
  return { accountId, workspaceId };
}

// ---------- sessions ----------

export function startSession(app: App, res: ServerResponse, req: IncomingMessage, accountId: string, method: string, opts: { sharedComputer?: boolean } = {}): string {
  const token = randomToken(32);
  const now = nowIso();
  const sharedComputer = opts.sharedComputer === true;
  const expiresAt = addSeconds(sharedComputer ? SHARED_SESSION_SECONDS : SESSION_DAYS * 86400);
  const status = app.db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", accountId)?.status;
  if (status !== "active") throw new HttpError(403, "suspended", "This account is suspended. Contact the administrator.");
  refuseDeletingSignIn(app, res, accountId, method);
  app.db.run("INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, user_agent, session_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    sha256(token), accountId, randomToken(18), now, expiresAt, now, now, method, String(req.headers["user-agent"] ?? "").slice(0, 200), sharedComputer ? "shared" : "persistent");
  setCookie(res, SESSION_COOKIE, token, { ...(sharedComputer ? {} : { maxAge: SESSION_DAYS * 86400 }), secure: app.config.publicOrigin.startsWith("https:") });
  audit(app, accountId, "sign_in", method, "success");
  return sha256(token);
}

/** Mark the current session (or phone app) as freshly authenticated (step-up). */
export function refreshAuth(app: App, sessionId: string): void {
  if (sessionId.startsWith(DEVICE_SESSION_PREFIX)) {
    app.db.run("UPDATE device_tokens SET auth_at = ? WHERE id = ? AND kind = 'mobile'", nowIso(), sessionId.slice(DEVICE_SESSION_PREFIX.length));
    return;
  }
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", nowIso(), sessionId);
}

export function endSession(app: App, res: ServerResponse, sessionId: string | null): void {
  if (sessionId && app.db.run("DELETE FROM sessions WHERE id = ?", sessionId).changes) app.events.emit(`session:${sessionId}`, "revoked");
  setCookie(res, SESSION_COOKIE, "", { maxAge: 0, secure: app.config.publicOrigin.startsWith("https:") });
}

export function sessionWrite<T>(app: App, accountId: string, sessionId: string, write: () => T, requireRecent = false): T {
  return app.db.tx(() => {
    const row = validSessionForWrite(app, accountId, sessionId);
    if (requireRecent && !recentlyAuthenticated(row)) {
      throw new HttpError(403, "step_up", "Please confirm it's you again before doing this.");
    }
    return write();
  });
}

function recentlyAuthenticated(s: { auth_at: string }): boolean {
  return Date.now() - Date.parse(s.auth_at) <= STEP_UP_SECONDS * 1000;
}

type WritableSession = { auth_at: string };

/** A phone app's connection, read as a session: a full sign-in whose step-up clock is its auth_at. Null for anything else. */
function deviceSession(app: App, accountId: string, sessionId: string): (WritableSession & { expires_at: string }) | null {
  if (!sessionId.startsWith(DEVICE_SESSION_PREFIX)) return null;
  const d = app.db.get<{ auth_at: string | null; last_used_at: string }>(
    "SELECT auth_at, last_used_at FROM device_tokens WHERE id = ? AND account_id = ? AND kind = 'mobile'", sessionId.slice(DEVICE_SESSION_PREFIX.length), accountId);
  if (!d || d.last_used_at <= idleCutoff()) return null;
  return { auth_at: d.auth_at ?? new Date(0).toISOString(), expires_at: addSeconds(IDLE_DAYS * 86_400) };
}

function validSessionForWrite(app: App, accountId: string, sessionId: string): WritableSession {
  if (sessionId.startsWith(DEVICE_SESSION_PREFIX)) {
    const device = deviceSession(app, accountId, sessionId);
    if (!device || !isAccountUsable(app, accountId)) throw new HttpError(401, "device_signed_out", "This app isn't connected to the PURSS any more. Connect it again.");
    return device;
  }
  const row = app.db.get<WritableSession & { expires_at: string; status: string }>(
    `SELECT s.auth_at, s.expires_at, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND s.account_id = ?`, sessionId, accountId);
  if (!row || row.expires_at <= nowIso() || !isAccountUsable(app, accountId)) throw new HttpError(401, "signed_out", "Please sign in again.");
  return row;
}

/**
 * Set the account's password from a session that is still valid. `expectedHash` is the stored password the change was allowed
 * against (null: none yet); hashing takes a while, so the write re-checks it and refuses if another change came first.
 * `requireRecent`: the session must have signed in recently.
 */
export async function setPassword(app: App, accountId: string, sessionId: string, password: string, opts: { expectedHash: string | null; requireRecent: boolean }): Promise<void> {
  await writePassword(app, accountId, password, (write) => sessionWrite(app, accountId, sessionId, () => {
    const now = app.db.get<{ secret_hash: string }>("SELECT secret_hash FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", accountId)?.secret_hash ?? null;
    if (now !== opts.expectedHash) throw new HttpError(409, "password_changed", "Your password was just changed somewhere else. Please try again.");
    write();
  }, opts.requireRecent));
}

/** Whether the session counts as recently authenticated, as the security page shows it. */
export function recentAuthAvailable(app: App, accountId: string, sessionId: string): boolean {
  const session = deviceSession(app, accountId, sessionId) ?? app.db.get<{ auth_at: string }>(
    "SELECT auth_at FROM sessions WHERE id = ? AND account_id = ?", sessionId, accountId);
  return !!session && recentlyAuthenticated(session);
}

export function resolvePrincipal(app: App, cookieToken: string | undefined): Principal | null {
  if (!cookieToken) return null;
  const id = sha256(cookieToken);
  const row = app.db.get<{ id: string; account_id: string; csrf: string; expires_at: string; auth_at: string; last_seen_at: string; status: string; workspace_id: string; session_class: string }>(
    `SELECT s.id, s.account_id, s.csrf, s.expires_at, s.auth_at, s.last_seen_at, s.session_class, a.status, w.id AS workspace_id
     FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN workspaces w ON w.account_id = a.id WHERE s.id = ?`, id);
  if (!row || row.expires_at <= nowIso() || !isAccountUsable(app, row.account_id)) return null;
  let renewed = false;
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    if (row.session_class === "shared") app.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", nowIso(), id);
    else app.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", nowIso(), addSeconds(SESSION_DAYS * 86400), id);
    renewed = true;
  }
  const isAdmin = !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", row.account_id);
  return { accountId: row.account_id, workspaceId: row.workspace_id, isAdmin, sessionId: row.id, csrf: row.csrf, authAt: row.auth_at, renewed };
}

export function sessionInfo(ctx: Ctx): SessionInfo {
  const { app } = ctx;
  const installation: SessionInfo["installation"] = {
    mode: app.config.mode,
    oidcProviders: app.config.oidc.map((o) => ({ id: o.id, label: o.label })),
    signup: signupOpen(app) ? "open" : "invite",
    mail: mailConfigured(app),
    version: app.config.version?.version ?? null,
    accountEmail: accountEmailAvailable(app),
    billing: app.config.billing !== null,
  };
  if (accountCount(app) === 0) return { state: "unclaimed", csrf: null, account: null, installation };
  const p = ctx.principal;
  if (!p) return { state: "signed_out", csrf: null, account: null, installation };
  const a = app.db.get<{ display_name: string | null; email: string | null }>("SELECT display_name, email FROM accounts WHERE id = ?", p.accountId)!;
  const hasPasskey = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", p.accountId);
  const hasPassword = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", p.accountId);
  return {
    state: "signed_in",
    csrf: p.csrf,
    account: {
      id: p.accountId, displayName: a.display_name, email: a.email, isAdmin: p.isAdmin, hasPasskey, hasPassword,
      linkedProviders: linkedProviders(app, p.accountId).map((o) => ({ id: o.id, label: o.label, canConfirm: canConfirm(app, p.accountId, o) })),
      sharedComputer: app.db.get<{ session_class: string }>("SELECT session_class FROM sessions WHERE id = ?", p.sessionId)?.session_class === "shared",
    },
    installation,
  };
}

/**
 * Claim the installation with the one-time setup code: creates the owner (also administrator). The code proves control of
 * the server, so the address is taken as typed; where email is set up it is also sent a confirmation link.
 */
export function claim(app: App, code: string, email: string, displayName: string | null, password: PreparedPassword): { accountId: string } {
  const out = app.db.tx(() => {
    if (accountCount(app) > 0) throw new HttpError(409, "claimed", "This installation is already set up. Please sign in.");
    const hash = getInstallation(app, "claim_hash");
    if (!hash || !verifySecret(normalizeCode(code), hash)) {
      audit(app, null, "claim", null, "failure");
      throw new HttpError(403, "bad_code", "That setup code isn't right. It's in the data/secrets/setup-code file on the server.");
    }
    const { accountId } = createAccount(app, { email, emailConfirmed: false, displayName, admin: true, allocationBytes: app.config.mode === "hosted" ? app.config.defaultAllocationBytes : null, grantedBy: null, password });
    app.db.run("DELETE FROM installation WHERE key = 'claim_hash'");
    removeSecret(app.config.secretsDir, "setup-code");
    audit(app, accountId, "claim", accountId, "success");
    return { accountId };
  });
  if (accountEmailAvailable(app)) resendVerification(app, out.accountId);
  return out;
}

/** An invitation for one address, typed by the administrator; invites never grant administration. */
export function createInvite(app: App, adminId: string, email: string, note: string | null, allocationBytes: number | null, days = 14): string {
  if (emailInUse(app, email)) throw new HttpError(409, "email_in_use", "An account with this email address already exists.");
  const code = humanCode(5);
  app.db.run("INSERT INTO invites (id, created_by, email, note, allocation_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    sha256(normalizeCode(code)), adminId, email.trim(), note, allocationBytes, nowIso(), addSeconds(days * 86400));
  audit(app, adminId, "invite_create", null, "success");
  return code;
}

/** Record that an invitation's code was emailed to its address, or take back one that couldn't be (services/admin.ts issueInvite). */
export function inviteDelivered(app: App, code: string, sent: boolean): void {
  if (sent) app.db.run("UPDATE invites SET emailed_at = ? WHERE id = ?", nowIso(), sha256(normalizeCode(code)));
  else app.db.run("DELETE FROM invites WHERE id = ? AND used_at IS NULL", sha256(normalizeCode(code)));
}

/**
 * Invitations work on every installation: a self-hosted admin adds family members this way. The administrator typed the
 * address and the person types it again. An invitation whose code went only to that address by email (services/admin.ts
 * issueInvite) proves it, so the address counts as confirmed; one the administrator shared on a server without email
 * leaves it unconfirmed until email is set up and confirms it.
 */
export function acceptInvite(app: App, code: string, email: string, displayName: string | null, password: PreparedPassword): { accountId: string } {
  return app.db.tx(() => {
    const id = sha256(normalizeCode(code));
    const inv = app.db.get<{ id: string; email: string; emailed_at: string | null; allocation_bytes: number | null }>(
      "SELECT id, email, emailed_at, allocation_bytes FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ? AND email IS NOT NULL", id, nowIso());
    if (!inv) throw new HttpError(403, "bad_invite", "That invitation isn't valid or has expired.");
    if (normalizeEmail(inv.email) !== normalizeEmail(email)) throw new HttpError(403, "invite_email", "This invitation is for a different email address. Use the address it was sent to.");
    // Storage allowances are a hosted-service feature; self-hosted accounts have no limit.
    const allocationBytes = app.config.mode === "hosted" ? inv.allocation_bytes ?? app.config.defaultAllocationBytes : null;
    const { accountId } = createAccount(app, { email: inv.email, emailConfirmed: inv.emailed_at !== null, displayName, admin: false, allocationBytes, grantedBy: null, password });
    app.db.run("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?", nowIso(), accountId, id);
    audit(app, accountId, "invite_accept", accountId, "success");
    return { accountId };
  });
}

function signupAddressHash(app: App, address: string): string {
  return sha256(`${app.serviceToken}\0signup-address\0${address}`);
}

export type SignupCapacityStatus = { blocked: false; retryAt: null } | { blocked: true; retryAt: number | null };

/** Whether account capacity blocks signup and, when known, its latest release time. */
export function signupCapacityStatus(app: App, address: string, now = Date.now()): SignupCapacityStatus {
  return app.db.tx(() => {
    let blocked = false;
    let unknownRelease = false;
    const releases: number[] = [];
    const blockUntil = (at: number | null) => {
      blocked = true;
      if (at === null || !Number.isFinite(at)) unknownRelease = true;
      else releases.push(at);
    };

    // Read all blocking counts and release rows from one snapshot, including on a throttled attempt.
    // A non-positive installation cap is an operator pause, with no automatic release time.
    if (app.config.signupDailyLimit <= 0) blockUntil(null);
    // Address hashes have no use after their rolling window; don't retain them indefinitely.
    app.db.run("DELETE FROM signup_creations WHERE created_at <= ?", new Date(now - 60 * 60_000).toISOString());
    const addressHash = signupAddressHash(app, address);
    const sinceHour = new Date(now - 60 * 60_000).toISOString();
    const addressRows = app.db.all<{ created_at: string }>(
      "SELECT created_at FROM signup_creations WHERE address_hash = ? AND created_at > ? ORDER BY created_at", addressHash, sinceHour);
    if (addressRows.length >= 10) blockUntil(Date.parse(addressRows[0]!.created_at) + 60 * 60_000);

    const sinceDay = new Date(now - 24 * 60 * 60_000).toISOString();
    const dailyCount = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'signup' AND outcome = 'success' AND at > ?", sinceDay)!.n;
    const dailyLimit = app.config.signupDailyLimit;
    if (dailyLimit > 0 && dailyCount >= dailyLimit) {
      const expires = app.db.get<{ at: string }>(
        "SELECT at FROM audit_events WHERE action = 'signup' AND outcome = 'success' AND at > ? ORDER BY at LIMIT 1 OFFSET ?", sinceDay, Math.max(0, dailyCount - dailyLimit));
      blockUntil(expires ? Date.parse(expires.at) + 24 * 60 * 60_000 : null);
    }
    if (!blocked) return { blocked: false, retryAt: null };
    return { blocked: true, retryAt: unknownRelease || !releases.length ? null : Math.max(...releases) };
  });
}

export function assertSignupCapacity(app: App, address: string, attemptRetryAt: number | null = null): void {
  const capacity = signupCapacityStatus(app, address);
  if (!capacity.blocked) return;
  const retryAt = capacity.retryAt === null ? null : Math.max(capacity.retryAt, attemptRetryAt ?? 0);
  throw new HttpError(429, "signup_full", "New accounts are full for now.", undefined, retryAt);
}

/**
 * Count an attempt at open sign-up from this address and refuse it when there have been too many or sign-up
 * is closed. Returns when the address may next try once this was its last. The day's capacity is checked
 * by the caller (assertSignupCapacity), after a repeated attempt has had the chance to find its account.
 */
export function openSignupAttempt(app: App, address: string): number | null {
  const attempt = consumeRateLimit(`signup:${address}`, 30, 60 * 60_000);
  if (!attempt.allowed) {
    const openSignup = app.config.mode === "hosted" && app.config.signup === "open";
    const capacity = openSignup ? signupCapacityStatus(app, address) : null;
    const retryAt = capacity?.blocked && capacity.retryAt === null ? null : Math.max(attempt.resetAt, capacity?.retryAt ?? 0);
    throw new HttpError(429, "signup_rate_limited", "Too many account attempts.", undefined, retryAt);
  }
  const attemptRetryAt = attempt.remaining === 0 ? attempt.resetAt : null;
  if (!signupOpen(app)) throw new HttpError(403, "closed", "New accounts are by invitation only here.");
  return attemptRetryAt;
}

/**
 * Open sign-up's shared part: refuses when sign-up is closed or the day's capacity is used, then runs `create`, which makes the
 * account, in one transaction with its signup_creations row and the audit event the day's count reads.
 */
export function openSignup(app: App, address: string, attemptRetryAt: number | null, create: () => string): { accountId: string } {
  if (!signupOpen(app)) throw new HttpError(403, "closed", "New accounts are by invitation only here.");
  return app.db.tx(() => {
    assertSignupCapacity(app, address, attemptRetryAt);
    const addressHash = signupAddressHash(app, address);
    const accountId = create();
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", accountId, addressHash, nowIso());
    audit(app, accountId, "signup", accountId, "success");
    return { accountId };
  });
}

/**
 * Open sign-up through an external provider: the same limits and bookkeeping as finishing sign-up by email (auth/signup.ts),
 * but the account has no password. The provider vouched for `email` (the caller checked email_verified), so it is stored
 * confirmed and no message is sent. An address another account has is refused (409 email_in_use): sign-in never links
 * accounts by email.
 */
export function signupWithProvider(
  app: App, who: { displayName: string | null; email: string; label: string; issuer: string; subject: string }, address: string, attemptRetryAt: number | null = null,
): { accountId: string } {
  return openSignup(app, address, attemptRetryAt, () => {
    if (emailInUse(app, who.email)) {
      throw new HttpError(409, "email_in_use", `An account with this email address already exists. Sign in with your email address and password, then connect ${who.label} in Settings → Security.`);
    }
    const { accountId } = createAccount(app, { email: who.email, emailConfirmed: true, displayName: who.displayName, admin: false, allocationBytes: app.config.defaultAllocationBytes, grantedBy: null, password: null });
    const now = nowIso();
    app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at, last_used_at) VALUES (?, ?, 'oidc', ?, ?, ?, ?, ?)",
      newId("sim"), accountId, who.label, who.issuer, who.subject, now, now);
    audit(app, accountId, "email_verify", accountId, "success", "provider");
    return accountId;
  });
}

/** Extend the browser cookie along with the session, so active people stay signed in. */
export function renewSessionCookie(app: App, res: ServerResponse, token: string): void {
  const session = app.db.get<{ session_class: string }>("SELECT session_class FROM sessions WHERE id = ?", sha256(token));
  if (!session) return;
  setCookie(res, SESSION_COOKIE, token, { ...(session.session_class === "shared" ? {} : { maxAge: SESSION_DAYS * 86400 }), secure: app.config.publicOrigin.startsWith("https:") });
}
