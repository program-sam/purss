import { z } from "zod";
import { JOB_KINDS, syncBatchSchema, jobResultSchema, jobFailureSchema } from "@purss/domain";
import type { JobKind } from "@purss/domain";
import type { App } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, Router, nowIso, parse } from "../http.ts";
import { RUNNABLE_JOB_SQL, completeJob, currentLease, failJob, heartbeat, leaseJobs, returnWaitingJob } from "../services/jobs.ts";
import { SUBSCRIBE_RETRY_BACKOFF_SECONDS, settleFailedJob, subscribeWaits } from "../services/failures.ts";
import { deletionEngineState, finalizeDeletion, openEngineReview, recordEngineAttempt, recordEngineRemoved } from "../services/deletion.ts";
import { applySyncBatch, recordSyncSuccess } from "../services/sync.ts";
import { onSubscribeFailed, onSubscribed } from "../services/sources.ts";
import { completeCapture, failCapture } from "../services/captures.ts";
import { completeIconCheck, failIconCheck } from "../services/icons.ts";
import { completeImages } from "../services/images.ts";
import { completeJudging, judgeInput } from "../services/ai-filters.ts";
import { aiJudgeResultSchema } from "@purss/domain";

/**
 * Request body limit of the sync batch route. The worker keeps a batch under its own cap, counted in UTF-8 bytes
 * (at most 5 MB, see its config); this leaves headroom over that cap. Other internal routes keep the default.
 */
const SYNC_BATCH_BODY_LIMIT = 8 * 1024 * 1024;

/** A finished job's result: the pictures of one kept item, which may be 10 MB, come back whole as base64. */
const JOB_RESULT_BODY_LIMIT = 16 * 1024 * 1024;

/** Service-authenticated routes for the worker. Never mounted on the public listener. */
export function internalRouter(app: App): Router<{ app: App }> {
  const r = new Router<{ app: App }>();

  r.post("/internal/jobs/lease", (req) => {
    // A worker from another version may ask for kinds this API doesn't have: it gets none of those, and its other kinds still run.
    const body = parse(z.object({ kinds: z.array(z.string().max(64)).min(1).max(50), max: z.number().int().min(1).max(50) }), req.body);
    const kinds = body.kinds.filter((k): k is JobKind => (JOB_KINDS as readonly string[]).includes(k));
    return { jobs: kinds.length ? leaseJobs(app, kinds, body.max) : [] };
  });

  r.post("/internal/jobs/:id/heartbeat", (req) => {
    const { leaseId } = parse(z.object({ leaseId: z.string() }), req.body);
    if (!heartbeat(app, req.params.id!, leaseId)) throw new HttpError(409, "lease_lost", "Lease lost.");
    return { ok: true };
  });

  r.post("/internal/jobs/:id/complete", (req) => {
    const body = parse(jobResultSchema, req.body);
    const job = currentLease(app, req.params.id!, body.leaseId);
    if (!job) throw new HttpError(409, "lease_lost", "Lease lost.");
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    const result = body.result ?? {};
    app.db.tx(() => {
      if (job.kind === "engine.subscribe") {
        const streamId = z.string().min(1).parse(result.streamId);
        onSubscribed(app, String(payload.sourceId), streamId, { empty: result.empty === true });
      } else if (job.kind === "engine.provision") {
        app.db.run("UPDATE engine_users SET status = 'ready', engine_identity = COALESCE(engine_identity, ?) WHERE id = ?",
          typeof result.engineIdentity === "string" ? result.engineIdentity : null, String(payload.engineUserId));
      } else if (job.kind === "capture.fulltext") {
        completeCapture(app, String(payload.captureId), result);
      } else if (job.kind === "capture.images") {
        completeImages(app, { itemId: String(payload.itemId), urls: z.array(z.string()).parse(payload.urls) }, result);
      } else if (job.kind === "source.icon") {
        completeIconCheck(app, String(payload.sourceId), result);
      } else if (job.kind === "filter.judge") {
        const judged = aiJudgeResultSchema.parse(result);
        completeJudging(app, job, judged);
        result.verdicts = judged.verdicts.length;
        delete result.model;
      } else if (job.kind === "engine.sync") {
        // A sync with nothing new posts no batch; its completion still proves the engine answered.
        recordSyncSuccess(app, String(payload.engineUserId));
      }
      // Captured text, pictures and icon bytes live in their own tables, not in the job's result.
      completeJob(app, job.id, body.leaseId, job.kind === "capture.fulltext" ? { captured: true } : job.kind === "capture.images" ? { pictures: Array.isArray(result.images) ? result.images.length : 0 }
        : job.kind === "source.icon" ? { found: result.found === true } : result);
    });
    if (job.account_id) emit(app, job.account_id, { type: "jobs" });
    return { ok: true };
  }, { bodyLimit: JOB_RESULT_BODY_LIMIT });

  r.post("/internal/jobs/:id/fail", (req) => {
    const body = parse(jobFailureSchema, req.body);
    const job = currentLease(app, req.params.id!, body.leaseId);
    if (!job) {
      // A job whose account became unusable waits in the queue instead of using up an attempt.
      returnWaitingJob(app, req.params.id!, body.leaseId);
      throw new HttpError(409, "lease_lost", "Lease lost.");
    }
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    app.db.tx(() => {
      // A site that limits requests or doesn't answer is retried after 1, 5 and 30 minutes, then the source says so and waits for the person.
      const waits = job.kind === "engine.subscribe" && subscribeWaits(body.reason);
      const outcome = failJob(app, job.id, body.leaseId, body.error, body.retryable, waits ? { retryDelays: SUBSCRIBE_RETRY_BACKOFF_SECONDS } : {});
      if (outcome) settleFailedJob(app, { kind: job.kind, payload }, outcome, body.reason);
    });
    if (job.account_id) emit(app, job.account_id, { type: "jobs" });
    return { ok: true };
  });

  /** What a filter.judge job asks Jev, as the filters are when it runs (plan/36). Only the job's current lease may ask. */
  r.post("/internal/filters/:jobId/input", (req) => {
    const { leaseId } = parse(z.object({ leaseId: z.string() }), req.body);
    const job = currentLease(app, req.params.jobId!, leaseId);
    if (!job || job.kind !== "filter.judge") throw new HttpError(409, "lease_lost", "Lease lost.");
    return judgeInput(app, job);
  });

  r.post("/internal/sync/:engineUserId/batch", (req) => {
    const batch = parse(syncBatchSchema, req.body);
    const job = app.db.get(`SELECT 1 FROM jobs WHERE lease_id = ? AND status = 'leased' AND kind = 'engine.sync' AND json_extract(payload, '$.engineUserId') = ? AND lease_expires_at > ? AND ${RUNNABLE_JOB_SQL}`,
      batch.leaseId, req.params.engineUserId!, nowIso());
    if (!job) throw new HttpError(409, "lease_lost", "Lease lost.");
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
    const eu = app.db.get<{ workspace_id: string }>("SELECT workspace_id FROM engine_users WHERE id = ?", req.params.id!);
    if (!eu) throw new HttpError(404, "not_found", "Unknown engine user.");
    return {
      streams: app.db.all<{ engine_stream_id: string; paused: number }>(
        "SELECT engine_stream_id, paused FROM sources WHERE workspace_id = ? AND followed = 1 AND engine_stream_id IS NOT NULL", eu.workspace_id,
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
