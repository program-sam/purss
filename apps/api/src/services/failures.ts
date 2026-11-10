import type { FailureReason } from "@purss/domain";
import type { App } from "../app.ts";
import { nowIso } from "../http.ts";
import { failCapture } from "./captures.ts";
import { failIconCheck } from "./icons.ts";
import { onSubscribeFailed } from "./sources.ts";
import { failJudging } from "./ai-filters.ts";

/**
 * What a failed job means for a person, and how long to wait before trying again. The worker reports
 * a reason code (`FailureReason`) with each failure; the wording lives here so the product owns it.
 */

/** Seconds to wait before the next sync after each consecutive final failure; the last value repeats (1, 5, 15, 60 minutes). */
export const SYNC_FAILURE_BACKOFF_SECONDS = [60, 300, 900, 3600] as const;

/**
 * Delays before the retries of a subscribe that the site limited ("too many requests") or did not answer (1, 5, 30
 * minutes); then it stops and the source waits for the person.
 */
export const SUBSCRIBE_RETRY_BACKOFF_SECONDS = [60, 300, 1800] as const;

/** A subscribe failure that is expected to pass on its own, so it is retried on the longer schedule. */
export const subscribeWaits = (reason: FailureReason | undefined): boolean => reason === "rate_limited" || reason === "unavailable";

/** Seconds after a sync attempt before the next one is due, given how many runs in a row have failed. */
export function syncDelaySeconds(intervalSeconds: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return intervalSeconds;
  const step = SYNC_FAILURE_BACKOFF_SECONDS[Math.min(consecutiveFailures, SYNC_FAILURE_BACKOFF_SECONDS.length) - 1]!;
  return Math.max(intervalSeconds, step);
}

/** Shown on Home when collecting new items failed. Says what happened and what still works, without service names. */
export function syncFailureText(reason: FailureReason | undefined): string {
  switch (reason) {
    case "rate_limited":
      return "New items are delayed: the collection engine is being asked for too much at once. Everything you have is still here, and we'll keep trying.";
    case "unavailable":
      return "New items are delayed: the collection engine isn't responding. Everything you have is still here, and we'll keep trying.";
    case "too_large":
      return "New items are held back: an update from one of your sources was too large to save. Everything you have is still here, and we'll keep trying.";
    default:
      return "New items are held back by a problem we couldn't work out. Everything you have is still here. We'll keep trying, a little less often each time; if it lasts, the person running this PURSS can check the worker log.";
  }
}

/** The state of a source whose subscription is still being retried (the person doesn't need to do anything). */
export function subscribeRetryText(reason: FailureReason | undefined): string | null {
  if (reason === "rate_limited") return "The site is limiting requests; we'll keep trying.";
  if (reason === "unavailable") return "The site isn't answering right now; we'll keep trying.";
  return null;
}

/** The state of a source that could not be followed and won't be retried by itself. */
export function subscribeGaveUpText(reason: FailureReason | undefined): string {
  switch (reason) {
    case "rate_limited":
      return "The site kept limiting requests, so we stopped trying for now. Try again later.";
    case "unavailable":
      return "The site didn't answer, so this source couldn't be set up. Try again later.";
    case "not_found":
      return "There's no feed at that address any more. Check the link and add it again.";
    case "refused":
      return "The site refused the request. Check that the link is public and still works.";
    case "too_large":
      return "The feed is too large to follow.";
    case "not_a_feed":
      return "The address answers, but not with a feed we can read. It may be too large or in a format we don't support.";
    default:
      return "The collection engine couldn't follow this feed. Try again later or check the link.";
  }
}

/**
 * What a job's failure changes for the person, once the failure is recorded on the job: after a reported failure, and after a
 * lease that expired for the last time (a worker that keeps dying must not leave a source, copy or sync looking fine).
 * A sync that fails for good gets plain words on its checkpoint and counts toward the wait before its next run.
 */
export function settleFailedJob(app: App, job: { kind: string; payload: Record<string, unknown> }, outcome: { finalFailure: boolean }, reason?: FailureReason): void {
  const { payload } = job;
  if (outcome.finalFailure) {
    if (job.kind === "engine.subscribe") onSubscribeFailed(app, String(payload.sourceId), subscribeGaveUpText(reason));
    if (job.kind === "engine.provision") app.db.run("UPDATE engine_users SET status = 'error' WHERE id = ?", String(payload.engineUserId));
    if (job.kind === "source.icon") failIconCheck(app, String(payload.sourceId));
    if (job.kind === "filter.judge") failJudging(app, payload);
    if (job.kind === "capture.fulltext") failCapture(app, String(payload.captureId), "The page couldn't be captured. Its details and feed content are still kept.");
  } else if (job.kind === "engine.subscribe") {
    const text = subscribeRetryText(reason);
    if (text) onSubscribeFailed(app, String(payload.sourceId), text);
  }
  if (job.kind === "engine.sync") {
    // The job keeps the technical error. Runs that fail for good are counted so the next run waits longer each time
    // instead of hammering the engine; the row is created when the first run fails.
    const final = outcome.finalFailure ? 1 : 0;
    app.db.run(
      `INSERT INTO sync_checkpoints (engine_user_id, last_attempt_at, last_error, consecutive_failures) VALUES (?, ?, ?, ?)
       ON CONFLICT(engine_user_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
         consecutive_failures = consecutive_failures + ?`,
      String(payload.engineUserId), nowIso(), syncFailureText(reason), final, final);
  }
}
