import { newId, isJobKind, jobPayloadSchemas, jobResultSchemas } from "@purss/domain";
import type { FailureReason, JobKind, JobPayload, JobResult, LeasedJob } from "@purss/domain";
import type { App } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, addSeconds, nowIso, parse } from "../http.ts";
import { isAccountUsable, usableAccountSql } from "./deletion.ts";
import { SUBSCRIBE_RETRY_BACKOFF_SECONDS, recordSyncFailure, subscribeGaveUpText, subscribeRetryText } from "./failures.ts";
import { completeCapture, failCapture } from "./captures.ts";
import { completeIconCheck, failIconCheck } from "./icons.ts";
import { completeImages } from "./images.ts";
import { completeJudging, failJudging } from "./ai-filters.ts";
import { onSubscribeFailed, onSubscribed } from "./sources.ts";
import { recordSyncSuccess } from "./sync.ts";
import { server } from "@purss/translations/server";

export const LEASE_SECONDS = 120;

/**
 * SQL condition on `jobs`: the job may run. Jobs of an account that is suspended or being deleted
 * wait (the worker's calls for them answer lease_lost) and resume intact once it is usable again;
 * the one exception is the job that removes a deleted account's engine user.
 */
export const RUNNABLE_JOB_SQL = `(jobs.account_id IS NULL OR jobs.kind = 'engine.delete_user' OR ${usableAccountSql("jobs.account_id")})`;

export type EnqueueOpts = { accountId?: string | null; idempotencyKey?: string; runAfter?: string; maxAttempts?: number };

/** Enqueue a durable job. Call inside the transaction that requires it (outbox). */
export function enqueue<K extends JobKind>(app: App, kind: K, payload: unknown, opts: EnqueueOpts = {}): string {
  const parsed = jobPayloadSchemas[kind].parse(payload);
  if (opts.accountId && kind !== "engine.delete_user" && !isAccountUsable(app, opts.accountId)) {
    throw new HttpError(409, "account_unavailable", server.api.jobs.accountUnavailable);
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
    `INSERT INTO jobs (id, account_id, kind, payload, run_after, max_attempts, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, opts.accountId ?? null, kind, JSON.stringify(parsed), opts.runAfter ?? now, opts.maxAttempts ?? 6, opts.idempotencyKey ?? null, now, now,
  );
  return id;
}

/** A job as its kind's rules see it: the account it belongs to and the payload `enqueue` stored. */
type JobContext<K extends JobKind> = { accountId: string | null; payload: JobPayload<K> };

/**
 * Everything one kind of job means to the product, so the route that hands out and takes back jobs knows none of it. Each hook
 * runs inside the transaction that records the job's outcome, so what the job changes and the job's own state land together.
 * A kind with nothing to change for a person leaves the hook out.
 */
type JobKindRules<K extends JobKind> = {
  /** The worker reported the job done: what it changes. `result` has passed the kind's `jobResultSchemas` entry. */
  onComplete?(app: App, job: JobContext<K>, result: JobResult<K>): void;
  /** What stays on the finished job (default: the result as the worker sent it). Captured text, pictures and icon bytes live in their own tables. */
  storedResult?(sent: Record<string, unknown>, result: JobResult<K>): unknown;
  /** Seconds before each retry of a failure with this reason, when it has a schedule of its own (the retries stop when the list does). */
  retryDelays?(reason: FailureReason | undefined): readonly number[] | undefined;
  /** A run failed and the job will run again. */
  onRetry?(app: App, job: JobContext<K>, reason: FailureReason | undefined): void;
  /**
   * The job failed for good: its attempts ran out, or the failure was not retryable. After a reported failure `reason` says
   * why; after a lease that expired for the last time (a worker that keeps dying) it is absent.
   */
  onFinalFailure?(app: App, job: JobContext<K>, reason: FailureReason | undefined): void;
  /** An administrator cancelled the job while it was still queued, so it never ran. */
  onCancel?(app: App, job: JobContext<K>): void;
};

const JOB_RULES: { [K in JobKind]: JobKindRules<K> } = {
  "engine.provision": {
    onComplete: (app, { payload }, result) => {
      app.db.run("UPDATE engine_users SET status = 'ready', engine_identity = COALESCE(engine_identity, ?) WHERE id = ?", result.engineIdentity ?? null, payload.engineUserId);
    },
    onFinalFailure: (app, { payload }) => {
      app.db.run("UPDATE engine_users SET status = 'error' WHERE id = ?", payload.engineUserId);
    },
  },
  "engine.subscribe": {
    onComplete: (app, { payload }, result) => onSubscribed(app, payload.sourceId, result.streamId, { empty: result.empty === true, viaGateway: result.viaGateway === true }),
    // A site that limits requests or doesn't answer is retried after 1, 5 and 30 minutes, then the source says so and waits for the person.
    retryDelays: (reason) => (reason === "rate_limited" || reason === "unavailable" ? SUBSCRIBE_RETRY_BACKOFF_SECONDS : undefined),
    onRetry: (app, { payload }, reason) => {
      const text = subscribeRetryText(reason);
      if (text) onSubscribeFailed(app, payload.sourceId, text, reason ?? null);
    },
    onFinalFailure: (app, { payload }, reason) => onSubscribeFailed(app, payload.sourceId, subscribeGaveUpText(reason), reason ?? null),
  },
  "engine.unsubscribe": {},
  "engine.rename": {},
  "engine.sync": {
    // A sync with nothing new posts no batch; its completion still proves the engine answered.
    onComplete: (app, { payload }) => recordSyncSuccess(app, payload.engineUserId),
    onRetry: (app, { payload }, reason) => recordSyncFailure(app, payload.engineUserId, reason, false),
    onFinalFailure: (app, { payload }, reason) => recordSyncFailure(app, payload.engineUserId, reason, true),
  },
  "engine.mark_read": {},
  "capture.fulltext": {
    onComplete: (app, { payload }, result) => completeCapture(app, payload.captureId, result),
    storedResult: () => ({ captured: true }),
    onFinalFailure: (app, { payload }) => failCapture(app, payload.captureId, server.api.failures.pageNotCaptured),
  },
  "capture.images": {
    onComplete: (app, { payload }, result) => completeImages(app, payload, result),
    storedResult: (_sent, result) => ({ pictures: Array.isArray(result.images) ? result.images.length : 0 }),
  },
  "source.icon": {
    onComplete: (app, { payload }, result) => completeIconCheck(app, payload.sourceId, result),
    storedResult: (_sent, result) => ({ found: result.found === true }),
    onFinalFailure: (app, { payload }) => failIconCheck(app, payload.sourceId),
  },
  "engine.delete_user": {},
  "filter.judge": {
    onComplete: (app, job, result) => completeJudging(app, job, result),
    storedResult: (sent, result) => {
      const stored: Record<string, unknown> = { ...sent, verdicts: result.verdicts.length };
      delete stored.model;
      return stored;
    },
    // The posts stay as they are and new ones are announced as a sync would have, whether the job failed or an administrator cancelled it.
    onFinalFailure: (app, { payload }) => failJudging(app, payload),
    onCancel: (app, { payload }) => failJudging(app, payload),
  },
};

function rulesFor<K extends JobKind>(kind: K): JobKindRules<K> {
  return JOB_RULES[kind];
}

/** The payload was checked against its kind's schema when the job was queued (by this version or an earlier one), so it is read back as that. */
function contextOf<K extends JobKind>(job: JobRow): JobContext<K> {
  return { accountId: job.account_id, payload: JSON.parse(job.payload) as JobPayload<K> };
}

/** What a failure means for a person, once it is recorded on the job. A job of a kind this version doesn't know (a retired one) has nothing to settle. */
function settleFailure(app: App, job: JobRow, finalFailure: boolean, reason?: FailureReason): void {
  if (!isJobKind(job.kind)) return;
  const rules = rulesFor(job.kind);
  if (finalFailure) rules.onFinalFailure?.(app, contextOf(job), reason);
  else rules.onRetry?.(app, contextOf(job), reason);
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

type JobRow = { id: string; kind: string; account_id: string | null; payload: string };

/** Returns the job row when the lease is still current and the job may run, otherwise null (lost lease). */
export function currentLease(app: App, jobId: string, leaseId: string): JobRow | null {
  return app.db.get<JobRow>(`SELECT id, kind, account_id, payload FROM jobs WHERE id = ? AND lease_id = ? AND status = 'leased' AND ${RUNNABLE_JOB_SQL}`, jobId, leaseId) ?? null;
}

export function heartbeat(app: App, jobId: string, leaseId: string): boolean {
  const r = app.db.run(`UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased' AND ${RUNNABLE_JOB_SQL}`,
    addSeconds(LEASE_SECONDS), nowIso(), jobId, leaseId);
  return r.changes === 1;
}

/** A leased job that may not run any more goes back to the queue without using up an attempt. */
function returnWaitingJob(app: App, jobId: string, leaseId: string): boolean {
  return app.db.run(`UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased' AND NOT ${RUNNABLE_JOB_SQL}`,
    nowIso(), jobId, leaseId).changes === 1;
}

/**
 * The worker reports a leased job done. The result is checked against its kind, the kind's `onComplete` changes what it
 * must, and the job is finished with what its kind keeps of the result, all in one transaction. False: the lease is lost
 * (expired, taken by another run, or the account can't be served now), and nothing changed.
 */
export function completeLeasedJob(app: App, jobId: string, leaseId: string, sent: Record<string, unknown> = {}): boolean {
  const job = currentLease(app, jobId, leaseId);
  if (!job) return false;
  app.db.tx(() => completeJob(app, job.id, leaseId, isJobKind(job.kind) ? finish(app, job.kind, job, sent) : sent));
  if (job.account_id) emit(app, job.account_id, { type: "jobs" });
  return true;
}

/** Runs a kind's `onComplete` on a result that matches the kind and returns what the finished job keeps. */
function finish<K extends JobKind>(app: App, kind: K, job: JobRow, sent: Record<string, unknown>): unknown {
  const rules = rulesFor(kind);
  const result = parse(jobResultSchemas[kind], sent) as JobResult<K>;
  rules.onComplete?.(app, contextOf<K>(job), result);
  return rules.storedResult ? rules.storedResult(sent, result) : sent;
}

/**
 * The worker reports a leased job failed. The failure is recorded on the job (retried after a delay, or failed for good) and
 * the kind's `onRetry` or `onFinalFailure` says what that means for the person, in one transaction. False: the lease is lost,
 * and a job whose account can't be served now goes back to the queue without using up an attempt.
 */
export function failLeasedJob(app: App, jobId: string, leaseId: string, failure: { error: string; retryable: boolean; reason?: FailureReason | undefined }): boolean {
  const job = currentLease(app, jobId, leaseId);
  if (!job) {
    returnWaitingJob(app, jobId, leaseId);
    return false;
  }
  app.db.tx(() => {
    const retryDelays = isJobKind(job.kind) ? rulesFor(job.kind).retryDelays?.(failure.reason) : undefined;
    const outcome = failJob(app, job.id, leaseId, failure.error, failure.retryable, retryDelays ? { retryDelays } : {});
    if (outcome) settleFailure(app, job, outcome.finalFailure, failure.reason);
  });
  if (job.account_id) emit(app, job.account_id, { type: "jobs" });
  return true;
}

function completeJob(app: App, jobId: string, leaseId: string, result: unknown): boolean {
  const r = app.db.run("UPDATE jobs SET status = 'done', result = ?, lease_id = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'leased'",
    JSON.stringify(result ?? null), nowIso(), jobId, leaseId);
  return r.changes === 1;
}

/**
 * Record a failed run. A retryable failure is queued again after a growing delay until the attempts run out. With
 * `retryDelays`, each retry waits for its own delay (in seconds) and the retries stop when the list does.
 */
function failJob(app: App, jobId: string, leaseId: string, error: string, retryable: boolean, opts: { retryDelays?: readonly number[] } = {}): { finalFailure: boolean } | null {
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
 * stops after its attempts run out, and what that means to the person (its kind's `onFinalFailure`) is recorded in the
 * same transaction, before anything can queue the work again.
 */
export function expireLeases(app: App): number {
  const now = nowIso();
  return app.db.tx(() => {
    // Jobs that may not run now wait in the queue; their expired lease doesn't count as an attempt.
    app.db.run(`UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE status = 'leased' AND lease_expires_at < ? AND NOT ${RUNNABLE_JOB_SQL}`, now, now);
    // A job whose lease keeps expiring (e.g. it crashes the worker) stops after its attempts run out, and what that means is recorded.
    const ended = app.db.all<JobRow>("SELECT id, kind, account_id, payload FROM jobs WHERE status = 'leased' AND lease_expires_at < ? AND attempts >= max_attempts", now);
    app.db.run("UPDATE jobs SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, last_error = COALESCE(last_error, 'The worker stopped responding while running this job.'), updated_at = ? WHERE status = 'leased' AND lease_expires_at < ? AND attempts >= max_attempts", now, now);
    for (const job of ended) settleFailure(app, job, true);
    return app.db.run("UPDATE jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'leased' AND lease_expires_at < ?", now, now).changes;
  });
}

export function retryJob(app: App, jobId: string): boolean {
  return app.db.run(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled') AND ${RUNNABLE_JOB_SQL}`, nowIso(), nowIso(), jobId).changes === 1;
}

/** Cancel a queued or failed job. A queued one never ran, so its kind's `onCancel` says what that leaves; a failed one was settled when it failed. */
export function cancelJob(app: App, jobId: string): boolean {
  return app.db.tx(() => {
    const job = app.db.get<JobRow & { status: string }>("SELECT id, kind, account_id, payload, status FROM jobs WHERE id = ?", jobId);
    const cancelled = app.db.run("UPDATE jobs SET status = 'cancelled', lease_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')", nowIso(), jobId).changes === 1;
    if (cancelled && job?.status === "queued" && isJobKind(job.kind)) rulesFor(job.kind).onCancel?.(app, contextOf(job));
    return cancelled;
  });
}
