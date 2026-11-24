import { z } from "zod";
import { isJobKind, syncBatchSchema, jobResultSchema, jobFailureSchema } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError, Router, nowIso, parse } from "../http.ts";
import { RUNNABLE_JOB_SQL, completeLeasedJob, currentLease, failLeasedJob, heartbeat, leaseJobs } from "../services/jobs.ts";
import { deletionEngineState, finalizeDeletion, openEngineReview, recordEngineAttempt, recordEngineRemoved } from "../services/deletion.ts";
import { applySyncBatch } from "../services/sync.ts";
import { judgeInput } from "../services/ai-filters.ts";

/**
 * Request body limit of the sync batch route. The worker keeps a batch under its own cap, counted in UTF-8 bytes
 * (at most 5 MB, see its config); this leaves headroom over that cap. Other internal routes keep the default.
 */
const SYNC_BATCH_BODY_LIMIT = 8 * 1024 * 1024;

/** A finished job's result: the pictures of one kept item, which may be 10 MB, come back whole as base64. */
const JOB_RESULT_BODY_LIMIT = 16 * 1024 * 1024;

const leaseLost = () => new HttpError(409, "lease_lost", "Lease lost.");

/** Service-authenticated routes for the worker. Never mounted on the public listener. */
export function internalRouter(app: App): Router<{ app: App }> {
  const r = new Router<{ app: App }>();

  r.post("/internal/jobs/lease", (req) => {
    // A worker from another version may ask for kinds this API doesn't have: it gets none of those, and its other kinds still run.
    const body = parse(z.object({ kinds: z.array(z.string().max(64)).min(1).max(50), max: z.number().int().min(1).max(50) }), req.body);
    const kinds = body.kinds.filter(isJobKind);
    return { jobs: kinds.length ? leaseJobs(app, kinds, body.max) : [] };
  });

  r.post("/internal/jobs/:id/heartbeat", (req) => {
    const { leaseId } = parse(z.object({ leaseId: z.string() }), req.body);
    if (!heartbeat(app, req.params.id!, leaseId)) throw leaseLost();
    return { ok: true };
  });

  r.post("/internal/jobs/:id/complete", (req) => {
    const body = parse(jobResultSchema, req.body);
    if (!completeLeasedJob(app, req.params.id!, body.leaseId, body.result)) throw leaseLost();
    return { ok: true };
  }, { bodyLimit: JOB_RESULT_BODY_LIMIT });

  r.post("/internal/jobs/:id/fail", (req) => {
    const body = parse(jobFailureSchema, req.body);
    if (!failLeasedJob(app, req.params.id!, body.leaseId, body)) throw leaseLost();
    return { ok: true };
  });

  /** What a filter.judge job asks Jev, as the filters are when it runs. Only the job's current lease may ask. */
  r.post("/internal/filters/:jobId/input", (req) => {
    const { leaseId } = parse(z.object({ leaseId: z.string() }), req.body);
    const job = currentLease(app, req.params.jobId!, leaseId);
    if (!job || job.kind !== "filter.judge") throw leaseLost();
    return judgeInput(app, job);
  });

  r.post("/internal/sync/:engineUserId/batch", (req) => {
    const batch = parse(syncBatchSchema, req.body);
    const job = app.db.get(`SELECT 1 FROM jobs WHERE lease_id = ? AND status = 'leased' AND kind = 'engine.sync' AND json_extract(payload, '$.engineUserId') = ? AND lease_expires_at > ? AND ${RUNNABLE_JOB_SQL}`,
      batch.leaseId, req.params.engineUserId!, nowIso());
    if (!job) throw leaseLost();
    const result = applySyncBatch(app, req.params.engineUserId!, batch);
    return { accepted: result.accepted, updated: result.updated, duplicates: result.duplicates, unknownStreams: result.unknownStreams, queuedForReview: result.queuedForReview };
  }, { bodyLimit: SYNC_BATCH_BODY_LIMIT });

  r.get("/internal/sync/:engineUserId/checkpoint", (req) => {
    const c = app.db.get<{ continuation: string | null; newest_crawl_usec: string | null; engine_identity: string | null }>(
      "SELECT continuation, newest_crawl_usec, engine_identity FROM sync_checkpoints WHERE engine_user_id = ?", req.params.engineUserId!);
    return { continuation: c?.continuation ?? null, newestCrawlUsec: c?.newest_crawl_usec ?? null, engineIdentity: c?.engine_identity ?? null };
  });

  r.get("/internal/engine-users/:id", (req) => {
    const eu = app.db.get<{ id: string; username: string; status: string }>("SELECT id, username, status FROM engine_users WHERE id = ?", req.params.id!);
    if (!eu) throw new HttpError(404, "not_found", "Unknown engine user.");
    return { id: eu.id, username: eu.username, status: eu.status, baseUrl: app.config.engineBaseUrl };
  });

  /** Stream ids the product follows for an engine user (paused sources are skipped by the worker). */
  r.get("/internal/engine-users/:id/streams", (req) => {
    const eu = app.db.get<{ account_id: string }>("SELECT account_id FROM engine_users WHERE id = ?", req.params.id!);
    if (!eu) throw new HttpError(404, "not_found", "Unknown engine user.");
    return {
      streams: app.db.all<{ engine_stream_id: string; paused: number }>(
        "SELECT engine_stream_id, paused FROM sources WHERE account_id = ? AND followed = 1 AND engine_stream_id IS NOT NULL", eu.account_id,
      ).map((s) => ({ streamId: s.engine_stream_id, paused: s.paused === 1 })),
    };
  });

  // ---------- account deletion, phase 2: only the engine.delete_user job's current lease may call these
  const deletionLease = z.object({ jobId: z.string(), leaseId: z.string() });
  r.post("/internal/deletions/:engineUserId", (req) => {
    const b = parse(deletionLease, req.body);
    return deletionEngineState(app, req.params.engineUserId!, b.jobId, b.leaseId);
  });
  r.post("/internal/deletions/:engineUserId/attempt", (req) => {
    const b = parse(deletionLease, req.body);
    return recordEngineAttempt(app, req.params.engineUserId!, b.jobId, b.leaseId);
  });
  r.post("/internal/deletions/:engineUserId/removed", (req) => {
    const b = parse(deletionLease, req.body);
    return recordEngineRemoved(app, req.params.engineUserId!, b.jobId, b.leaseId);
  });
  r.post("/internal/deletions/:engineUserId/review", (req) => {
    const b = parse(deletionLease, req.body);
    return openEngineReview(app, req.params.engineUserId!, b.jobId, b.leaseId);
  });
  r.post("/internal/deletions/:engineUserId/finalize", (req) => {
    const b = parse(deletionLease, req.body);
    return finalizeDeletion(app, req.params.engineUserId!, b.jobId, b.leaseId);
  });

  return r;
}
