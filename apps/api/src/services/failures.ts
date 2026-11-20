import type { FailureReason } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError, nowIso } from "../http.ts";
import { usableAccountSql } from "./deletion.ts";
import { enqueue } from "./jobs.ts";
import { failCapture } from "./captures.ts";
import { failIconCheck } from "./icons.ts";
import { onSubscribeFailed } from "./sources.ts";
import { failJudging } from "./ai-filters.ts";
import { server } from "@purss/copy/server";

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
      return server.api.failures.delayedTooMuch;
    case "unavailable":
      return server.api.failures.delayedNotResponding;
    case "too_large":
      return server.api.failures.heldBackNotSaved;
    default:
      return server.api.failures.heldBackUnknown;
  }
}

/** The state of a source whose subscription is still being retried (the person doesn't need to do anything). */
export function subscribeRetryText(reason: FailureReason | undefined): string | null {
  if (reason === "rate_limited") return server.api.failures.siteLimiting;
  if (reason === "unavailable") return server.api.failures.siteNotAnswering;
  return null;
}

/** The state of a source that could not be followed and won't be retried by itself. */
export function subscribeGaveUpText(reason: FailureReason | undefined): string {
  switch (reason) {
    case "rate_limited":
      return server.api.failures.siteKeptLimiting;
    case "unavailable":
      return server.api.failures.siteDidNotAnswer;
    case "not_found":
      return server.api.failures.noFeedAnyMore;
    case "refused":
      return server.api.failures.siteRefused;
    case "not_a_feed":
      return server.api.failures.notAFeed;
    default:
      return server.api.failures.couldNotFollow;
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
    if (job.kind === "engine.subscribe") onSubscribeFailed(app, String(payload.sourceId), subscribeGaveUpText(reason), reason ?? null);
    if (job.kind === "engine.provision") app.db.run("UPDATE engine_users SET status = 'error' WHERE id = ?", String(payload.engineUserId));
    if (job.kind === "source.icon") failIconCheck(app, String(payload.sourceId));
    if (job.kind === "filter.judge") failJudging(app, payload);
    if (job.kind === "capture.fulltext") failCapture(app, String(payload.captureId), server.api.failures.pageNotCaptured);
  } else if (job.kind === "engine.subscribe") {
    const text = subscribeRetryText(reason);
    if (text) onSubscribeFailed(app, String(payload.sourceId), text, reason ?? null);
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

/**
 * A feed too big for the engine to read whole makes the engine fail the request itself, which a source showed as "The site isn't
 * answering right now" (and, after the retries, "The site didn't answer"). Such a source has no subscription, so it is subscribed
 * once more: the worker then asks whether the feed really is that big and, if so, follows it through the feed gateway;
 * for any other cause the answer is the same as before. Once per source (the job's key remembers it), and only for a source that
 * has no subscription job waiting or running, so a retry already on its way is not doubled.
 */
export function retryOverloadedSubscribes(app: App): void {
  const rows = app.db.all<{ id: string; title: string; feed_url: string | null; is_private: number; account_id: string; workspace_id: string; eu: string }>(
    `SELECT s.id, s.title, s.feed_url, s.is_private, s.account_id, s.workspace_id, eu.id AS eu
     FROM sources s JOIN engine_users eu ON eu.account_id = s.account_id AND eu.status = 'ready'
     WHERE s.followed = 1 AND s.kind <> 'manual' AND s.builtin IS NULL AND s.via_gateway = 0 AND s.health = 'error' AND s.engine_stream_id IS NULL
       AND s.health_reason = 'unavailable'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'subscribe:' || s.id AND j.status IN ('queued', 'leased'))
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'gateway-retry:' || s.id)
     LIMIT 50`);
  for (const s of rows) {
    const feedUrl = s.is_private ? `secret:source-urls/${s.id}` : s.feed_url;
    if (!feedUrl || feedUrl.startsWith("bridge:")) continue;
    try {
      enqueue(app, "engine.subscribe", { engineUserId: s.eu, sourceId: s.id, feedUrl, title: s.title }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `gateway-retry:${s.id}` });
    } catch (err) {
      // An account that is suspended or being deleted starts nothing; it is looked at again when it is usable.
      if (!(err instanceof HttpError)) throw err;
    }
  }
}

/**
 * What an earlier version stored in `sources.health_text` when a feed could not be followed: "The feed is too large to follow." for
 * a feed the engine or the feed gateway refused for its size, and a not-a-feed message that added "It may be too large". No size is
 * ever stored or shown now (a big feed is followed through the gateway; one that can't be followed says what any other failure says),
 * so a source still carrying either is brought up to date: its text becomes what the same failure says now.
 */
// Not copy: these are the exact texts earlier versions wrote, and they never change.
export const EARLIER_TOO_LARGE_TEXT = "The feed is too large to follow.";
export const EARLIER_NOT_A_FEED_TEXT = "The address answers, but not with a feed we can read. It may be too large or in a format we don't support.";

/**
 * Sources that failed with the earlier size message get the plain message and one more subscription through the feed gateway (`trim`),
 * whether or not they were already marked as followed through it: the gateway reads a feed that is too big for the engine as far as is
 * useful, which is what the earlier versions refused. The text is the marker, and it is replaced in the same transaction that starts the
 * try, so a source is looked at once: a try that fails again says the plain message, which this does not match, and nothing starts twice
 * (the job's key re-arms a finished try of the same source and leaves one that is still on its way). Sources whose message was the
 * not-a-feed one are only reworded: nothing says a retry would help. A source that can't be asked again (no engine yet, no address,
 * not followed, a subscription already waiting) is reworded and left. An account that is suspended or being deleted is left as it is until it is usable.
 */
export function retryEarlierSizeFailures(app: App): void {
  const rows = app.db.all<{ id: string; title: string; feed_url: string | null; is_private: number; account_id: string; workspace_id: string; eu: string; health_text: string; retryable: number; waiting: number }>(
    `SELECT s.id, s.title, s.feed_url, s.is_private, s.account_id, s.workspace_id, s.health_text, eu.id AS eu,
            (s.followed = 1 AND s.kind <> 'manual' AND s.builtin IS NULL AND s.engine_stream_id IS NULL) AS retryable,
            EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'subscribe:' || s.id AND j.status IN ('queued', 'leased')) AS waiting
     FROM sources s JOIN engine_users eu ON eu.account_id = s.account_id AND eu.status = 'ready'
     WHERE s.health = 'error' AND s.health_text IN (?, ?) AND ${usableAccountSql("s.account_id")}
     LIMIT 50`, EARLIER_TOO_LARGE_TEXT, EARLIER_NOT_A_FEED_TEXT);
  for (const s of rows) {
    const tooLarge = s.health_text === EARLIER_TOO_LARGE_TEXT;
    const feedUrl = s.is_private ? `secret:source-urls/${s.id}` : s.feed_url;
    const retry = tooLarge && s.retryable === 1 && s.waiting === 0 && !!feedUrl && !feedUrl.startsWith("bridge:");
    try {
      app.db.tx(() => {
        app.db.run("UPDATE sources SET health_text = ?, health_reason = ? WHERE id = ? AND health = 'error' AND health_text = ?", subscribeGaveUpText(tooLarge ? undefined : "not_a_feed"), tooLarge ? null : "not_a_feed", s.id, s.health_text);
        if (retry) enqueue(app, "engine.subscribe", { engineUserId: s.eu, sourceId: s.id, feedUrl, title: s.title, trim: true }, { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `gateway-retry:${s.id}` });
      });
    } catch (err) {
      // An account that became unusable since it was read starts nothing, and keeps its text for the next time; any other failure is not hidden.
      if (!(err instanceof HttpError)) throw err;
    }
  }
}
