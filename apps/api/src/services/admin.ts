import { BRIDGE_SERVICES, bridgeService } from "@purss/connectors";
import { appUrl } from "@purss/domain";
import type { UsageReport, AdminAccountDTO, Plan } from "@purss/domain";
export type { UsageReport, AdminAccountDTO };
import type { AdminBridgeHealth, AdminHealth, AdminJob, AuditEventDTO, BridgeFailingSource, BridgeServiceHealth } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit, emit } from "../app.ts";
import { HttpError, addSeconds, conflict, notFound, nowIso } from "../http.ts";
import { createInvite, inviteDelivered } from "../auth/accounts.ts";
import { mailConfigured, mailHealth, sendMail, signupOpen } from "../mail/mailer.ts";
import { invitationMail } from "../mail/templates.ts";
import { cancelJob, retryJob } from "./jobs.ts";
import { StorageFull, allocation, checkGrowth, databaseBytes, diskInfo, diskOverride, markPaused, reconcile, refreshPause, usedBytes } from "./storage.ts";
import { pauseAllShares } from "./shares.ts";
import { signOutEverywhere } from "../auth/sign-out.ts";
import { redactError } from "./text-safety.ts";
import { confirmEngineRemoved, isAccountUsable, usableAccountSql } from "./deletion.ts";
import { capacity, storedPlan } from "./plans.ts";
import { serverTokensOf } from "./ai-access.ts";
import { failJudging } from "./ai-filters.ts";
import { topDiscoveryMisses } from "./discovery-misses.ts";

/*
 * Administrator operations (plan/21). Everything here is operational: aggregates, job and
 * account metadata, and fixed audited actions. There is no content access, no impersonation
 * and no raw token or payload view; job errors are redacted before they leave this module.
 */

// ---------- health

/** A request to the egress control listener: with the service token, never followed to another address. */
function controlFetch(app: App, url: string | URL): Promise<Response> {
  return fetch(url, {
    headers: { authorization: `Bearer ${app.serviceToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(1500),
    redirect: "error", // never carry the service token to a different address
  });
}

async function egressStatus(app: App): Promise<AdminHealth["egress"]> {
  try {
    const res = await controlFetch(app, app.config.egressControlUrl);
    if (!res.ok) return { status: "unavailable", blockedLastHour: null };
    const body = (await res.json().catch(() => null)) as { blockedLastHour?: unknown } | null;
    return { status: "ok", blockedLastHour: typeof body?.blockedLastHour === "number" ? body.blockedLastHour : null };
  } catch {
    return { status: "unavailable", blockedLastHour: null };
  }
}

const BRIDGE_DAYS = 7;
const OUTCOME = /^[a-z0-9_]{1,40}$/;

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Whole percent of attempts that worked; 100 only when none failed, so a service with a failure never reads as perfect. */
function successPercent(worked: number, attempts: number, failed: number): number {
  const percent = Math.round((100 * worked) / attempts);
  return failed > 0 ? Math.min(99, percent) : Math.min(100, percent);
}

/** The router's per-service numbers: every service in the catalogue, and any other one the log still holds, with display names. */
function bridgeServices(rows: unknown): BridgeServiceHealth[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = record(raw);
    if (r && typeof r.service === "string" && r.service.length <= 40) seen.set(r.service, r);
  }
  const ids = [...BRIDGE_SERVICES.map((s) => s.id), ...[...seen.keys()].filter((id) => !bridgeService(id)).sort()];
  return ids.map((id) => {
    const r = seen.get(id);
    const attempts = count(r?.attempts);
    const ok = count(r?.ok);
    const empty = count(r?.empty);
    return {
      id, name: bridgeService(id)?.name ?? id, attempts, ok, empty, failed: count(r?.failed), cachedAnswers: count(r?.cachedAnswers),
      successPercent: attempts ? successPercent(ok + empty, attempts, count(r?.failed)) : null,
    };
  });
}

/** The keys failing now, longest-failing first as the router lists them; a row that isn't shaped as expected is left out. */
function bridgeFailing(rows: unknown): BridgeFailingSource[] {
  const out: BridgeFailingSource[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = record(raw);
    const failingSince = isoOrNull(r?.failingSince);
    if (!r || typeof r.service !== "string" || r.service.length > 40 || typeof r.key !== "string" || r.key.length > 100 || typeof r.outcome !== "string" || !failingSince) continue;
    const service = bridgeService(r.service);
    out.push({
      service: r.service, serviceName: service?.name ?? r.service, key: r.key,
      // The service's own page for the key, only for a key its handle syntax allows.
      pageUrl: service && service.keyPattern.test(r.key) ? service.pageUrl(r.key) : null,
      outcome: OUTCOME.test(r.outcome) ? r.outcome : "unknown",
      failingSince, lastOkAt: isoOrNull(r.lastOkAt), attempts: count(r.attempts),
    });
  }
  return out.slice(0, 200);
}

/** The bridge's last week from the egress service's log; null when this server runs no bridge. */
async function bridgeHealth(app: App): Promise<AdminBridgeHealth | null> {
  if (!app.config.bridgeUrl) return null;
  const unavailable: AdminBridgeHealth = { status: "unavailable", days: BRIDGE_DAYS, services: [], failing: [] };
  try {
    const res = await controlFetch(app, new URL(`/bridge/summary?days=${BRIDGE_DAYS}`, app.config.egressControlUrl));
    if (!res.ok) return unavailable;
    const body = record(await res.json().catch(() => null));
    if (!body) return unavailable;
    return { status: "ok", days: BRIDGE_DAYS, services: bridgeServices(body.services), failing: bridgeFailing(body.failing) };
  } catch {
    return unavailable;
  }
}

export async function adminHealth(app: App, now = Date.now()): Promise<AdminHealth> {
  const users = app.db.all<{ status: string; last_success_at: string | null; last_error: string | null }>(
    "SELECT eu.status, c.last_success_at, c.last_error FROM engine_users eu LEFT JOIN sync_checkpoints c ON c.engine_user_id = eu.id");
  const failing = users.filter((u) => u.status === "error" || u.last_error).length;
  const starting = users.filter((u) => u.status === "pending").length;
  const lastSyncAt = users.map((u) => u.last_success_at).filter((t): t is string => !!t).sort().at(-1) ?? null;
  const engine: AdminHealth["engine"] = {
    status: !users.length ? "starting" : failing === users.length ? "unavailable" : failing ? "degraded" : starting ? "starting" : "ok",
    version: null, // the engine's version isn't tracked by the product
    lastSyncAt,
    lagSeconds: lastSyncAt ? Math.max(0, Math.round((now - Date.parse(lastSyncAt)) / 1000)) : null,
    message: failing ? `${failing} of ${users.length} ${users.length === 1 ? "PURSS isn't" : "PURSSes aren't"} syncing. Check the engine and the worker.` : starting ? "The engine is still being set up." : null,
  };

  const jobCounts = new Map(app.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'leased', 'failed') GROUP BY status").map((r) => [r.status, r.n]));
  const oldest = app.db.get<{ t: string | null }>("SELECT MIN(run_after) AS t FROM jobs WHERE status = 'queued' AND run_after <= ?", new Date(now).toISOString())?.t ?? null;

  const disk = diskInfo(app);
  const free = diskOverride.freeBytes ?? disk.freeBytes;
  const db = databaseBytes(app);
  const src = app.db.get<{ total: number; failing: number; paused: number }>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN health IN ('error', 'login', 'reconnect') THEN 1 ELSE 0 END), 0) AS failing,
       COALESCE(SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END), 0) AS paused
     FROM sources WHERE followed = 1 AND kind <> 'manual'`)!;
  const [egress, bridge] = await Promise.all([egressStatus(app), bridgeHealth(app)]);
  return {
    engine,
    jobs: { queued: jobCounts.get("queued") ?? 0, leased: jobCounts.get("leased") ?? 0, failed: jobCounts.get("failed") ?? 0, oldestQueuedSeconds: oldest ? Math.max(0, Math.round((now - Date.parse(oldest)) / 1000)) : null },
    disk: {
      freeBytes: free, totalBytes: disk.totalBytes, reserveBytes: app.config.diskReserveBytes,
      growthPaused: !!app.db.get("SELECT 1 FROM storage_accounts WHERE paused_reason = 'disk' LIMIT 1") || (free !== null && free < app.config.diskReserveBytes),
    },
    database: { bytes: db.bytes, walBytes: db.walBytes },
    sources: src,
    accounts: { total: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n },
    egress,
    bridge,
    discoveryMisses: topDiscoveryMisses(app, { days: 30, limit: 20, now: new Date(now) }),
    signupWaitingForMail: app.config.mode === "hosted" && app.config.signup === "open" && !signupOpen(app),
    mail: mailSummary(app),
  };
}

function mailSummary(app: App): AdminHealth["mail"] {
  const health = mailHealth(app);
  if (!health) return null;
  const counts = new Map(app.db.all<{ outcome: string; n: number }>("SELECT outcome, COUNT(*) AS n FROM mail_log WHERE at > ? GROUP BY outcome", addSeconds(-86400)).map((r) => [r.outcome, r.n]));
  return { ...health, sentLastDay: counts.get("sent") ?? 0, failedLastDay: counts.get("failed") ?? 0 };
}

// ---------- jobs

export function listAdminJobs(app: App, opts: { status?: string; limit?: number } = {}): AdminJob[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const where = opts.status ? "WHERE status = ?" : "";
  const rows = app.db.all<{ id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string; account_id: string | null }>(
    `SELECT id, kind, status, attempts, last_error, created_at, updated_at, account_id FROM jobs ${where}
     ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'leased' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`,
    ...(opts.status ? [opts.status] : []), limit);
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, lastError: redactError(r.last_error), createdAt: r.created_at, updatedAt: r.updated_at, account: r.account_id }));
}

function jobAction(app: App, admin: Principal, id: string, action: "retry" | "cancel"): { ok: true } {
  const job = app.db.get<{ kind: string; account_id: string | null; status: string; payload: string }>("SELECT kind, account_id, status, payload FROM jobs WHERE id = ?", id);
  if (!job) throw notFound("That job");
  const done = app.db.tx(() => {
    const ok = action === "retry" ? retryJob(app, id) : cancelJob(app, id);
    // A cancelled Smart filter job leaves its posts unjudged; they are announced as a sync would have (a failed one already was).
    if (ok && action === "cancel" && job.kind === "filter.judge" && job.status === "queued") failJudging(app, JSON.parse(job.payload) as Record<string, unknown>);
    return ok;
  });
  if (!done) {
    const waiting = action === "retry" && !!job.account_id && job.kind !== "engine.delete_user" && !isAccountUsable(app, job.account_id);
    audit(app, admin.accountId, `admin_job_${action}`, id, "failure", waiting ? "account unusable" : "wrong state");
    throw conflict(waiting ? "This job's account is suspended or being deleted, so its jobs wait until it is usable again."
      : action === "retry" ? "Only failed or cancelled jobs can be retried." : "Only queued or failed jobs can be cancelled.");
  }
  audit(app, admin.accountId, `admin_job_${action}`, id, "success", job.kind);
  if (job.account_id) emit(app, job.account_id, { type: "jobs" });
  return { ok: true };
}
export const retryAdminJob = (app: App, admin: Principal, id: string) => jobAction(app, admin, id, "retry");
export const cancelAdminJob = (app: App, admin: Principal, id: string) => jobAction(app, admin, id, "cancel");

// ---------- audit

export function listAudit(app: App, opts: { limit?: number; before?: string } = {}): { events: AuditEventDTO[]; nextBefore: string | null } {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const rows = app.db.all<{ id: string; at: string; actor_account_id: string | null; action: string; target: string | null; outcome: "success" | "failure"; detail: string | null }>(
    "SELECT id, at, actor_account_id, action, target, outcome, detail FROM audit_events WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?", opts.before ?? "9999", limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({ id: r.id, at: r.at, actor: r.actor_account_id, action: r.action, target: r.target, outcome: r.outcome, detail: redactError(r.detail) })),
    nextBefore: rows.length > limit ? page[page.length - 1]!.at : null,
  };
}

// ---------- usage reconciliation

/**
 * Compare each account's usage ledger with the objects it owns, and its used-bytes total with a recount. Differences in
 * the ledger are reported and nothing is changed; a total that has drifted from the objects is put right.
 */
export function reconcileUsage(app: App, admin: Principal | null): UsageReport {
  const accounts = app.db.all<{ id: string }>("SELECT id FROM accounts ORDER BY created_at, id").map((a) => {
    const r = app.db.tx(() => reconcile(app, a.id, { repair: true }));
    return { accountId: a.id, ledgerBytes: r.ledger, objectBytes: r.objects, differenceBytes: r.difference, trackedDifferenceBytes: r.trackedDifference };
  });
  const mismatched = accounts.filter((a) => a.differenceBytes !== 0).length;
  const corrected = accounts.filter((a) => a.trackedDifferenceBytes !== 0).length;
  audit(app, admin?.accountId ?? null, "usage_reconcile", null, mismatched ? "failure" : "success", `${accounts.length} accounts, ${mismatched} differ${corrected ? `, ${corrected} used-bytes total(s) corrected` : ""}`);
  return { checkedAt: nowIso(), accounts, mismatched };
}

// ---------- accounts (every installation; storage allowances only on hosted ones)

function requireHosted(app: App, what: string): void {
  if (app.config.mode !== "hosted") throw new HttpError(400, "not_available", `${what} are a hosted-service feature; self-hosted accounts have no storage limit.`);
}

/** Minimal account metadata: no content, no sign-in details. */
export function listAccounts(app: App): AdminAccountDTO[] {
  return app.db.all<{ id: string; display_name: string | null; email: string | null; status: "active" | "suspended"; created_at: string; is_admin: number; due_at: string | null; state: "pending" | "purging" | null; engine_review_at: string | null }>(
    `SELECT a.id, a.display_name, a.email, a.status, a.created_at, EXISTS (SELECT 1 FROM role_grants r WHERE r.account_id = a.id AND r.role = 'admin') AS is_admin,
       d.due_at, d.state, d.engine_review_at
     FROM accounts a LEFT JOIN account_deletions d ON d.account_id = a.id ORDER BY a.created_at, a.id`,
  ).map((a) => ({
    id: a.id, displayName: a.display_name, email: a.email, status: a.status, createdAt: a.created_at, isAdmin: a.is_admin === 1, usedBytes: usedBytes(app, a.id), allocationBytes: allocation(app, a.id), plan: app.config.mode === "hosted" ? storedPlan(app, a.id) : null, capacity: capacity(app, a.id), smartFilterTokens: serverTokensOf(app, a.id),
    deletion: a.state && a.due_at ? { dueAt: a.due_at, state: a.state, engineReview: a.engine_review_at !== null } : null,
  }));
}

/**
 * Make an invitation for an address. Where email is set up the code goes only to that address, by email, so using it proves
 * the address (acceptInvite marks it confirmed); if it can't be sent, the invitation is withdrawn and nothing is returned.
 * Without email the code is returned for the administrator to share.
 */
export async function issueInvite(app: App, adminId: string, email: string, note: string | null, allocationBytes: number | null, days: number): Promise<{ code: string | null }> {
  const code = createInvite(app, adminId, email, note, allocationBytes, days);
  if (!mailConfigured(app)) return { code };
  const link = `${app.config.publicOrigin}${appUrl("/invite")}?code=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`;
  const sent = await sendMail(app, "invitation", null, invitationMail(email, { link, days, origin: app.config.publicOrigin }));
  inviteDelivered(app, code, sent);
  if (sent) return { code: null };
  throw new HttpError(502, "invite_not_sent", "The invitation couldn't be emailed, so it wasn't made. Check the address, or the mail server under Health, and try again.");
}

/** Create an invitation from the dashboard. `code` is null where it was emailed (the administrator never sees it). */
export async function adminInvite(app: App, admin: Principal, email: string, note: string | null, allocationBytes: number | null, days: number): Promise<{ code: string | null; expiresInDays: number }> {
  if (allocationBytes !== null) requireHosted(app, "Storage allowances");
  return { ...(await issueInvite(app, admin.accountId, email, note, allocationBytes, days)), expiresInDays: days };
}

export function updateAccount(app: App, admin: Principal, id: string, patch: { allocationBytes?: number | null; plan?: Plan; status?: "active" | "suspended"; isAdmin?: boolean }): AdminAccountDTO {
  if (patch.allocationBytes !== undefined) requireHosted(app, "Storage allowances");
  if (patch.plan !== undefined) requireHosted(app, "Plans");
  const acct = app.db.get<{ id: string; status: string }>("SELECT id, status FROM accounts WHERE id = ?", id);
  if (!acct) throw notFound("That account");
  const refuse = (message: string, detail: string): never => {
    audit(app, admin.accountId, "admin_account_update", id, "failure", detail);
    throw conflict(message);
  };
  if (app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", id)) refuse("This account is being deleted, so it can't be changed.", "being deleted");
  if (patch.status === "suspended" && acct.status !== "suspended") {
    if (id === admin.accountId) refuse("You can't suspend your own account.", "self");
    const isAdmin = !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", id);
    const others = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM role_grants r WHERE r.role = 'admin' AND ${usableAccountSql("r.account_id")} AND r.account_id <> ?`, id)!.n;
    if (isAdmin && others === 0) refuse("This is the last active administrator. Another administrator has to be active first.", "last admin");
  }
  if (patch.isAdmin === false) {
    if (id === admin.accountId) refuse("You can't remove your own administrator role. Ask another administrator.", "self demote");
    const others = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM role_grants r WHERE r.role = 'admin' AND ${usableAccountSql("r.account_id")} AND r.account_id <> ?`, id)!.n;
    if (others === 0) refuse("This is the last active administrator.", "last admin");
  }
  app.db.tx(() => {
    const changes: string[] = [];
    if (patch.status && patch.status !== acct.status) {
      app.db.run("UPDATE accounts SET status = ? WHERE id = ?", patch.status, id);
      changes.push(`status ${acct.status} -> ${patch.status}`);
      if (patch.status === "suspended") {
        signOutEverywhere(app, id, "suspension");
        const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", id);
        if (ws) pauseAllShares(app, ws.id); // suspension ends public sharing; copies already fetched can't be recalled
      }
    }
    if (patch.isAdmin !== undefined) {
      const was = !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", id);
      if (patch.isAdmin && !was) {
        app.db.run("INSERT INTO role_grants (account_id, role, granted_at, granted_by) VALUES (?, 'admin', ?, ?)", id, nowIso(), admin.accountId);
        changes.push("admin granted");
      } else if (!patch.isAdmin && was) {
        app.db.run("DELETE FROM role_grants WHERE account_id = ? AND role = 'admin'", id);
        changes.push("admin removed");
      }
    }
    if (patch.plan !== undefined) {
      // A smaller plan keeps everything the account has; it only stops new follows and collections until it is under the limits.
      const before = storedPlan(app, id);
      app.db.run("UPDATE accounts SET plan = ? WHERE id = ?", patch.plan, id);
      if (before !== patch.plan) changes.push(`plan ${before} -> ${patch.plan}`);
    }
    if (patch.allocationBytes !== undefined) {
      const before = allocation(app, id);
      app.db.run("INSERT INTO storage_accounts (account_id, allocation_bytes) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET allocation_bytes = excluded.allocation_bytes", id, patch.allocationBytes);
      changes.push(`allocation ${before ?? "none"} -> ${patch.allocationBytes ?? "none"}`);
    }
    audit(app, admin.accountId, "admin_account_update", id, "success", changes.join("; ") || "no change");
  });
  // A lower allocation can leave the account over quota: keep its data, pause new growth. A higher one lifts the pause.
  try {
    checkGrowth(app, id, 1);
    refreshPause(app, id);
  } catch (err) {
    if (!(err instanceof StorageFull)) throw err;
    markPaused(app, err); // over the new allocation: keep the data, pause new growth
  }
  const row = listAccounts(app).find((a) => a.id === id)!;
  return row;
}

/** Resolve an engine review: the administrator confirms the engine user's data was removed, and the deletion finishes. */
export function confirmDeletionEngine(app: App, admin: Principal, accountId: string): { ok: true } {
  confirmEngineRemoved(app, admin, accountId);
  return { ok: true };
}

export type AdminInviteDTO = { id: string; email: string | null; note: string | null; createdAt: string; expiresAt: string; usedAt: string | null; status: "pending" | "used" | "expired" };

/** Invitations without their codes (only a hash is stored). */
export function listInvites(app: App): AdminInviteDTO[] {
  const now = nowIso();
  return app.db.all<{ id: string; email: string | null; note: string | null; created_at: string; expires_at: string; used_at: string | null }>(
    "SELECT id, email, note, created_at, expires_at, used_at FROM invites ORDER BY created_at DESC LIMIT 100",
  ).map((i) => ({ id: i.id.slice(0, 16), email: i.email, note: i.note, createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at, status: i.used_at ? "used" : i.expires_at < now ? "expired" : "pending" }));
}

export function revokeInvite(app: App, admin: Principal, shortId: string): { ok: true } {
  const r = app.db.run("UPDATE invites SET expires_at = ? WHERE substr(id, 1, 16) = ? AND used_at IS NULL AND expires_at > ?", nowIso(), shortId, nowIso());
  if (!r.changes) throw notFound("That invitation");
  audit(app, admin.accountId, "invite_revoke", null, "success");
  return { ok: true };
}
