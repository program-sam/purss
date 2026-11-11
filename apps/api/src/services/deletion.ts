import { rmSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { newId } from "@purss/domain";
import type { DeletionRequested } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, badRequest, nowIso, setCookie } from "../http.ts";
import { randomToken, sha256 } from "../secrets.ts";
import { startSession } from "../auth/accounts.ts";
import { signOutEverywhere } from "../auth/sign-out.ts";
import { DEVICE_SESSION_PREFIX, idleCutoff } from "../connect/devices.ts";
import { OAUTH_SESSION_PREFIX } from "../oauth/grants.ts";
import { ASSISTANT_SESSION_PREFIX } from "./assistant.ts";
import { enqueue } from "./jobs.ts";
import { pauseAllShares } from "./shares.ts";
import { stageFile } from "./portability.ts";

/*
 * Account deletion, asked for by the account's owner. The request starts a grace period: the
 * account is signed out everywhere (browser sessions, connected apps, assistant tokens and OAuth
 * grants, pending codes and email links: auth/sign-out.ts), its public pages stop, and its jobs wait.
 * Keeping the account means signing in again and reconnecting those apps and assistants.
 * Signing in during the grace period offers to keep the account. After it, the API removes the
 * product data and files (phase 1) and the worker removes the engine user and asks the API to
 * finish (phase 2), which deletes the account itself. Only the audit log keeps the bare account id.
 */

export const GRACE_DAYS = 7;
export const DELETION_COOKIE = "purss_deletion";
const DELETION_COOKIE_PATH = "/api/auth/deletion";
const CANCEL_SECONDS = 10 * 60;
const CANCEL_PURPOSE = "deletion-cancel";
/** Due accounts whose removal starts per maintenance tick. */
const PURGES_PER_TICK = 2;

/** SQL condition: the account in `column` is active and not being deleted. Same rule as isAccountUsable. */
export function usableAccountSql(column: string): string {
  return `EXISTS (SELECT 1 FROM accounts ua WHERE ua.id = ${column} AND ua.status = 'active' AND NOT EXISTS (SELECT 1 FROM account_deletions ud WHERE ud.account_id = ua.id))`;
}

/** An account can sign in, act and run jobs: it is active and not being deleted. */
export function isAccountUsable(app: App, accountId: string): boolean {
  return !!app.db.get(`SELECT 1 WHERE ${usableAccountSql("?")}`, accountId);
}

/**
 * Re-check a principal that was resolved before the request awaited something (its body, a
 * password hash, a provider): its credential must still exist and the account must still be usable.
 * Run inside the write transaction where a credential is written after an await.
 */
export function assertStillUsable(app: App, p: Principal): void {
  if (!credentialExists(app, p) || !isAccountUsable(app, p.accountId)) throw new HttpError(401, "signed_out", "Please sign in again.");
}

/** The credential behind a principal still exists: a session, a connected app, an assistant token or an OAuth grant. */
function credentialExists(app: App, p: Principal): boolean {
  const now = nowIso();
  const id = (prefix: string) => p.sessionId.slice(prefix.length);
  if (p.sessionId.startsWith(ASSISTANT_SESSION_PREFIX)) {
    return !!app.db.get("SELECT 1 FROM assistant_tokens WHERE id = ? AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)", id(ASSISTANT_SESSION_PREFIX), p.accountId, now);
  }
  if (p.sessionId.startsWith(DEVICE_SESSION_PREFIX)) {
    return !!app.db.get("SELECT 1 FROM device_tokens WHERE id = ? AND account_id = ? AND last_used_at > ?", id(DEVICE_SESSION_PREFIX), p.accountId, idleCutoff());
  }
  if (p.sessionId.startsWith(OAUTH_SESSION_PREFIX)) {
    return !!app.db.get("SELECT 1 FROM oauth_grants WHERE id = ? AND account_id = ? AND expires_at > ?", id(OAUTH_SESSION_PREFIX), p.accountId, now);
  }
  return !!app.db.get("SELECT 1 FROM sessions WHERE id = ? AND account_id = ? AND expires_at > ?", p.sessionId, p.accountId, now);
}

const secure = (app: App) => app.config.publicOrigin.startsWith("https:");

// ---------- request

/** What the owner types to confirm: the display name, or the word "delete" for an account without one. */
export function confirmWord(displayName: string | null): string {
  return displayName?.trim() || "delete";
}

export function requestDeletion(app: App, p: Principal, confirm: string): DeletionRequested {
  return app.db.tx(() => {
    assertStillUsable(app, p);
    const name = app.db.get<{ display_name: string | null }>("SELECT display_name FROM accounts WHERE id = ?", p.accountId)!.display_name;
    if (confirm.trim() !== confirmWord(name)) {
      throw badRequest(name?.trim() ? "Type your display name exactly as shown to confirm." : "Type the word delete to confirm.", "confirm_mismatch");
    }
    // Inside the same transaction as the insert, so two administrators can't both leave.
    const isAdmin = !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", p.accountId);
    if (isAdmin && !app.db.get(`SELECT 1 FROM role_grants r WHERE r.role = 'admin' AND r.account_id <> ? AND ${usableAccountSql("r.account_id")}`, p.accountId)) {
      throw new HttpError(409, "last_admin", "You're the only administrator. Make someone else an administrator first, then delete your account.");
    }
    const now = nowIso();
    const dueAt = addSeconds(GRACE_DAYS * 86_400);
    app.db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES (?, ?, ?, ?, 'pending')", p.accountId, newId("adr"), now, dueAt);
    signOutEverywhere(app, p.accountId, "everything");
    pauseAllShares(app, p.workspaceId);
    // Jobs aren't cancelled: running ones go back to the queue with their attempt refunded, so the
    // worker's next call for them answers lease_lost and they resume intact if the account is kept.
    app.db.run("UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE account_id = ? AND status = 'leased'", now, p.accountId);
    audit(app, p.accountId, "account_deletion_requested", p.accountId, "success", `due ${dueAt}`);
    return { dueAt };
  });
}

// ---------- signing in during the grace period

/**
 * Called by every sign-in once the credentials are verified. During the grace period no session
 * starts: a single-use cookie lets this browser keep the account. Afterwards, signing in is refused.
 */
export function refuseDeletingSignIn(app: App, res: ServerResponse, accountId: string, method: string): void {
  const pending = keepTokenFor(app, accountId, method);
  if (!pending) return;
  setCookie(res, DELETION_COOKIE, pending.token, { maxAge: CANCEL_SECONDS, secure: secure(app), path: DELETION_COOKIE_PATH });
  throw new HttpError(409, "deletion_pending", "This account is set to be deleted. You can still keep it.", { dueAt: pending.dueAt });
}

/**
 * For a sign-in to an account set to be deleted: a single-use token that can keep it (the browser gets it
 * as a cookie, the phone app in the answer). Null when no deletion is pending; refused once it's too late.
 */
export function keepTokenFor(app: App, accountId: string, method: string): { token: string; dueAt: string } | null {
  const row = app.db.get<{ request_id: string; due_at: string; state: string }>("SELECT request_id, due_at, state FROM account_deletions WHERE account_id = ?", accountId);
  if (!row) return null;
  if (row.state !== "pending" || row.due_at <= nowIso()) {
    throw new HttpError(403, "account_deleting", "This account is being deleted. It can't be signed in to or kept any more.");
  }
  const token = randomToken(32);
  const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!;
  app.db.run("INSERT INTO confirm_tokens (token, workspace_id, purpose, data, expires_at) VALUES (?, ?, ?, ?, ?)",
    sha256(token), ws.id, CANCEL_PURPOSE, JSON.stringify({ accountId, requestId: row.request_id, method }), addSeconds(CANCEL_SECONDS));
  return { token, dueAt: row.due_at };
}

type CancelToken = { hash: string; workspaceId: string; accountId: string; requestId: string; method: string };

function cancelToken(app: App, cookie: string | undefined): CancelToken | null {
  if (!cookie) return null;
  const hash = sha256(cookie);
  const t = app.db.get<{ workspace_id: string; data: string }>("SELECT workspace_id, data FROM confirm_tokens WHERE token = ? AND purpose = ? AND expires_at > ?", hash, CANCEL_PURPOSE, nowIso());
  if (!t) return null;
  const data = JSON.parse(t.data) as { accountId: string; requestId: string; method: string };
  return { hash, workspaceId: t.workspace_id, ...data };
}

/** The deletion this browser may cancel, if its cookie is still good. */
export function pendingDeletion(app: App, cookie: string | undefined): { dueAt: string | null } {
  const t = cancelToken(app, cookie);
  if (!t) return { dueAt: null };
  const row = app.db.get<{ due_at: string }>("SELECT due_at FROM account_deletions WHERE account_id = ? AND request_id = ? AND state = 'pending' AND due_at > ?", t.accountId, t.requestId, nowIso());
  return { dueAt: row?.due_at ?? null };
}

/** "Keep my account": end the deletion and sign in, in one transaction. */
export function keepAccount(app: App, req: IncomingMessage, res: ServerResponse, cookie: string | undefined): void {
  app.db.tx(() => {
    const t = endDeletion(app, cookie);
    startSession(app, res, req, t.accountId, t.method);
  });
  setCookie(res, DELETION_COOKIE, "", { maxAge: 0, secure: secure(app), path: DELETION_COOKIE_PATH });
}

/** End the deletion a keep token belongs to, inside the caller's transaction; the caller then signs in. */
export function endDeletion(app: App, rawToken: string | undefined): { accountId: string; method: string } {
  return app.db.tx(() => {
    const t = cancelToken(app, rawToken);
    const expired = () => new HttpError(403, "cancel_expired", "That took too long. Sign in again to keep your account.");
    if (!t) throw expired();
    app.db.run("DELETE FROM confirm_tokens WHERE token = ?", t.hash);
    const row = app.db.get<{ request_id: string; state: string; due_at: string }>("SELECT request_id, state, due_at FROM account_deletions WHERE account_id = ?", t.accountId);
    if (!row || row.request_id !== t.requestId) throw expired();
    if (row.state !== "pending" || row.due_at <= nowIso()) throw new HttpError(403, "account_deleting", "This account is being deleted. It can't be kept any more.");
    app.db.run("DELETE FROM account_deletions WHERE account_id = ?", t.accountId);
    app.db.run("DELETE FROM confirm_tokens WHERE workspace_id = ? AND purpose = ?", t.workspaceId, CANCEL_PURPOSE);
    audit(app, t.accountId, "account_deletion_cancelled", t.accountId, "success");
    return { accountId: t.accountId, method: t.method };
  });
}

/** "Leave it": forget this browser's chance to keep the account. */
export function leaveDeletion(app: App, res: ServerResponse, cookie: string | undefined): void {
  if (cookie) app.db.run("DELETE FROM confirm_tokens WHERE token = ? AND purpose = ?", sha256(cookie), CANCEL_PURPOSE);
  setCookie(res, DELETION_COOKIE, "", { maxAge: 0, secure: secure(app), path: DELETION_COOKIE_PATH });
}

// ---------- removal, phase 1 (API)

/**
 * Data-directory files that belong to the account: private feed addresses (also those waiting in a list of feeds) and staged imports.
 */
function deletionManifest(app: App, accountId: string): string[] {
  const rel = (file: string) => path.relative(app.config.dataDir, file);
  const sources = app.db.all<{ id: string }>("SELECT id FROM sources WHERE account_id = ? AND is_private = 1 ORDER BY id", accountId);
  const stages = app.db.all<{ token: string }>("SELECT token FROM import_stages WHERE account_id = ? ORDER BY token", accountId);
  const lists = app.db.all<{ id: string }>("SELECT id FROM opml_imports WHERE account_id = ? ORDER BY id", accountId);
  return [
    ...sources.map((s) => rel(path.join(app.config.secretsDir, "source-urls", s.id))),
    ...stages.map((s) => rel(stageFile(app, s.token))),
    ...lists.map((l) => rel(path.join(app.config.secretsDir, "opml-imports", l.id))),
  ];
}

/** Start removing a due account. False when another tick or a cancel got there first. */
export function claimDeletion(app: App, accountId: string): boolean {
  return app.db.tx(() => {
    const files = deletionManifest(app, accountId);
    return app.db.run("UPDATE account_deletions SET state = 'purging', files = ? WHERE account_id = ? AND state = 'pending' AND due_at <= ?",
      JSON.stringify(files), accountId, nowIso()).changes === 1;
  });
}

function removeDataFile(app: App, relative: string): void {
  const root = path.resolve(app.config.dataDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) return; // the manifest only ever names files inside the data directory
  rmSync(file, { force: true, recursive: true });
}

/**
 * Children before parents, so every delete passes the foreign keys. Per-account rows that other
 * accounts point at (who granted a role, who used an invitation) lose that reference instead.
 */
function deleteAccountRows(app: App, accountId: string, workspaceId: string): void {
  const byWorkspace = (table: string) => app.db.run(`DELETE FROM ${table} WHERE workspace_id = ?`, workspaceId);
  const byAccount = (table: string) => app.db.run(`DELETE FROM ${table} WHERE account_id = ?`, accountId);
  app.db.run("DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE workspace_id = ?)", workspaceId);
  app.db.run("DELETE FROM annotations_fts WHERE rowid IN (SELECT seq FROM annotations WHERE workspace_id = ?)", workspaceId);
  byWorkspace("ai_filter_verdicts");
  byWorkspace("ai_filters");
  byAccount("ai_usage");
  byWorkspace("annotations");
  byWorkspace("playback_positions");
  app.db.run("DELETE FROM share_notes WHERE share_id IN (SELECT id FROM shares WHERE workspace_id = ?)", workspaceId);
  app.db.run("DELETE FROM share_reports WHERE share_id IN (SELECT id FROM shares WHERE workspace_id = ?)", workspaceId);
  byWorkspace("basket_items");
  byWorkspace("captures");
  byWorkspace("item_images");
  byWorkspace("item_versions");
  byWorkspace("baskets");
  app.db.run("DELETE FROM collection_sources WHERE collection_id IN (SELECT id FROM collections WHERE workspace_id = ?)", workspaceId);
  byWorkspace("collections");
  byWorkspace("item_state");
  byWorkspace("state_log");
  byWorkspace("external_ids");
  byWorkspace("reconciliation_queue");
  byWorkspace("notifications");
  byWorkspace("notification_state");
  byWorkspace("reminders");
  byWorkspace("item_reminders");
  byWorkspace("preferences");
  byWorkspace("discovery_dismissed");
  byWorkspace("shares");
  byWorkspace("undo_tokens");
  byWorkspace("confirm_tokens");
  byAccount("import_stages");
  app.db.run("DELETE FROM opml_import_entries WHERE import_id IN (SELECT id FROM opml_imports WHERE account_id = ?)", accountId);
  byAccount("opml_imports");
  byWorkspace("news_deliveries");
  byWorkspace("items");
  byAccount("source_icons");
  byWorkspace("sources");
  byAccount("stored_objects");
  byAccount("reservations");
  byAccount("storage_accounts");
  byAccount("usage_events");
  byAccount("auth_challenges");
  byAccount("signup_creations");
  byAccount("sign_in_methods");
  byAccount("sessions");
  byAccount("push_devices");
  byAccount("device_tokens");
  byAccount("connect_codes");
  byAccount("assistant_tokens");
  byAccount("oauth_grants"); // their access tokens go with them
  byAccount("oauth_refreshes");
  byAccount("email_tokens");
  byAccount("mail_queue");
  // What was sent stays in the operator's mail log (masked recipient), no longer tied to the account.
  app.db.run("UPDATE mail_log SET account_id = NULL WHERE account_id = ?", accountId);
  app.db.run("UPDATE accounts SET email = NULL, email_verified_at = NULL WHERE id = ?", accountId);
  byAccount("role_grants");
  app.db.run("UPDATE news_posts SET author_account_id = NULL WHERE author_account_id = ?", accountId);
  app.db.run("UPDATE role_grants SET granted_by = NULL WHERE granted_by = ?", accountId);
  app.db.run("DELETE FROM invites WHERE created_by = ?", accountId);
  app.db.run("UPDATE invites SET used_by = NULL WHERE used_by = ?", accountId);
  app.db.run("DELETE FROM jobs WHERE account_id = ? AND kind <> 'engine.delete_user'", accountId);
}

/** Phase 1, idempotent: remove the account's files, then its product data, then hand over to the worker. */
export function purgeAccountData(app: App, accountId: string): void {
  const row = app.db.get<{ files: string | null }>("SELECT files FROM account_deletions WHERE account_id = ? AND state = 'purging' AND phase1_done = 0", accountId);
  if (!row) return;
  for (const file of JSON.parse(row.files ?? "[]") as string[]) removeDataFile(app, file);
  app.db.tx(() => {
    const workspaceId = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    deleteAccountRows(app, accountId, workspaceId);
    app.db.run("UPDATE account_deletions SET phase1_done = 1 WHERE account_id = ?", accountId);
    const eu = app.db.get<{ id: string; username: string }>("SELECT id, username FROM engine_users WHERE account_id = ?", accountId);
    if (eu) enqueue(app, "engine.delete_user", { engineUserId: eu.id, username: eu.username }, { accountId, workspaceId, idempotencyKey: `delete-user:${accountId}`, maxAttempts: 20 });
    else finalizeAccount(app, accountId);
  });
}

/** Maintenance tick: start removing due accounts (a few at a time) and resume phase 1 after a crash. */
export function runDeletions(app: App): void {
  const due = app.db.all<{ account_id: string }>("SELECT account_id FROM account_deletions WHERE state = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?", nowIso(), PURGES_PER_TICK);
  for (const d of due) claimDeletion(app, d.account_id);
  for (const r of app.db.all<{ account_id: string }>("SELECT account_id FROM account_deletions WHERE state = 'purging' AND phase1_done = 0 ORDER BY due_at")) {
    try {
      purgeAccountData(app, r.account_id);
    } catch (err) {
      // Nothing of this account's transaction committed; the next tick tries again. Other accounts go on.
      console.error("[api] removing an account's data failed; it will be retried:", err instanceof Error ? err.message : err);
    }
  }
}

// ---------- removal, phase 2 (worker)

/** The engine side of a deletion, as the worker's engine.delete_user job sees it. */
export type EngineDeletionState = { engineAttemptedAt: string | null; engineRemovedAt: string | null; engineReviewAt: string | null };

/** The account whose engine.delete_user job holds this lease, or a lost lease. */
function deletionLease(app: App, engineUserId: string, jobId: string, leaseId: string): string {
  const row = app.db.get<{ account_id: string }>(
    `SELECT j.account_id FROM jobs j JOIN engine_users e ON e.account_id = j.account_id JOIN account_deletions d ON d.account_id = j.account_id
     WHERE j.id = ? AND j.lease_id = ? AND j.status = 'leased' AND j.kind = 'engine.delete_user' AND e.id = ? AND d.state = 'purging' AND d.phase1_done = 1`,
    jobId, leaseId, engineUserId);
  if (!row) throw new HttpError(409, "lease_lost", "Lease lost.");
  return row.account_id;
}

function engineState(app: App, accountId: string): EngineDeletionState {
  const d = app.db.get<{ engine_attempted_at: string | null; engine_removed_at: string | null; engine_review_at: string | null }>(
    "SELECT engine_attempted_at, engine_removed_at, engine_review_at FROM account_deletions WHERE account_id = ?", accountId)!;
  return { engineAttemptedAt: d.engine_attempted_at, engineRemovedAt: d.engine_removed_at, engineReviewAt: d.engine_review_at };
}

export function deletionEngineState(app: App, engineUserId: string, jobId: string, leaseId: string): EngineDeletionState {
  return engineState(app, deletionLease(app, engineUserId, jobId, leaseId));
}

/** Recorded before the first delete-user call, independent of job attempts and retries. */
export function recordEngineAttempt(app: App, engineUserId: string, jobId: string, leaseId: string): EngineDeletionState {
  const accountId = deletionLease(app, engineUserId, jobId, leaseId);
  app.db.run("UPDATE account_deletions SET engine_attempted_at = COALESCE(engine_attempted_at, ?) WHERE account_id = ?", nowIso(), accountId);
  return engineState(app, accountId);
}

export function recordEngineRemoved(app: App, engineUserId: string, jobId: string, leaseId: string): EngineDeletionState {
  const accountId = deletionLease(app, engineUserId, jobId, leaseId);
  app.db.run("UPDATE account_deletions SET engine_removed_at = COALESCE(engine_removed_at, ?), engine_review_at = NULL WHERE account_id = ?", nowIso(), accountId);
  return engineState(app, accountId);
}

export const ENGINE_REVIEW_MESSAGE = "Confirm the engine user's data was removed: it was gone after a removal attempt that wasn't confirmed.";

/**
 * The engine user was missing after an unconfirmed attempt: an administrator confirms its data is
 * gone before the deletion finishes. The job ends here (failed, with that message) until then.
 */
export function openEngineReview(app: App, engineUserId: string, jobId: string, leaseId: string): EngineDeletionState {
  const accountId = deletionLease(app, engineUserId, jobId, leaseId);
  app.db.tx(() => {
    app.db.run("UPDATE account_deletions SET engine_review_at = COALESCE(engine_review_at, ?) WHERE account_id = ?", nowIso(), accountId);
    app.db.run("UPDATE jobs SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?", ENGINE_REVIEW_MESSAGE, nowIso(), jobId);
    audit(app, null, "account_deletion_engine_review", accountId, "failure");
  });
  return engineState(app, accountId);
}

/** An administrator confirms the engine user's data is gone; the deletion job resumes and finishes. */
export function confirmEngineRemoved(app: App, admin: Principal, accountId: string): void {
  app.db.tx(() => {
    const row = app.db.get<{ workspace_id: string; engine_user_id: string; username: string }>(
      `SELECT w.id AS workspace_id, e.id AS engine_user_id, e.username FROM account_deletions d JOIN workspaces w ON w.account_id = d.account_id JOIN engine_users e ON e.account_id = d.account_id
       WHERE d.account_id = ? AND d.engine_review_at IS NOT NULL AND d.engine_removed_at IS NULL`, accountId);
    if (!row) throw new HttpError(409, "conflict", "This account isn't waiting for that confirmation.");
    app.db.run("UPDATE account_deletions SET engine_removed_at = ?, engine_review_at = NULL WHERE account_id = ?", nowIso(), accountId);
    enqueue(app, "engine.delete_user", { engineUserId: row.engine_user_id, username: row.username }, { accountId, workspaceId: row.workspace_id, idempotencyKey: `delete-user:${accountId}`, maxAttempts: 20 });
    audit(app, admin.accountId, "admin_deletion_engine_confirmed", accountId, "success");
  });
}

/** The last step: remove what is left of the account, including the account row and the job itself. */
function finalizeAccount(app: App, accountId: string): void {
  for (const eu of app.db.all<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)) {
    for (const table of ["sync_checkpoints", "applied_batches", "item_tombstones"]) app.db.run(`DELETE FROM ${table} WHERE engine_user_id = ?`, eu.id);
  }
  app.db.run("DELETE FROM jobs WHERE account_id = ?", accountId);
  app.db.run("DELETE FROM engine_users WHERE account_id = ?", accountId);
  app.db.run("DELETE FROM workspaces WHERE account_id = ?", accountId);
  app.db.run("DELETE FROM account_deletions WHERE account_id = ?", accountId);
  app.db.run("DELETE FROM accounts WHERE id = ?", accountId);
  audit(app, null, "account_deleted", accountId, "success");
}

/**
 * Finish a deletion once the engine user is gone. When the account no longer exists (the answer to
 * an earlier call was lost), this is a no-op that reports success.
 */
export function finalizeDeletion(app: App, engineUserId: string, jobId: string, leaseId: string): { finalized: boolean } {
  return app.db.tx(() => {
    if (!app.db.get("SELECT 1 FROM engine_users WHERE id = ?", engineUserId)) return { finalized: false };
    const accountId = deletionLease(app, engineUserId, jobId, leaseId);
    if (!engineState(app, accountId).engineRemovedAt) throw new HttpError(409, "engine_not_removed", "The engine user hasn't been confirmed removed yet.");
    finalizeAccount(app, accountId);
    return { finalized: true };
  });
}
