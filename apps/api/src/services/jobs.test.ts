import test from "node:test";
import assert from "node:assert/strict";
import { server as copy } from "@purss/translations/server";
import { quickAddFailure } from "@purss/freshrss";
import type { FailureReason, JobKind } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { HttpError, addSeconds } from "../http.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { tick } from "../main.ts";
import { cancelJob, completeLeasedJob, enqueue, expireLeases, failLeasedJob, leaseJobs } from "./jobs.ts";
import { recordSyncSuccess, applySyncBatch } from "./sync.ts";
import { getSource, NO_POSTS_YET, retrySource } from "./sources.ts";
import { listItems } from "./items.ts";
import { queueCapture } from "./captures.ts";
import { EARLIER_NOT_A_FEED_TEXT, EARLIER_TOO_LARGE_TEXT, SUBSCRIBE_RETRY_BACKOFF_SECONDS, subscribeGaveUpText, syncDelaySeconds, syncFailureText } from "./failures.ts";

/*
 * What each kind of job means to the product, tested the way the route that hands out and takes back jobs uses it:
 * lease a job, then report it done or failed as the worker would.
 */

const { failures } = copy.api;

type Leased = ReturnType<typeof leaseJobs>[number];

/** Lease the job just enqueued, as the worker would. */
function leaseOne(app: App, kind: JobKind): Leased {
  const job = leaseJobs(app, [kind], 1)[0];
  assert.ok(job, `a ${kind} job is waiting`);
  return job;
}

const complete = (app: App, job: Leased, result?: Record<string, unknown>) => completeLeasedJob(app, job.id, job.leaseId, result);
const fail = (app: App, job: Leased, failure: { retryable: boolean; reason?: FailureReason; error?: string }) =>
  failLeasedJob(app, job.id, job.leaseId, { error: failure.error ?? "x", retryable: failure.retryable, reason: failure.reason });

const jobRow = (app: App, id: string) => app.db.get<{ status: string; run_after: string; attempts: number; result: string | null; last_error: string | null }>("SELECT status, run_after, attempts, result, last_error FROM jobs WHERE id = ?", id)!;

/** A job whose last lease has run out, as when the worker crashed on every attempt. */
const dies = (app: App, id: string) => app.db.run("UPDATE jobs SET attempts = max_attempts, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id);

async function bootHome() {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app);
  const pub = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const session = signIn(app, owner.accountId);
  return { app, owner, home: () => call(app, pub.base, "GET", "/api/bootstrap", session), close: async () => { await pub.close(); cleanup(); } };
}

// ---------- engine.provision

test("a provisioned engine user is ready with the engine's identity, which the first answer fixes; a failure for good marks it as an error", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const eu = () => app.db.get<{ status: string; engine_identity: string | null }>("SELECT status, engine_identity FROM engine_users WHERE id = ?", p.engineUserId)!;
  const provision = () => enqueue(app, "engine.provision", { engineUserId: p.engineUserId, username: "u" }, { accountId: p.accountId, idempotencyKey: `provision:${p.engineUserId}`, maxAttempts: 20 });
  app.db.run("UPDATE jobs SET status = 'cancelled'");
  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", p.engineUserId);

  provision();
  assert.equal(complete(app, leaseOne(app, "engine.provision"), { engineUserId: p.engineUserId, username: "u", engineIdentity: "freshrss:a", created: true }), true);
  assert.deepEqual({ ...eu() }, { status: "ready", engine_identity: "freshrss:a" });

  // Another run, or a worker that doesn't say which engine it is: the identity stays as first recorded.
  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", p.engineUserId);
  provision();
  complete(app, leaseOne(app, "engine.provision"), { engineIdentity: "freshrss:b" });
  assert.deepEqual({ ...eu() }, { status: "ready", engine_identity: "freshrss:a" });
  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", p.engineUserId);
  provision();
  complete(app, leaseOne(app, "engine.provision"), {});
  assert.equal(eu().status, "ready");

  // A failure that will be retried changes nothing; one for good is an error, however it is reached.
  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", p.engineUserId);
  provision();
  fail(app, leaseOne(app, "engine.provision"), { retryable: true });
  assert.equal(eu().status, "pending");
  app.db.run("UPDATE jobs SET run_after = ? WHERE kind = 'engine.provision'", addSeconds(-1));
  fail(app, leaseOne(app, "engine.provision"), { retryable: false });
  assert.equal(eu().status, "error");

  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", p.engineUserId);
  provision();
  dies(app, leaseOne(app, "engine.provision").id);
  expireLeases(app);
  assert.equal(eu().status, "error", "a worker that keeps dying on it");
});

test("metadata the worker reports in an odd shape never fails a provisioning: an identity that is not a string is not recorded", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const eu = () => app.db.get<{ status: string; engine_identity: string | null }>("SELECT status, engine_identity FROM engine_users WHERE id = ?", p.engineUserId)!;
  app.db.run("UPDATE jobs SET status = 'cancelled'");
  for (const engineIdentity of [null, 7, false, { id: "freshrss:a" }, ["freshrss:a"]]) {
    app.db.run("UPDATE engine_users SET status = 'pending', engine_identity = NULL WHERE id = ?", p.engineUserId);
    enqueue(app, "engine.provision", { engineUserId: p.engineUserId, username: "u" }, { accountId: p.accountId, idempotencyKey: `provision:${p.engineUserId}`, maxAttempts: 20 });
    const job = leaseOne(app, "engine.provision");
    assert.equal(complete(app, job, { engineUserId: p.engineUserId, username: "u", engineIdentity, created: true }), true, JSON.stringify(engineIdentity));
    assert.deepEqual({ ...eu() }, { status: "ready", engine_identity: null }, JSON.stringify(engineIdentity));
    assert.equal(jobRow(app, job.id).status, "done");
  }
});

// ---------- engine.subscribe

/** A source whose subscribe job is waiting, as just after Follow. */
function pendingSource(app: App, owner: Principal & { engineUserId: string }, stream = "feed/9") {
  const id = makeSource(app, owner, "Reddit: r/x", stream);
  app.db.run("UPDATE sources SET engine_stream_id = NULL, health = 'pending', health_text = 'Getting the first items…' WHERE id = ?", id);
  enqueue(app, "engine.subscribe", { engineUserId: owner.engineUserId, sourceId: id, feedUrl: "https://www.reddit.com/r/x/.rss", title: "Reddit: r/x" }, { accountId: owner.accountId, idempotencyKey: `subscribe:${id}` });
  return id;
}

test("a site that limits requests is retried after 1, 5 and 30 minutes, says so, then gives up with a retry that works", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  const limited = (job: Leased) => fail(app, job, { error: "The feed's server is limiting requests (HTTP 429); this will be retried with a delay.", retryable: true, reason: "rate_limited" });

  for (const wait of SUBSCRIBE_RETRY_BACKOFF_SECONDS) {
    const job = leaseOne(app, "engine.subscribe");
    const before = Date.now();
    assert.equal(limited(job), true);
    const next = jobRow(app, job.id);
    assert.equal(next.status, "queued");
    assert.ok(Math.abs(Date.parse(next.run_after) - (before + wait * 1000)) < 5000, `waits ${wait} s before the retry`);
    assert.deepEqual([getSource(app, owner, id).health, getSource(app, owner, id).healthText], ["error", failures.siteLimiting]);
    app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), job.id); // the wait passes
  }
  const last = leaseOne(app, "engine.subscribe");
  assert.equal(limited(last), true);
  assert.equal(jobRow(app, last.id).status, "failed", "after the third retry it stops");
  const gaveUp = getSource(app, owner, id);
  assert.deepEqual([gaveUp.health, gaveUp.healthText], ["error", subscribeGaveUpText("rate_limited")]);

  // The person can try again; the retry runs at once and starts the schedule over.
  assert.equal(retrySource(app, owner, id).health, "pending");
  const again = leaseOne(app, "engine.subscribe");
  assert.equal(again.id, last.id);
  assert.equal(again.attempts, 1);
  complete(app, again, { streamId: "feed/9" });
  assert.equal(getSource(app, owner, id).health, "pending", "following now; the first items are on the way");
  assert.equal(app.db.get<{ engine_stream_id: string }>("SELECT engine_stream_id FROM sources WHERE id = ?", id)!.engine_stream_id, "feed/9");
});

test("a retry brings a waiting retry forward, and only failed sources can be retried", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  assert.throws(() => retrySource(app, owner, id), (e: unknown) => (e as { code?: string }).code === "not_failed", "still collecting: nothing to retry");
  const job = leaseOne(app, "engine.subscribe");
  fail(app, job, { error: "limited", retryable: true, reason: "rate_limited" });
  assert.ok(Date.parse(jobRow(app, job.id).run_after) > Date.now() + 30_000);
  retrySource(app, owner, id);
  assert.ok(Date.parse(jobRow(app, job.id).run_after) <= Date.now(), "no need to wait out the minute");

  const other = makeOwner(app, { admin: false });
  assert.throws(() => retrySource(app, other, id), (e: unknown) => (e as { status?: number }).status === 404, "another account's source");
  const working = makeSource(app, owner, "Working", "feed/3");
  assert.throws(() => retrySource(app, owner, working), (e: unknown) => (e as { code?: string }).code === "not_failed");
});

test("the source says what went wrong when the engine can't follow it for good", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const cases: Array<[FailureReason, boolean, string]> = [
    ["not_found", false, failures.noFeedAnyMore],
    ["refused", false, failures.siteRefused],
    ["too_large", false, failures.couldNotFollow],
    ["not_a_feed", false, failures.notAFeed],
    ["unavailable", true, failures.siteDidNotAnswer],
    ["other", false, failures.couldNotFollow],
  ];
  for (const [reason, retryable, text] of cases) {
    const id = pendingSource(app, owner);
    // A retryable failure with the default schedule gets its six attempts first.
    app.db.run("UPDATE jobs SET max_attempts = 1 WHERE idempotency_key = ?", `subscribe:${id}`);
    fail(app, leaseOne(app, "engine.subscribe"), { retryable, reason });
    const s = getSource(app, owner, id);
    assert.equal(s.health, "error", reason);
    assert.equal(s.healthText, text, reason);
  }
});

test("a site that answers 503 at follow time is retried after 1, 5 and 30 minutes, and the source says so in plain words", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  // What the engine really says, classified the way the worker classifies it.
  const failure = quickAddFailure("HTTP 503 Service Unavailable!", "https://example.org/feed.xml");
  assert.deepEqual([failure.reason, failure.retryable], ["unavailable", true]);
  const id = pendingSource(app, owner);
  for (const wait of SUBSCRIBE_RETRY_BACKOFF_SECONDS) {
    const job = leaseOne(app, "engine.subscribe");
    const before = Date.now();
    assert.equal(fail(app, job, { error: failure.message, retryable: failure.retryable, reason: failure.reason ?? undefined }), true);
    assert.equal(jobRow(app, job.id).status, "queued");
    assert.ok(Math.abs(Date.parse(jobRow(app, job.id).run_after) - (before + wait * 1000)) < 5000, `waits ${wait} s, not seconds`);
    const s = getSource(app, owner, id);
    assert.deepEqual([s.health, s.healthText], ["error", failures.siteNotAnswering]);
    app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), job.id); // the wait passes
  }
  const last = leaseOne(app, "engine.subscribe");
  fail(app, last, { error: failure.message, retryable: true, reason: "unavailable" });
  assert.equal(jobRow(app, last.id).status, "failed", "after the third retry it stops");
  assert.equal(getSource(app, owner, id).healthText, subscribeGaveUpText("unavailable"));
});

test("a failure that is not about the site's answer keeps the queue's own retry schedule and says nothing yet", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  const job = leaseOne(app, "engine.subscribe");
  const before = Date.now();
  fail(app, job, { retryable: true, reason: "other" });
  assert.ok(Math.abs(Date.parse(jobRow(app, job.id).run_after) - (before + 15_000)) < 5000, "the first retry of the default schedule waits 15 s");
  assert.equal(getSource(app, owner, id).health, "pending", "the source still says it is collecting");
});

test("a source whose subscribe keeps losing its lease says it could not be followed, instead of collecting for ever", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  dies(app, leaseOne(app, "engine.subscribe").id);
  tick(app);
  const s = getSource(app, owner, id);
  assert.deepEqual([s.health, s.healthText], ["error", subscribeGaveUpText(undefined)]);
});

test("the engine's word that a fresh subscription's feed is empty reaches the source; a job that does not say it changes nothing", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const empty = pendingSource(app, owner);
  complete(app, leaseOne(app, "engine.subscribe"), { streamId: "feed/9", title: "Reddit: r/x", alreadySubscribed: false, empty: true });
  assert.deepEqual([getSource(app, owner, empty).health, getSource(app, owner, empty).healthText], ["quiet", NO_POSTS_YET]);

  const other = pendingSource(app, owner, "feed/11");
  complete(app, leaseOne(app, "engine.subscribe"), { streamId: "feed/10", title: "x", alreadySubscribed: false });
  assert.equal(getSource(app, owner, other).health, "pending");
  assert.equal(getSource(app, owner, other).healthText, "Getting the first items…");
});

test("a feed the engine follows through the feed gateway marks its source; the job keeps the whole answer", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  const job = leaseOne(app, "engine.subscribe");
  const sent = { streamId: "feed/9", title: "Reddit: r/x", alreadySubscribed: false, viaGateway: true, empty: false, somethingNewer: 1 };
  assert.equal(complete(app, job, sent), true);
  assert.equal(app.db.get<{ via_gateway: number }>("SELECT via_gateway FROM sources WHERE id = ?", id)!.via_gateway, 1);
  assert.deepEqual(JSON.parse(jobRow(app, job.id).result!), sent, "a field of a newer worker passes");
});

test("a subscription result without a stream id is refused, and the job is still the worker's to settle", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  const job = leaseOne(app, "engine.subscribe");
  for (const result of [undefined, {}, { streamId: "" }, { streamId: 7 }]) {
    assert.throws(() => complete(app, job, result), (e: unknown) => e instanceof HttpError && e.status === 400, JSON.stringify(result));
  }
  assert.equal(jobRow(app, job.id).status, "leased");
  assert.equal(getSource(app, owner, id).health, "pending");
  assert.equal(fail(app, job, { retryable: false, reason: "other" }), true);
  assert.equal(jobRow(app, job.id).status, "failed");
});

test("metadata the worker reports in an odd shape never fails a subscription: a word about the feed that is not literally true says nothing", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const odds = [{ empty: null }, { viaGateway: null }, { empty: "yes", viaGateway: 1 }, { empty: "true", viaGateway: "true" }, { empty: [true], viaGateway: {} }];
  odds.forEach((odd, i) => {
    const id = pendingSource(app, owner, `feed/${i + 1}`);
    const job = leaseOne(app, "engine.subscribe");
    assert.equal(complete(app, job, { streamId: `feed/9${i}`, title: "T", alreadySubscribed: false, ...odd }), true, JSON.stringify(odd));
    const s = getSource(app, owner, id);
    assert.deepEqual([s.health, s.healthText], ["pending", "Getting the first items…"], `${JSON.stringify(odd)}: following, nothing claimed about the feed`);
    const row = app.db.get<{ via_gateway: number; engine_stream_id: string }>("SELECT via_gateway, engine_stream_id FROM sources WHERE id = ?", id)!;
    assert.deepEqual({ ...row }, { via_gateway: 0, engine_stream_id: `feed/9${i}` });
    assert.equal(jobRow(app, job.id).status, "done");
  });
});

// ---------- engine.sync

const syncJob = (app: App, owner: { accountId: string; engineUserId: string }) =>
  enqueue(app, "engine.sync", { engineUserId: owner.engineUserId }, { accountId: owner.accountId, idempotencyKey: `sync:${owner.engineUserId}` });

const checkpoint = (app: App, engineUserId: string) =>
  app.db.get<{ last_error: string | null; last_attempt_at: string | null; last_success_at: string | null; consecutive_failures: number }>("SELECT last_error, last_attempt_at, last_success_at, consecutive_failures FROM sync_checkpoints WHERE engine_user_id = ?", engineUserId);

test("a sync that fails for good tells the person why on Home and waits longer each time", async (t) => {
  const b = await bootHome();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");
  const failSync = (reason: FailureReason | undefined, retryable: boolean) => {
    syncJob(b.app, b.owner);
    assert.equal(fail(b.app, leaseOne(b.app, "engine.sync"), { error: "The product API refused a request as too large (413).", retryable, reason }), true);
  };
  assert.equal(checkpoint(b.app, b.owner.engineUserId), undefined, "a brand-new account has no checkpoint row yet");

  failSync("too_large", false);
  const first = checkpoint(b.app, b.owner.engineUserId)!;
  assert.equal(first.last_error, syncFailureText("too_large"), "the checkpoint holds words for a person, not the technical error");
  assert.ok(!first.last_error!.includes("413"));
  assert.equal(first.consecutive_failures, 1);
  assert.ok(first.last_attempt_at, "the attempt is recorded even though no checkpoint existed (this is what let the maintenance tick re-queue it every 15 seconds)");

  const home = await b.home();
  assert.equal(home.status, 200);
  assert.equal(home.json.engine.status, "unavailable");
  assert.equal(home.json.engine.message, failures.heldBackNotSaved, "Home's engine notice says an update couldn't be saved");
  assert.ok(![EARLIER_TOO_LARGE_TEXT, EARLIER_NOT_A_FEED_TEXT].includes(home.json.engine.message), "and says nothing about sizes");

  // The maintenance tick leaves a failing sync alone until its wait is over.
  const queuedSync = () => b.app.db.get("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'queued'", `sync:${b.owner.engineUserId}`);
  tick(b.app);
  assert.equal(queuedSync(), undefined, "not re-queued straight after a failure");
  const ago = (seconds: number) => b.app.db.run("UPDATE sync_checkpoints SET last_attempt_at = ? WHERE engine_user_id = ?", addSeconds(-seconds), b.owner.engineUserId);
  ago(b.app.config.syncIntervalSeconds - 10);
  tick(b.app);
  assert.equal(queuedSync(), undefined);
  ago(b.app.config.syncIntervalSeconds + 10);
  tick(b.app);
  assert.ok(queuedSync(), "due again after the first wait");

  for (const wait of [300, 900, 3600]) {
    fail(b.app, leaseOne(b.app, "engine.sync"), { error: "boom", retryable: false, reason: "other" });
    const count = checkpoint(b.app, b.owner.engineUserId)!.consecutive_failures;
    ago(wait - 5);
    tick(b.app);
    assert.equal(queuedSync(), undefined, `after ${count} failures it waits ${wait / 60} minutes`);
    ago(wait + 5);
    tick(b.app);
    assert.ok(queuedSync());
  }
  fail(b.app, leaseOne(b.app, "engine.sync"), { error: "boom", retryable: false });
  ago(3600 - 5);
  tick(b.app);
  assert.equal(queuedSync(), undefined, "an hour is the longest wait");
  assert.equal(checkpoint(b.app, b.owner.engineUserId)!.last_error, failures.heldBackUnknown, "an unclassified failure still has words");

  recordSyncSuccess(b.app, b.owner.engineUserId);
  const after = checkpoint(b.app, b.owner.engineUserId)!;
  assert.deepEqual([after.last_error, after.consecutive_failures], [null, 0], "a success clears the notice and the count");
});

test("a completed sync clears the notice and the count, even when it had nothing new to post", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  syncJob(app, owner);
  fail(app, leaseOne(app, "engine.sync"), { retryable: false, reason: "unavailable" });
  assert.equal(checkpoint(app, owner.engineUserId)!.last_error, syncFailureText("unavailable"));
  syncJob(app, owner);
  complete(app, leaseOne(app, "engine.sync"), { pages: 0, batches: 0, entries: 0, accepted: 0, duplicates: 0, identityChanged: false, newestCrawlUsec: null });
  const cp = checkpoint(app, owner.engineUserId)!;
  assert.deepEqual([cp.last_error, cp.consecutive_failures], [null, 0]);
  assert.ok(cp.last_success_at);
});

test("a failure that will be retried shows its reason but doesn't count as a final failure", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  syncJob(app, owner);
  const job = leaseOne(app, "engine.sync");
  fail(app, job, { error: "The engine could not be reached.", retryable: true, reason: "unavailable" });
  const cp = checkpoint(app, owner.engineUserId)!;
  assert.equal(cp.last_error, syncFailureText("unavailable"));
  assert.equal(cp.consecutive_failures, 0);
  assert.equal(jobRow(app, job.id).status, "queued");
});

test("the wait after consecutive sync failures is 1, 5, 15 then 60 minutes, never shorter than the interval", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => syncDelaySeconds(30, n)), [30, 60, 300, 900, 3600, 3600, 3600]);
  assert.equal(syncDelaySeconds(120, 1), 120);
});

test("a sync that uses up its attempts through expired leases shows an error and waits, instead of being queued again at once", async (t) => {
  const b = await bootHome();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");
  const queued = () => b.app.db.get("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'queued'", `sync:${b.owner.engineUserId}`);
  const diesInTick = () => {
    const job = leaseOne(b.app, "engine.sync");
    // The worker crashed on every attempt: the last lease has run out and nothing was ever reported.
    dies(b.app, job.id);
    tick(b.app);
    assert.equal(jobRow(b.app, job.id).status, "failed");
  };
  syncJob(b.app, b.owner);
  assert.equal(checkpoint(b.app, b.owner.engineUserId), undefined);
  diesInTick();
  const first = checkpoint(b.app, b.owner.engineUserId)!;
  assert.equal(first.last_error, syncFailureText(undefined), "a plain-language error, though no failure was ever reported");
  assert.equal(first.consecutive_failures, 1);
  assert.ok(first.last_attempt_at);
  assert.equal(queued(), undefined, "the maintenance tick that found it did not queue it again at once");
  const home = await b.home();
  assert.equal(home.json.engine.status, "unavailable");
  assert.equal(home.json.engine.message, failures.heldBackUnknown);

  // Each further failure waits longer: 5 minutes after the second.
  b.app.db.run("UPDATE sync_checkpoints SET last_attempt_at = ? WHERE engine_user_id = ?", addSeconds(-(b.app.config.syncIntervalSeconds + 10)), b.owner.engineUserId);
  tick(b.app);
  assert.ok(queued(), "due again after the first wait");
  diesInTick();
  assert.equal(checkpoint(b.app, b.owner.engineUserId)!.consecutive_failures, 2);
  b.app.db.run("UPDATE sync_checkpoints SET last_attempt_at = ? WHERE engine_user_id = ?", addSeconds(-290), b.owner.engineUserId);
  tick(b.app);
  assert.equal(queued(), undefined, "five minutes after the second failure");
});

// ---------- capture.fulltext

function itemsWithPages(app: App, p: Principal & { engineUserId: string }, n: number) {
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: n }, () => entry("feed/1"))));
  const items = listItems(app, p, { scope: `source:${src}` }).items;
  for (const item of items) queueCapture(app, { accountId: p.accountId, itemId: item.id, url: item.url! });
  return items;
}
const captureOf = (app: App, itemId: string) => app.db.get<{ status: string; error: string | null; text: string | null }>("SELECT status, error, text FROM captures WHERE item_id = ?", itemId)!;

test("a captured page becomes the item's readable copy and the job keeps none of the text; a page the API can't read fails the copy", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const [read, unreadable] = itemsWithPages(app, p, 2);
  const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const jobs = leaseJobs(app, ["capture.fulltext"], 2);
  const jobFor = (itemId: string) => jobs.find((j) => (j.payload as { captureId: string }).captureId === app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", itemId)!.id)!;

  const ok = jobFor(read!.id);
  complete(app, ok, { ok: true, title: "T", text, html: `<p>${text}</p>`, finalUrl: read!.url!, bytes: text.length });
  assert.deepEqual({ ...captureOf(app, read!.id) }, { status: "done", error: null, text });
  assert.equal(jobRow(app, ok.id).result, '{"captured":true}');

  // What the worker sends is passed on whole; one the copy can't take settles the copy at once instead of being retried for nothing.
  const bad = jobFor(unreadable!.id);
  assert.equal(complete(app, bad, { ok: true }), true);
  assert.deepEqual([captureOf(app, unreadable!.id).status, captureOf(app, unreadable!.id).error], ["failed", copy.api.captures.pageCouldNotBeRead]);
  assert.equal(jobRow(app, bad.id).status, "done");
});

test("a capture that fails for good says so on the copy; one that will be retried stays pending", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const [retried, final, dying] = itemsWithPages(app, p, 3);
  const [a, b, c] = leaseJobs(app, ["capture.fulltext"], 3);
  const itemOf = (job: Leased) => app.db.get<{ item_id: string }>("SELECT item_id FROM captures WHERE id = ?", (job.payload as { captureId: string }).captureId)!.item_id;
  assert.deepEqual(new Set([a, b, c].map((j) => itemOf(j!))), new Set([retried!.id, final!.id, dying!.id]));

  fail(app, a!, { retryable: true, reason: "unavailable" });
  assert.equal(captureOf(app, itemOf(a!)).status, "pending");
  fail(app, b!, { retryable: false, reason: "other" });
  assert.deepEqual([captureOf(app, itemOf(b!)).status, captureOf(app, itemOf(b!)).error], ["failed", failures.pageNotCaptured]);
  dies(app, c!.id);
  expireLeases(app);
  assert.deepEqual([captureOf(app, itemOf(c!)).status, captureOf(app, itemOf(c!)).error], ["failed", failures.pageNotCaptured], "a worker that keeps dying on it");
});

// ---------- capture.images

const PNG = (extra: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);

test("pictures that come back are stored with their item and the job keeps only how many came", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Webcomic", "feed/1");
  const cover = "https://pictures.example/cover.png";
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { imageUrl: cover })]));
  const itemId = app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  const stored = () => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_images WHERE item_id = ?", itemId)!.n;
  const ask = () => enqueue(app, "capture.images", { itemId, urls: [cover], maxBytes: 5_000_000 }, { accountId: p.accountId });

  ask();
  const job = leaseOne(app, "capture.images");
  complete(app, job, { images: [{ url: cover, contentType: "image/png", data: PNG(100).toString("base64") }, { url: "https://pictures.example/unasked.png", contentType: "image/png", data: PNG(10).toString("base64") }] });
  assert.equal(stored(), 1, "only the address asked for is stored");
  assert.equal(jobRow(app, job.id).result, '{"pictures":2}', "the count is of what the worker delivered; the bytes are not kept on the job");

  ask();
  const nothing = leaseOne(app, "capture.images");
  assert.equal(complete(app, nothing, { images: "not a list" }), true);
  assert.equal(jobRow(app, nothing.id).result, '{"pictures":0}');
  assert.equal(stored(), 1);
});

// ---------- filter.judge

test("a Smart filter answer is checked, and the job keeps its count of verdicts and not the model or the answers", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  enqueue(app, "filter.judge", { itemIds: ["itm_none"], announce: false }, { accountId: p.accountId });
  const job = leaseOne(app, "filter.judge");
  for (const result of [undefined, {}, { route: "elsewhere", model: null, verdicts: [] }, { route: null, model: null, verdicts: [{ itemId: "x", answers: { f: 2 }, inputTokens: 1 }] }]) {
    assert.throws(() => complete(app, job, result), (e: unknown) => e instanceof HttpError && e.status === 400, JSON.stringify(result));
  }
  assert.equal(jobRow(app, job.id).status, "leased");

  assert.equal(complete(app, job, { route: "server", model: "jev-1", keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: [{ itemId: "itm_none", answers: { f1_x: 0.9 }, inputTokens: 12 }] }), true);
  assert.deepEqual(JSON.parse(jobRow(app, job.id).result!), { route: "server", keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: 1 });
});

test("an answer from a worker that doesn't send the newer fields is still taken", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  enqueue(app, "filter.judge", { itemIds: ["itm_none"], announce: false }, { accountId: p.accountId });
  const job = leaseOne(app, "filter.judge");
  assert.equal(complete(app, job, { route: "server", model: null, verdicts: [] }), true);
  assert.deepEqual(JSON.parse(jobRow(app, job.id).result!), { route: "server", verdicts: 0 });
});

/** Posts that arrived while nothing announced them, with a judging job asking about them. */
function judgingOf(app: App, p: Principal & { engineUserId: string }, announce: boolean) {
  const source = makeSource(app, p, "Delta Notes", "feed/1");
  const now = new Date().toISOString();
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { crawledAt: now, publishedAt: now })]));
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", source);
  const itemIds = app.db.all<{ id: string }>("SELECT id FROM items WHERE source_id = ?", source).map((r) => r.id);
  enqueue(app, "filter.judge", { itemIds, announce }, { accountId: p.accountId, maxAttempts: 2 });
  return source;
}
const announced = (app: App, accountId: string) => app.db.all<{ title: string }>("SELECT title FROM notifications WHERE account_id = ? AND kind = 'arrivals'", accountId).map((r) => r.title);

test("a Smart filter job that fails for good announces its posts as a sync would have; one that will be retried does not", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  judgingOf(app, p, true);
  const job = leaseOne(app, "filter.judge");
  fail(app, job, { retryable: true, reason: "rate_limited" });
  assert.deepEqual(announced(app, p.accountId), [], "it will be asked again");
  app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", addSeconds(-1), job.id);
  fail(app, leaseOne(app, "filter.judge"), { retryable: true, reason: "rate_limited" });
  assert.deepEqual(announced(app, p.accountId), [copy.api.notifications.newFrom("Delta Notes")], "out of attempts");
});

test("a re-check that fails for good announces nothing, and a worker that keeps dying on a Smart filter job announces the posts", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  judgingOf(app, p, false);
  fail(app, leaseOne(app, "filter.judge"), { retryable: false });
  assert.deepEqual(announced(app, p.accountId), []);

  app.db.run("DELETE FROM jobs WHERE kind = 'filter.judge'");
  const itemIds = app.db.all<{ id: string }>("SELECT id FROM items").map((r) => r.id);
  enqueue(app, "filter.judge", { itemIds, announce: true }, { accountId: p.accountId });
  dies(app, leaseOne(app, "filter.judge").id);
  expireLeases(app);
  assert.deepEqual(announced(app, p.accountId), [copy.api.notifications.newFrom("Delta Notes")]);
});

test("cancelling a queued Smart filter job announces its posts; a job that already failed was settled when it failed", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  judgingOf(app, p, true);
  const queued = app.db.get<{ id: string }>("SELECT id FROM jobs WHERE kind = 'filter.judge'")!.id;
  assert.equal(cancelJob(app, queued), true);
  assert.equal(jobRow(app, queued).status, "cancelled");
  assert.deepEqual(announced(app, p.accountId), [copy.api.notifications.newFrom("Delta Notes")]);
  assert.equal(cancelJob(app, queued), false, "nothing to cancel twice");
  assert.equal(announced(app, p.accountId).length, 1);

  app.db.run("DELETE FROM notifications");
  const itemIds = app.db.all<{ id: string }>("SELECT id FROM items").map((r) => r.id);
  const failedId = enqueue(app, "filter.judge", { itemIds, announce: true }, { accountId: p.accountId, maxAttempts: 1 });
  fail(app, leaseOne(app, "filter.judge"), { retryable: false });
  assert.equal(announced(app, p.accountId).length, 1, "announced by the failure");
  assert.equal(cancelJob(app, failedId), true);
  assert.equal(announced(app, p.accountId).length, 1, "and not again by the cancel");
});

// ---------- the queue around the kinds

test("a lease that is not the job's current one is lost: nothing is changed and the worker is told", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  const job = leaseOne(app, "engine.subscribe");
  assert.equal(completeLeasedJob(app, job.id, "lse_other", { streamId: "feed/9" }), false);
  assert.equal(failLeasedJob(app, job.id, "lse_other", { error: "x", retryable: false }), false);
  assert.equal(completeLeasedJob(app, "job_other", job.leaseId, { streamId: "feed/9" }), false);
  assert.equal(jobRow(app, job.id).status, "leased");
  assert.equal(getSource(app, owner, id).health, "pending");

  assert.equal(complete(app, job, { streamId: "feed/9" }), true);
  assert.equal(complete(app, job, { streamId: "feed/9" }), false, "a finished job has no lease");
  assert.equal(fail(app, job, { retryable: false }), false);
  assert.equal(jobRow(app, job.id).status, "done");
});

test("a job of a kind this version no longer has is still finished, failed and recovered, and settles nothing", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const now = new Date().toISOString();
  const retired = (id: string, lease: string) => app.db.run(
    "INSERT INTO jobs (id, account_id, kind, payload, status, lease_id, lease_expires_at, run_after, max_attempts, attempts, created_at, updated_at) VALUES (?, NULL, 'media.save', '{\"x\":1}', 'leased', ?, ?, ?, 1, 1, ?, ?)",
    id, lease, addSeconds(60), now, now, now);
  retired("job_a", "lse_a");
  retired("job_b", "lse_b");
  retired("job_c", "lse_c");

  assert.equal(completeLeasedJob(app, "job_a", "lse_a", { anything: [1] }), true);
  assert.deepEqual([jobRow(app, "job_a").status, jobRow(app, "job_a").result], ["done", '{"anything":[1]}']);
  assert.equal(failLeasedJob(app, "job_b", "lse_b", { error: "gone", retryable: false, reason: "other" }), true);
  assert.deepEqual([jobRow(app, "job_b").status, jobRow(app, "job_b").last_error], ["failed", "gone"]);
  dies(app, "job_c");
  assert.doesNotThrow(() => expireLeases(app));
  assert.equal(jobRow(app, "job_c").status, "failed");
});

test("a lease recovery pass settles every job that ran out of attempts and puts the others back, whatever their kinds", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const id = pendingSource(app, owner);
  syncJob(app, owner);
  enqueue(app, "engine.rename", { engineUserId: owner.engineUserId, streamId: "feed/1", title: "t" }, { accountId: owner.accountId });
  const [sub, sync, rename] = [leaseOne(app, "engine.subscribe"), leaseOne(app, "engine.sync"), leaseOne(app, "engine.rename")];
  dies(app, sub.id);
  dies(app, sync.id);
  app.db.run("UPDATE jobs SET attempts = 1, max_attempts = 6, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", rename.id);
  expireLeases(app);
  assert.deepEqual([sub, sync, rename].map((j) => jobRow(app, j.id).status), ["failed", "failed", "queued"]);
  assert.equal(getSource(app, owner, id).healthText, subscribeGaveUpText(undefined));
  assert.equal(checkpoint(app, owner.engineUserId)!.consecutive_failures, 1);
});
