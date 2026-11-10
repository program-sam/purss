import { newId, jobPayloadSchemas } from "@purss/domain";
import type { JobKind, LeasedJob } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { isAccountUsable, usableAccountSql } from "./deletion.ts";

export const LEASE_SECONDS = 120;

/**
 * SQL condition on `jobs`: the job may run. Jobs of an account that is suspended or being deleted
 * wait (the worker's calls for them answer lease_lost) and resume intact once it is usable again;
 * the one exception is the job that removes a deleted account's engine user.
 */
export const RUNNABLE_JOB_SQL = `(jobs.account_id IS NULL OR jobs.kind = 'engine.delete_user' OR ${usableAccountSql("jobs.account_id")})`;

export type EnqueueOpts = { accountId?: string | null; workspaceId?: string | null; idempotencyKey?: string; runAfter?: string; maxAttempts?: number };

/** Enqueue a durable job. Call inside the transaction that requires it (outbox). */
export function enqueue<K extends JobKind>(app: App, kind: K, payload: unknown, opts: EnqueueOpts = {}): string {
  const parsed = jobPayloadSchemas[kind].parse(payload);
  if (opts.accountId && kind !== "engine.delete_user" && !isAccountUsable(app, opts.accountId)) {
    throw new HttpError(409, "account_unavailable", "This account is suspended or being deleted, so nothing new can start for it.");
  }
  const now = nowIso();
  if (opts.idempotencyKey) {
    const existing = app.db.get<{ id: string; status: string }>("SELECT id, status FROM jobs WHERE idempotency_key = ?", opts.idempotencyKey);
    if (existing) {
      if (existing.status === "done" || existing.status === "failed" || existing.status === "cancelled") {
        // A finished job with this key may run again (e.g. a periodic sync); re-arm it.
        app.db.run("UPDATE jobs SET status = 'queued', attempts = 0, payload = ?, run_after = ?, last_error = NULL, updated_at = ? WHERE id = ?",
          JSON.stringify(parsed), opts.runAfter ?? now, now, existing.id);
      }
      return existing.id;
    }
  }
  const id = newId("job");
  app.db.run(
    `INSERT INTO jobs (id, account_id, workspace_id, kind, payload, run_after, max_attempts, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, opts.accountId ?? null, opts.workspaceId ?? null, kind, JSON.stringify(parsed), opts.runAfter ?? now, opts.maxAttempts ?? 6, opts.idempotencyKey ?? null, now, now,
  );
  return id;
}

export function leaseJobs(app: App, kinds: string[], max: number): LeasedJob[] {
  const now = nowIso();
  return app.db.tx(() => {
    const placeholders = kinds.map(() => "?").join(",");
    const rows = app.db.all<{ id: string; kind: JobKind; payload: string; attempts: number }>(
      `SELECT id, kind, payload, attempts FROM jobs
       WHERE status = 'queued' AND run_after <= ? AND kind IN (${placeholders}) AND ${RUNNABLE_JOB_SQL}
       ORDER BY run_after, created_at LIMIT ?`,
      now, ...kinds, max,
    );
    return rows.map((r) => {
      const leaseId = newId("lse");
      const leaseExpiresAt = addSeconds(LEASE_SECONDS);
      app.db.run("UPDATE jobs SET status = 'leased', lease_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
        leaseId, leaseExpiresAt, now, r.id);
      return { id: r.id, kind: r.kind, payload: JSON.parse(r.payload), leaseId, leaseExpiresAt, attempts: r.attempts + 1 };
    });
  });
}

/** Returns the job row when the lease is still current and the job may run, otherwise null (lost lease). */
export function currentLease(app: App, jobId: string, leaseId: string): { id: string; kind: string; account_id: string | null; workspace_id: string | null; payload: string } | null {
  return app.db.get(`SELECT id, kind, account_id, workspace_id, payload FROM jobs WHERE id = ? AND lease_id = ? AND status = 'leased' AND ${RUNNABLE_JOB_SQL}`, jobId, leaseId) ?? null;
}

export function heartbeat(app: App, jobId: string, leaseId: string): boolean {
  const r = app.db.run(`UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased' AND ${RUNNABLE_JOB_SQL}`,
    addSeconds(LEASE_SECONDS), nowIso(), jobId, leaseId);
  return r.changes === 1;
}

/** A leased job that may not run any more goes back to the queue without using up an attempt. */
export function returnWaitingJob(app: App, jobId: string, leaseId: string): boolean {
  return app.db.run(`UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased' AND NOT ${RUNNABLE_JOB_SQL}`,
    nowIso(), jobId, leaseId).changes === 1;
}

export function completeJob(app: App, jobId: string, leaseId: string, result: unknown): boolean {
  const r = app.db.run("UPDATE jobs SET status = 'done', result = ?, lease_id = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased'",
    JSON.stringify(result ?? null), nowIso(), jobId, leaseId);
  return r.changes === 1;
}

/**
 * Record a failed run. A retryable failure is queued again after a growing delay until the attempts run out. With
 * `retryDelays`, each retry waits for its own delay (in seconds) and the retries stop when the list does.
 */
export function failJob(app: App, jobId: string, leaseId: string, error: string, retryable: boolean, opts: { retryDelays?: readonly number[] } = {}): { finalFailure: boolean } | null {
  const job = app.db.get<{ attempts: number; max_attempts: number }>("SELECT attempts, max_attempts FROM jobs WHERE id = ? AND lease_id = ? AND status = 'leased'", jobId, leaseId);
  if (!job) return null;
  const final = !retryable || job.attempts >= job.max_attempts || (!!opts.retryDelays && job.attempts > opts.retryDelays.length);
  const backoff = opts.retryDelays ? opts.retryDelays[job.attempts - 1] ?? 3600 : Math.min(3600, 15 * 2 ** (job.attempts - 1));
  app.db.run("UPDATE jobs SET status = ?, last_error = ?, lease_id = NULL, lease_expires_at = NULL, run_after = ?, updated_at = ? WHERE id = ?",
    final ? "failed" : "queued", error.slice(0, 2000), addSeconds(backoff), nowIso(), jobId);
  return { finalFailure: final };
}

/**
 * Return expired leases to the queue (crash/restart recovery). A job whose lease keeps expiring (it crashes the worker)
 * stops after its attempts run out; `onFailed` is told about each such job in the same transaction, so what a failure
 * means to the person is recorded before anything can queue the work again.
 */
export function expireLeases(app: App, onFailed?: (job: { kind: string; payload: Record<string, unknown> }) => void): number {
  const now = nowIso();
  return app.db.tx(() => {
    // Jobs that may not run now wait in the queue; their expired lease doesn't count as an attempt.
    app.db.run(`UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE status = 'leased' AND lease_expires_at < ? AND NOT ${RUNNABLE_JOB_SQL}`, now, now);
    // A job whose lease keeps expiring (e.g. it crashes the worker) stops after its attempts run out, and what that means is recorded.
    const ended = app.db.all<{ kind: string; payload: string }>("SELECT kind, payload FROM jobs WHERE status = 'leased' AND lease_expires_at < ? AND attempts >= max_attempts", now);
    app.db.run("UPDATE jobs SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, last_error = COALESCE(last_error, 'The worker stopped responding while running this job.'), updated_at = ? WHERE status = 'leased' AND lease_expires_at < ? AND attempts >= max_attempts", now, now);
    for (const j of ended) onFailed?.({ kind: j.kind, payload: JSON.parse(j.payload) as Record<string, unknown> });
    return app.db.run("UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'leased' AND lease_expires_at < ?", now, now).changes;
  });
}

export function retryJob(app: App, jobId: string): boolean {
  return app.db.run(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled') AND ${RUNNABLE_JOB_SQL}`, nowIso(), nowIso(), jobId).changes === 1;
}

export function cancelJob(app: App, jobId: string): boolean {
  return app.db.run("UPDATE jobs SET status = 'cancelled', lease_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')", nowIso(), jobId).changes === 1;
}
