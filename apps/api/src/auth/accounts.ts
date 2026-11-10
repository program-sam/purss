import type { IncomingMessage, ServerResponse } from "node:http";
import { newId } from "@purss/domain";
import type { SessionInfo } from "@purss/domain";
import { STEP_UP_SECONDS } from "../app.ts";
import type { App, Ctx, Principal } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, consumeRateLimit, nowIso, setCookie } from "../http.ts";
import { hashSecret, humanCode, normalizeCode, randomToken, sha256, verifySecret, writeSecret, readSecret, removeSecret } from "../secrets.ts";
import { enqueue } from "../services/jobs.ts";
import { mailConfigured, signupOpen } from "../mail/mailer.ts";
import { accountEmailAvailable } from "../services/account-email.ts";
import { isAccountUsable, refuseDeletingSignIn } from "../services/deletion.ts";
import { initialPlan } from "../services/plans.ts";
import { runAccountCreated } from "../services/account-hooks.ts";
import { DEVICE_SESSION_PREFIX, IDLE_DAYS, deviceAuthAt, idleCutoff } from "../connect/devices.ts";

export const SESSION_COOKIE = "purss_session";
const SESSION_DAYS = 30;
const SHARED_SESSION_SECONDS = 8 * 60 * 60;
const SETUP_PERMISSION_SECONDS = 30 * 60;
const RECOVERY_CODES = 10;

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

export function createAccount(app: App, opts: { displayName: string | null; admin: boolean; allocationBytes: number | null; grantedBy: string | null }): { accountId: string; workspaceId: string } {
  const accountId = newId("acc");
  const workspaceId = newId("wsp");
  const now = nowIso();
  app.db.run("INSERT INTO accounts (id, display_name, plan, created_at) VALUES (?, ?, ?, ?)", accountId, opts.displayName, initialPlan(app), now);
  app.db.run("INSERT INTO account_enrollment (account_id) VALUES (?)", accountId);
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

/** Generate fresh single-use recovery codes, replacing any unused ones. Returned once. */
export function issueRecoveryCodes(app: App, accountId: string): string[] {
  app.db.run("DELETE FROM sign_in_methods WHERE account_id = ? AND kind = 'recovery'", accountId);
  const tag = humanCode(1);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODES; i++) {
    const code = `${tag}-${humanCode(3)}`;
    codes.push(code);
    app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES (?, ?, 'recovery', ?, ?, ?)",
      newId("sim"), accountId, tag, hashSecret(normalizeCode(code)), nowIso());
  }
  app.db.run("UPDATE account_enrollment SET recovery_generation = recovery_generation + 1, recovery_acknowledged_generation = NULL WHERE account_id = ?", accountId);
  return codes;
}

export function recoveryGeneration(app: App, accountId: string): number {
  return app.db.get<{ recovery_generation: number }>("SELECT recovery_generation FROM account_enrollment WHERE account_id = ?", accountId)?.recovery_generation ?? 0;
}

export function acknowledgeRecoveryCodes(app: App, accountId: string, generation: number): void {
  app.db.tx(() => {
    const row = app.db.get<{ recovery_generation: number }>("SELECT recovery_generation FROM account_enrollment WHERE account_id = ?", accountId);
    if (!row || row.recovery_generation !== generation) throw new HttpError(409, "recovery_codes_superseded", "Those recovery codes have been replaced. Save the current set instead.");
    app.db.run("UPDATE account_enrollment SET recovery_acknowledged_generation = ? WHERE account_id = ? AND recovery_generation = ?", generation, accountId, generation);
  });
}

export function recoveryCodesLeft(app: App, accountId: string): number {
  return app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE account_id = ? AND kind = 'recovery' AND used_at IS NULL", accountId)!.n;
}

/** Recovery codes are tagged by their first group, so only that account's hashes are checked. */
export function useRecoveryCode(app: App, raw: string, onlyAccountId?: string): string | null {
  return app.db.tx(() => {
    const code = normalizeCode(raw);
    const tag = code.slice(0, 4);
    // Step-up passes the signed-in account, so a code belonging to someone else is never used up.
    const rows = app.db.all<{ id: string; account_id: string; secret_hash: string }>(
      "SELECT id, account_id, secret_hash FROM sign_in_methods WHERE kind = 'recovery' AND label = ? AND used_at IS NULL" + (onlyAccountId ? " AND account_id = ?" : ""),
      ...(onlyAccountId ? [tag, onlyAccountId] : [tag]));
    for (const r of rows) {
      if (verifySecret(code, r.secret_hash)) {
        const usedAt = nowIso();
        const updated = app.db.run("UPDATE sign_in_methods SET used_at = ?, last_used_at = ? WHERE id = ? AND used_at IS NULL", usedAt, usedAt, r.id);
        if (updated.changes) return r.account_id;
      }
    }
    return null;
  });
}

// ---------- sessions ----------

export function startSession(app: App, res: ServerResponse, req: IncomingMessage, accountId: string, method: string, opts: { sharedComputer?: boolean; setupPermission?: boolean; setupExpiresAt?: string } = {}): string {
  const token = randomToken(32);
  const now = nowIso();
  const sharedComputer = opts.sharedComputer === true;
  const expiresAt = addSeconds(sharedComputer ? SHARED_SESSION_SECONDS : SESSION_DAYS * 86400);
  const setupExpiresAt = opts.setupPermission === true ? opts.setupExpiresAt ?? addSeconds(SETUP_PERMISSION_SECONDS) : null;
  const status = app.db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", accountId)?.status;
  if (status !== "active") throw new HttpError(403, "suspended", "This account is suspended. Contact the administrator.");
  refuseDeletingSignIn(app, res, accountId, method);
  app.db.run("INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, user_agent, session_class, setup_permission_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    sha256(token), accountId, randomToken(18), now, expiresAt, now, now, method, String(req.headers["user-agent"] ?? "").slice(0, 200), sharedComputer ? "shared" : "persistent", setupExpiresAt);
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

/**
 * When the session last really authenticated. Creating an account through open sign-up proves only
 * possession of the session, so a sign-up session counts as authenticated once a later step-up
 * refreshed `auth_at`; until then it may add its first sign-in method only through the setup permission.
 * Claiming the installation and accepting an invitation present a secret, so they count.
 */
export function lastRealAuth(s: { method: string; auth_at: string; created_at: string }): string | null {
  return s.method === "signup" && s.auth_at <= s.created_at ? null : s.auth_at;
}

function recentlyAuthenticated(s: { method: string; auth_at: string; created_at: string }): boolean {
  const at = lastRealAuth(s);
  return !!at && Date.now() - Date.parse(at) <= STEP_UP_SECONDS * 1000;
}

type WritableSession = { auth_at: string; created_at: string; method: string; setup_permission_expires_at: string | null; setup_permission_used_at: string | null };

/**
 * A phone app's connection, read as a session: a full sign-in whose step-up clock is its auth_at. It never
 * has a setup permission (an account made in the app gets its password with it). Null for anything else.
 */
function deviceSession(app: App, accountId: string, sessionId: string): (WritableSession & { expires_at: string }) | null {
  if (!sessionId.startsWith(DEVICE_SESSION_PREFIX)) return null;
  const d = app.db.get<{ auth_at: string | null; auth_method: string; created_at: string; last_used_at: string }>(
    "SELECT auth_at, auth_method, created_at, last_used_at FROM device_tokens WHERE id = ? AND account_id = ? AND kind = 'mobile'", sessionId.slice(DEVICE_SESSION_PREFIX.length), accountId);
  if (!d || d.last_used_at <= idleCutoff()) return null;
  return {
    auth_at: deviceAuthAt(d) ?? new Date(0).toISOString(), created_at: d.created_at, method: "device",
    setup_permission_expires_at: null, setup_permission_used_at: null, expires_at: addSeconds(IDLE_DAYS * 86_400),
  };
}

function validSessionForWrite(app: App, accountId: string, sessionId: string): WritableSession {
  if (sessionId.startsWith(DEVICE_SESSION_PREFIX)) {
    const device = deviceSession(app, accountId, sessionId);
    if (!device || !isAccountUsable(app, accountId)) throw new HttpError(401, "device_signed_out", "This app isn't connected to the PURSS any more. Connect it again.");
    return device;
  }
  const row = app.db.get<WritableSession & { expires_at: string; status: string }>(
    `SELECT s.auth_at, s.created_at, s.method, s.setup_permission_expires_at, s.setup_permission_used_at, s.expires_at, a.status
     FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND s.account_id = ?`, sessionId, accountId);
  if (!row || row.expires_at <= nowIso() || !isAccountUsable(app, accountId)) throw new HttpError(401, "signed_out", "Please sign in again.");
  return row;
}

/** The credential write and setup-permission consumption commit or roll back together. */
export function credentialWrite<T>(app: App, accountId: string, sessionId: string, write: () => T): T {
  return app.db.tx(() => {
    const session = validSessionForWrite(app, accountId, sessionId);
    const enrollment = app.db.get<{ durable_method_exists: number }>("SELECT durable_method_exists FROM account_enrollment WHERE account_id = ?", accountId);
    const hasDurableMethod = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind IN ('passkey', 'password', 'oidc') LIMIT 1", accountId);
    const setupAllowed = session.method === "signup" && !session.setup_permission_used_at
      && !!session.setup_permission_expires_at && session.setup_permission_expires_at > nowIso()
      && enrollment?.durable_method_exists === 0 && !hasDurableMethod;
    if (!setupAllowed && !recentlyAuthenticated(session)) {
      throw new HttpError(403, "step_up", "Please confirm it's you again before doing this.");
    }

    const result = write();
    app.db.run("UPDATE account_enrollment SET durable_method_exists = 1 WHERE account_id = ?", accountId);
    if (setupAllowed) {
      app.db.run("UPDATE sessions SET setup_permission_used_at = ?, setup_permission_expires_at = NULL WHERE id = ?", nowIso(), sessionId);
      app.db.run("UPDATE sessions SET setup_permission_expires_at = NULL WHERE account_id = ? AND setup_permission_expires_at IS NOT NULL", accountId);
    }
    return result;
  });
}

/** Whether the session counts as recently authenticated, as the security page shows it. */
export function recentAuthAvailable(app: App, accountId: string, sessionId: string): boolean {
  const session = deviceSession(app, accountId, sessionId) ?? app.db.get<{ method: string; auth_at: string; created_at: string }>(
    "SELECT method, auth_at, created_at FROM sessions WHERE id = ? AND account_id = ?", sessionId, accountId);
  return !!session && recentlyAuthenticated(session);
}

export function setupPermissionAvailable(app: App, accountId: string, sessionId: string): boolean {
  const row = app.db.get<{ method: string; setup_permission_expires_at: string | null; setup_permission_used_at: string | null }>(
    "SELECT method, setup_permission_expires_at, setup_permission_used_at FROM sessions WHERE id = ? AND account_id = ? AND expires_at > ?", sessionId, accountId, nowIso());
  const enrollment = app.db.get<{ durable_method_exists: number }>("SELECT durable_method_exists FROM account_enrollment WHERE account_id = ?", accountId);
  return row?.method === "signup" && !row.setup_permission_used_at && !!row.setup_permission_expires_at
    && row.setup_permission_expires_at > nowIso() && enrollment?.durable_method_exists === 0;
}

export function resolvePrincipal(app: App, cookieToken: string | undefined): Principal | null {
  if (!cookieToken) return null;
  const id = sha256(cookieToken);
  const row = app.db.get<{ id: string; account_id: string; csrf: string; expires_at: string; auth_at: string; created_at: string; method: string; last_seen_at: string; status: string; workspace_id: string; session_class: string }>(
    `SELECT s.id, s.account_id, s.csrf, s.expires_at, s.auth_at, s.created_at, s.method, s.last_seen_at, s.session_class, a.status, w.id AS workspace_id
     FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN workspaces w ON w.account_id = a.id WHERE s.id = ?`, id);
  if (!row || row.expires_at <= nowIso() || !isAccountUsable(app, row.account_id)) return null;
  let renewed = false;
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    if (row.session_class === "shared") app.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", nowIso(), id);
    else app.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", nowIso(), addSeconds(SESSION_DAYS * 86400), id);
    renewed = true;
  }
  const isAdmin = !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", row.account_id);
  // A sign-up session that never stepped up has no real authentication yet (see lastRealAuth).
  return { accountId: row.account_id, workspaceId: row.workspace_id, isAdmin, sessionId: row.id, csrf: row.csrf, authAt: lastRealAuth(row) ?? new Date(0).toISOString(), renewed };
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
  };
  if (accountCount(app) === 0) return { state: "unclaimed", csrf: null, account: null, installation };
  const p = ctx.principal;
  if (!p) return { state: "signed_out", csrf: null, account: null, installation };
  const a = app.db.get<{ display_name: string | null }>("SELECT display_name FROM accounts WHERE id = ?", p.accountId)!;
  const hasPasskey = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", p.accountId);
  const hasPassword = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", p.accountId);
  const hasDurableMethod = !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind IN ('passkey', 'password', 'oidc') LIMIT 1", p.accountId);
  const enrollment = app.db.get<{ recovery_generation: number; recovery_acknowledged_generation: number | null; durable_method_exists: number }>(
    "SELECT recovery_generation, recovery_acknowledged_generation, durable_method_exists FROM account_enrollment WHERE account_id = ?", p.accountId);
  return {
    state: "signed_in",
    csrf: p.csrf,
    account: {
      id: p.accountId, displayName: a.display_name, isAdmin: p.isAdmin, hasPasskey, hasPassword,
      recoveryCodesLeft: recoveryCodesLeft(app, p.accountId),
      // The setup permission's durable-method marker is deliberately monotonic. The banner,
      // however, describes the current account state and returns if its last method is removed.
      needsSetup: !hasDurableMethod,
      recoveryGeneration: enrollment?.recovery_generation ?? 0,
      recoveryAcknowledged: enrollment?.recovery_generation !== undefined && enrollment.recovery_acknowledged_generation === enrollment.recovery_generation,
      setupPermissionAvailable: setupPermissionAvailable(app, p.accountId, p.sessionId),
      sharedComputer: app.db.get<{ session_class: string }>("SELECT session_class FROM sessions WHERE id = ?", p.sessionId)?.session_class === "shared",
    },
    installation,
  };
}

/** Claim the installation with the one-time setup code: creates the owner (also administrator). */
export function claim(app: App, code: string, displayName: string | null): { accountId: string; recoveryCodes: string[] } {
  return app.db.tx(() => {
    if (accountCount(app) > 0) throw new HttpError(409, "claimed", "This installation is already set up. Please sign in.");
    const hash = getInstallation(app, "claim_hash");
    if (!hash || !verifySecret(normalizeCode(code), hash)) {
      audit(app, null, "claim", null, "failure");
      throw new HttpError(403, "bad_code", "That setup code isn't right. It's in the data/secrets/setup-code file on the server.");
    }
    const { accountId } = createAccount(app, { displayName, admin: true, allocationBytes: app.config.mode === "hosted" ? app.config.defaultAllocationBytes : null, grantedBy: null });
    app.db.run("DELETE FROM installation WHERE key = 'claim_hash'");
    removeSecret(app.config.secretsDir, "setup-code");
    const recoveryCodes = issueRecoveryCodes(app, accountId);
    audit(app, accountId, "claim", accountId, "success");
    return { accountId, recoveryCodes };
  });
}

/** Hosted mode: admins invite people; invites never grant administration. */
export function createInvite(app: App, adminId: string, note: string | null, allocationBytes: number | null, days = 14): string {
  const code = humanCode(5);
  app.db.run("INSERT INTO invites (id, created_by, note, allocation_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    sha256(normalizeCode(code)), adminId, note, allocationBytes, nowIso(), addSeconds(days * 86400));
  audit(app, adminId, "invite_create", null, "success");
  return code;
}

/** Invitations work on every installation: a self-hosted admin adds family members this way. */
export function acceptInvite(app: App, code: string, displayName: string | null): { accountId: string; recoveryCodes: string[] } {
  return app.db.tx(() => {
    const id = sha256(normalizeCode(code));
    const inv = app.db.get<{ id: string; allocation_bytes: number | null }>("SELECT id, allocation_bytes FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?", id, nowIso());
    if (!inv) throw new HttpError(403, "bad_invite", "That invitation isn't valid or has expired.");
    // Storage allowances are a hosted-service feature; self-hosted accounts have no limit.
    const allocationBytes = app.config.mode === "hosted" ? inv.allocation_bytes ?? app.config.defaultAllocationBytes : null;
    const { accountId } = createAccount(app, { displayName, admin: false, allocationBytes, grantedBy: null });
    app.db.run("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?", nowIso(), accountId, id);
    audit(app, accountId, "invite_accept", accountId, "success");
    return { accountId, recoveryCodes: issueRecoveryCodes(app, accountId) };
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
 * Hosted mode with open signup: anyone can create an ordinary account (never an admin), with the
 * installation's default allocation, if it sets one. Rate-limited per address by the route and capped per day here.
 */
export function selfSignup(app: App, displayName: string | null, address: string, attemptRetryAt: number | null = null): { accountId: string; recoveryCodes: string[]; recoveryGeneration: number } {
  if (!signupOpen(app)) throw new HttpError(403, "closed", "New accounts are by invitation only here.");
  return app.db.tx(() => {
    assertSignupCapacity(app, address, attemptRetryAt);
    const addressHash = signupAddressHash(app, address);
    const { accountId } = createAccount(app, { displayName, admin: false, allocationBytes: app.config.defaultAllocationBytes, grantedBy: null });
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", accountId, addressHash, nowIso());
    audit(app, accountId, "signup", accountId, "success");
    const recoveryCodes = issueRecoveryCodes(app, accountId);
    return { accountId, recoveryCodes, recoveryGeneration: recoveryGeneration(app, accountId) };
  });
}

/** Remember which account and session a browser's sign-up attempt made (only a hash of its random attempt id is kept). */
export function recordSignupAttempt(app: App, attemptId: string, accountId: string, sessionId: string): void {
  app.db.run("DELETE FROM signup_attempts WHERE created_at < ?", addSeconds(-86400));
  app.db.run("INSERT OR REPLACE INTO signup_attempts (attempt_hash, account_id, session_id, created_at) VALUES (?, ?, ?, ?)", sha256(attemptId), accountId, sessionId, nowIso());
}

/**
 * The account an earlier press of the sign-up button made for the same attempt and address, so a second press (or a new try after
 * the page was closed) finds it instead of making another account and sending another confirmation. It is found only while the
 * session that sign-up started still exists and still holds its setup permission (not signed out, not past its 30 minutes, no
 * way to sign in installed), the recovery codes it showed were never confirmed as saved or used, and no way to sign in was ever added.
 * The first answer's codes may never have been seen, so a fresh set is made; the earlier session is replaced by the new one,
 * which keeps the original setup deadline. Null otherwise.
 */
export function resumeSignup(app: App, attemptId: string, email: string): { accountId: string; recoveryCodes: string[]; recoveryGeneration: number; setupExpiresAt: string; replacedSessionId: string } | null {
  return app.db.tx(() => {
    const row = app.db.get<{ account_id: string; session_id: string; setup_expires_at: string }>(
      `SELECT t.account_id, t.session_id, s.setup_permission_expires_at AS setup_expires_at
       FROM signup_attempts t
       JOIN accounts a ON a.id = t.account_id
       JOIN sessions s ON s.id = t.session_id AND s.account_id = t.account_id
       JOIN account_enrollment e ON e.account_id = t.account_id
       WHERE t.attempt_hash = ? AND a.status = 'active' AND lower(a.email) = lower(?)
         AND s.setup_permission_expires_at > ? AND s.setup_permission_used_at IS NULL
         AND e.durable_method_exists = 0
         AND (e.recovery_acknowledged_generation IS NULL OR e.recovery_acknowledged_generation <> e.recovery_generation)
         AND NOT EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.account_id = t.account_id AND m.kind IN ('passkey', 'password', 'oidc'))
         AND NOT EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.account_id = t.account_id AND m.kind = 'recovery' AND m.used_at IS NOT NULL)`,
      sha256(attemptId), email, nowIso());
    if (!row) return null;
    app.db.run("DELETE FROM sessions WHERE id = ?", row.session_id);
    const recoveryCodes = issueRecoveryCodes(app, row.account_id);
    audit(app, row.account_id, "signup_resume", null, "success", "earlier sign-up session replaced; recovery codes reissued");
    return { accountId: row.account_id, recoveryCodes, recoveryGeneration: recoveryGeneration(app, row.account_id), setupExpiresAt: row.setup_expires_at, replacedSessionId: row.session_id };
  });
}

/** Extend the browser cookie along with the session, so active people stay signed in. */
export function renewSessionCookie(app: App, res: ServerResponse, token: string): void {
  const session = app.db.get<{ session_class: string }>("SELECT session_class FROM sessions WHERE id = ?", sha256(token));
  if (!session) return;
  setCookie(res, SESSION_COOKIE, token, { ...(session.session_class === "shared" ? {} : { maxAge: SESSION_DAYS * 86400 }), secure: app.config.publicOrigin.startsWith("https:") });
}
