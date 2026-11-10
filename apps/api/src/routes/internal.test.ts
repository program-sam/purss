import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { internalServer } from "../server.ts";
import { internalRouter } from "./internal.ts";
import { publicRouter } from "./public.ts";
import { extraRouters } from "./index.ts";
import { tick } from "../main.ts";
import { enqueue, leaseJobs } from "../services/jobs.ts";
import { recordSyncSuccess } from "../services/sync.ts";
import { getSource, NO_POSTS_YET, retrySource } from "../services/sources.ts";
import { SUBSCRIBE_RETRY_BACKOFF_SECONDS, subscribeGaveUpText, syncDelaySeconds, syncFailureText } from "../services/failures.ts";
import { addSeconds } from "../http.ts";
import { quickAddFailure } from "@purss/freshrss";

async function boot() {
  const { app, cleanup } = makeTestApp();
  const server = internalServer(app, internalRouter(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${app.serviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const owner = makeOwner(app);
  const pub = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const close = async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); await pub.close(); cleanup(); };
  return { app, owner, post, session, pubBase: pub.base, close };
}

/** Lease the job just enqueued, as the worker would. */
function leaseOne(app: App, kind: Parameters<typeof leaseJobs>[1][number]) {
  const job = leaseJobs(app, [kind], 1)[0];
  assert.ok(job, `a ${kind} job is waiting`);
  return job;
}

const syncJob = (app: App, owner: { accountId: string; workspaceId: string; engineUserId: string }) =>
  enqueue(app, "engine.sync", { engineUserId: owner.engineUserId }, { accountId: owner.accountId, workspaceId: owner.workspaceId, idempotencyKey: `sync:${owner.engineUserId}` });

const checkpoint = (app: App, engineUserId: string) =>
  app.db.get<{ last_error: string | null; last_attempt_at: string | null; consecutive_failures: number }>("SELECT last_error, last_attempt_at, consecutive_failures FROM sync_checkpoints WHERE engine_user_id = ?", engineUserId);

test("the batch route takes a page of Arabic text over 1 MB, and still has a limit", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");
  syncJob(b.app, b.owner);
  const job = leaseOne(b.app, "engine.sync");
  // 12 entries of 60 000 Arabic letters: 720 000 UTF-16 units, but 1.44 MB on the wire.
  const entries = Array.from({ length: 12 }, (_, i) => entry("feed/1", { title: `مقال ${i}`, contentHtml: `<p>${"ع".repeat(60_000)}</p>` }));
  const body = { ...batch(entries), leaseId: job.leaseId };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 1_400_000);
  const res = await b.post(`/internal/sync/${b.owner.engineUserId}/batch`, body);
  assert.equal(res.status, 200, "a 413 here is what stopped an account's sync for good");
  assert.equal(((await res.json()) as { accepted: number }).accepted, 12);

  const huge = await b.post(`/internal/sync/${b.owner.engineUserId}/batch`, { leaseId: job.leaseId, padding: "x".repeat(9 * 1024 * 1024) });
  assert.equal(huge.status, 413, "the batch limit is explicit, not unlimited");
  const other = await b.post("/internal/jobs/lease", { kinds: ["engine.sync"], max: 1, padding: "x".repeat(1_100_000) });
  assert.equal(other.status, 413, "other internal routes keep the default limit");
});

test("a sync that fails for good tells the person why on Home and waits longer each time", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");
  const fail = async (reason: string, retryable: boolean) => {
    syncJob(b.app, b.owner);
    const job = leaseOne(b.app, "engine.sync");
    const res = await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "The product API refused a request as too large (413).", retryable, reason });
    assert.equal(res.status, 200);
  };
  assert.equal(checkpoint(b.app, b.owner.engineUserId), undefined, "a brand-new account has no checkpoint row yet");

  await fail("too_large", false);
  const first = checkpoint(b.app, b.owner.engineUserId)!;
  assert.equal(first.last_error, syncFailureText("too_large"), "the checkpoint holds words for a person, not the technical error");
  assert.ok(!first.last_error!.includes("413"));
  assert.equal(first.consecutive_failures, 1);
  assert.ok(first.last_attempt_at, "the attempt is recorded even though no checkpoint existed (this is what let the maintenance tick re-queue it every 15 seconds)");

  const home = await call(b.app, b.pubBase, "GET", "/api/bootstrap", b.session);
  assert.equal(home.status, 200);
  assert.equal(home.json.engine.status, "unavailable");
  assert.match(home.json.engine.message, /too large to save/, "Home's engine notice carries the reason");

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
    const job = leaseOne(b.app, "engine.sync");
    await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "boom", retryable: false, reason: "other" });
    const failures = checkpoint(b.app, b.owner.engineUserId)!.consecutive_failures;
    ago(wait - 5);
    tick(b.app);
    assert.equal(queuedSync(), undefined, `after ${failures} failures it waits ${wait / 60} minutes`);
    ago(wait + 5);
    tick(b.app);
    assert.ok(queuedSync());
  }
  const job = leaseOne(b.app, "engine.sync");
  await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "boom", retryable: false });
  ago(3600 - 5);
  tick(b.app);
  assert.equal(queuedSync(), undefined, "an hour is the longest wait");
  assert.match(checkpoint(b.app, b.owner.engineUserId)!.last_error!, /couldn't work out/, "an unclassified failure still has words");

  recordSyncSuccess(b.app, b.owner.engineUserId);
  const after = checkpoint(b.app, b.owner.engineUserId)!;
  assert.deepEqual([after.last_error, after.consecutive_failures], [null, 0], "a success clears the notice and the count");
});

test("a failure that will be retried shows its reason but doesn't count as a final failure", async (t) => {
  const b = await boot();
  t.after(b.close);
  syncJob(b.app, b.owner);
  const job = leaseOne(b.app, "engine.sync");
  await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "The engine could not be reached.", retryable: true, reason: "unavailable" });
  const cp = checkpoint(b.app, b.owner.engineUserId)!;
  assert.equal(cp.last_error, syncFailureText("unavailable"));
  assert.equal(cp.consecutive_failures, 0);
  assert.equal(b.app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", job.id)!.status, "queued");
});

test("the wait after consecutive sync failures is 1, 5, 15 then 60 minutes, never shorter than the interval", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => syncDelaySeconds(30, n)), [30, 60, 300, 900, 3600, 3600, 3600]);
  assert.equal(syncDelaySeconds(120, 1), 120);
});

/** A source whose subscribe job is waiting, as just after Follow. */
function pendingSource(app: App, owner: Principal & { engineUserId: string }, stream = "feed/9") {
  const id = makeSource(app, owner, "Reddit: r/x", stream);
  app.db.run("UPDATE sources SET engine_stream_id = NULL, health = 'pending', health_text = 'Collecting the first items…' WHERE id = ?", id);
  enqueue(app, "engine.subscribe", { engineUserId: owner.engineUserId, sourceId: id, feedUrl: "https://www.reddit.com/r/x/.rss", title: "Reddit: r/x" }, { accountId: owner.accountId, workspaceId: owner.workspaceId, idempotencyKey: `subscribe:${id}` });
  return id;
}

test("a site that limits requests is retried after 1, 5 and 30 minutes, says so, then gives up with a retry that works", async (t) => {
  const b = await boot();
  t.after(b.close);
  const id = pendingSource(b.app, b.owner);
  const row = (jobId: string) => b.app.db.get<{ status: string; run_after: string; attempts: number }>("SELECT status, run_after, attempts FROM jobs WHERE id = ?", jobId)!;
  const limited = async (jobId: string, leaseId: string) => (await b.post(`/internal/jobs/${jobId}/fail`, { leaseId, error: "The feed's server is limiting requests (HTTP 429); this will be retried with a delay.", retryable: true, reason: "rate_limited" })).status;

  for (const wait of SUBSCRIBE_RETRY_BACKOFF_SECONDS) {
    const job = leaseOne(b.app, "engine.subscribe");
    const before = Date.now();
    assert.equal(await limited(job.id, job.leaseId), 200);
    const next = row(job.id);
    assert.equal(next.status, "queued");
    assert.ok(Math.abs(Date.parse(next.run_after) - (before + wait * 1000)) < 5000, `waits ${wait} s before the retry`);
    assert.deepEqual([getSource(b.app, b.owner, id).health, getSource(b.app, b.owner, id).healthText], ["error", "The site is limiting requests; we'll keep trying."]);
    b.app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), job.id); // the wait passes
  }
  const last = leaseOne(b.app, "engine.subscribe");
  assert.equal(await limited(last.id, last.leaseId), 200);
  assert.equal(row(last.id).status, "failed", "after the third retry it stops");
  const gaveUp = getSource(b.app, b.owner, id);
  assert.deepEqual([gaveUp.health, gaveUp.healthText], ["error", subscribeGaveUpText("rate_limited")]);

  // The person can try again; the retry runs at once and starts the schedule over.
  assert.equal(retrySource(b.app, b.owner, id).health, "pending");
  const again = leaseOne(b.app, "engine.subscribe");
  assert.equal(again.id, last.id);
  assert.equal(again.attempts, 1);
  await b.post(`/internal/jobs/${again.id}/complete`, { leaseId: again.leaseId, result: { streamId: "feed/9" } });
  const now = getSource(b.app, b.owner, id);
  assert.equal(now.health, "pending", "following now; the first items are on the way");
  assert.equal(b.app.db.get<{ engine_stream_id: string }>("SELECT engine_stream_id FROM sources WHERE id = ?", id)!.engine_stream_id, "feed/9");
});

test("a retry brings a waiting retry forward, and only failed sources can be retried", async (t) => {
  const b = await boot();
  t.after(b.close);
  const id = pendingSource(b.app, b.owner);
  assert.throws(() => retrySource(b.app, b.owner, id), (e: unknown) => (e as { code?: string }).code === "not_failed", "still collecting: nothing to retry");
  const job = leaseOne(b.app, "engine.subscribe");
  await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "limited", retryable: true, reason: "rate_limited" });
  assert.ok(Date.parse(b.app.db.get<{ run_after: string }>("SELECT run_after FROM jobs WHERE id = ?", job.id)!.run_after) > Date.now() + 30_000);
  retrySource(b.app, b.owner, id);
  assert.ok(Date.parse(b.app.db.get<{ run_after: string }>("SELECT run_after FROM jobs WHERE id = ?", job.id)!.run_after) <= Date.now(), "no need to wait out the minute");

  const other = makeOwner(b.app, { admin: false });
  assert.throws(() => retrySource(b.app, other, id), (e: unknown) => (e as { status?: number }).status === 404, "another account's source");
  const working = makeSource(b.app, b.owner, "Working", "feed/3");
  assert.throws(() => retrySource(b.app, b.owner, working), (e: unknown) => (e as { code?: string }).code === "not_failed");
});

test("the source says what went wrong when the engine can't follow it for good", async (t) => {
  const b = await boot();
  t.after(b.close);
  const cases: Array<[string, boolean, RegExp]> = [
    ["not_found", false, /no feed at that address/],
    ["refused", false, /refused/],
    ["too_large", false, /too large to follow/],
    ["not_a_feed", false, /not with a feed we can read/],
    ["unavailable", true, /didn't answer/],
    ["other", false, /couldn't follow this feed/],
  ];
  for (const [reason, retryable, text] of cases) {
    const id = pendingSource(b.app, b.owner);
    // A retryable failure with the default schedule gets its six attempts first.
    b.app.db.run("UPDATE jobs SET max_attempts = 1 WHERE idempotency_key = ?", `subscribe:${id}`);
    const job = leaseOne(b.app, "engine.subscribe");
    await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: "x", retryable, reason });
    const s = getSource(b.app, b.owner, id);
    assert.equal(s.health, "error", reason);
    assert.match(s.healthText!, text, reason);
  }
});

test("a site that answers 503 at follow time is retried after 1, 5 and 30 minutes, and the source says so in plain words", async (t) => {
  const b = await boot();
  t.after(b.close);
  // What the engine really says, classified the way the worker classifies it.
  const failure = quickAddFailure("HTTP 503 Service Unavailable!", "https://example.org/feed.xml");
  assert.deepEqual([failure.reason, failure.retryable], ["unavailable", true]);
  const id = pendingSource(b.app, b.owner);
  const row = (jobId: string) => b.app.db.get<{ status: string; run_after: string }>("SELECT status, run_after FROM jobs WHERE id = ?", jobId)!;
  for (const wait of SUBSCRIBE_RETRY_BACKOFF_SECONDS) {
    const job = leaseOne(b.app, "engine.subscribe");
    const before = Date.now();
    assert.equal((await b.post(`/internal/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: failure.message, retryable: failure.retryable, reason: failure.reason })).status, 200);
    assert.equal(row(job.id).status, "queued");
    assert.ok(Math.abs(Date.parse(row(job.id).run_after) - (before + wait * 1000)) < 5000, `waits ${wait} s, not seconds`);
    const s = getSource(b.app, b.owner, id);
    assert.deepEqual([s.health, s.healthText], ["error", "The site isn't answering right now; we'll keep trying."]);
    b.app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), job.id); // the wait passes
  }
  const last = leaseOne(b.app, "engine.subscribe");
  await b.post(`/internal/jobs/${last.id}/fail`, { leaseId: last.leaseId, error: failure.message, retryable: true, reason: "unavailable" });
  assert.equal(row(last.id).status, "failed", "after the third retry it stops");
  assert.equal(getSource(b.app, b.owner, id).healthText, subscribeGaveUpText("unavailable"));
});

test("a sync that uses up its attempts through expired leases shows an error and waits, instead of being queued again at once", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");
  const queued = () => b.app.db.get("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'queued'", `sync:${b.owner.engineUserId}`);
  const dies = () => {
    syncJob(b.app, b.owner);
    const job = leaseOne(b.app, "engine.sync");
    // The worker crashed on every attempt: the last lease has run out and nothing was ever reported.
    b.app.db.run("UPDATE jobs SET attempts = max_attempts, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", job.id);
    tick(b.app);
    assert.equal(b.app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", job.id)!.status, "failed");
  };
  assert.equal(checkpoint(b.app, b.owner.engineUserId), undefined);
  dies();
  const first = checkpoint(b.app, b.owner.engineUserId)!;
  assert.equal(first.last_error, syncFailureText(undefined), "a plain-language error, though no failure was ever reported");
  assert.equal(first.consecutive_failures, 1);
  assert.ok(first.last_attempt_at);
  assert.equal(queued(), undefined, "the maintenance tick that found it did not queue it again at once");
  const home = await call(b.app, b.pubBase, "GET", "/api/bootstrap", b.session);
  assert.equal(home.json.engine.status, "unavailable");
  assert.match(home.json.engine.message, /problem we couldn't work out/);

  // Each further failure waits longer: 5 minutes after the second.
  b.app.db.run("UPDATE sync_checkpoints SET last_attempt_at = ? WHERE engine_user_id = ?", addSeconds(-(b.app.config.syncIntervalSeconds + 10)), b.owner.engineUserId);
  tick(b.app);
  assert.ok(queued(), "due again after the first wait");
  const job = leaseOne(b.app, "engine.sync");
  b.app.db.run("UPDATE jobs SET attempts = max_attempts, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", job.id);
  tick(b.app);
  assert.equal(checkpoint(b.app, b.owner.engineUserId)!.consecutive_failures, 2);
  b.app.db.run("UPDATE sync_checkpoints SET last_attempt_at = ? WHERE engine_user_id = ?", addSeconds(-290), b.owner.engineUserId);
  tick(b.app);
  assert.equal(queued(), undefined, "five minutes after the second failure");
});

test("a source whose subscribe keeps losing its lease says it could not be followed, instead of collecting for ever", async (t) => {
  const b = await boot();
  t.after(b.close);
  const id = pendingSource(b.app, b.owner);
  const job = leaseOne(b.app, "engine.subscribe");
  b.app.db.run("UPDATE jobs SET attempts = max_attempts, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", job.id);
  tick(b.app);
  const s = getSource(b.app, b.owner, id);
  assert.deepEqual([s.health, s.healthText], ["error", subscribeGaveUpText(undefined)]);
});

test("the engine's word that a fresh subscription's feed is empty reaches the source; a job that does not say it changes nothing", async (t) => {
  const b = await boot();
  t.after(b.close);
  const empty = pendingSource(b.app, b.owner);
  const first = leaseOne(b.app, "engine.subscribe");
  assert.equal((await b.post(`/internal/jobs/${first.id}/complete`, { leaseId: first.leaseId, result: { streamId: "feed/9", title: "Reddit: r/x", alreadySubscribed: false, empty: true } })).status, 200);
  assert.deepEqual([getSource(b.app, b.owner, empty).health, getSource(b.app, b.owner, empty).healthText], ["quiet", NO_POSTS_YET]);

  const other = pendingSource(b.app, b.owner, "feed/11");
  const second = leaseOne(b.app, "engine.subscribe");
  assert.equal((await b.post(`/internal/jobs/${second.id}/complete`, { leaseId: second.leaseId, result: { streamId: "feed/10", title: "x", alreadySubscribed: false } })).status, 200);
  assert.equal(getSource(b.app, b.owner, other).health, "pending");
  assert.equal(getSource(b.app, b.owner, other).healthText, "Collecting the first items…");
});

test("a worker from another version asking for a kind this API doesn't have still gets its other jobs", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Feed", "feed/1");
  syncJob(b.app, b.owner);
  const retired = await b.post("/internal/jobs/lease", { kinds: ["media.save"], max: 1 });
  assert.equal(retired.status, 200);
  assert.deepEqual(((await retired.json()) as { jobs: unknown[] }).jobs, []);
  const mixed = await b.post("/internal/jobs/lease", { kinds: ["media.save", "engine.sync"], max: 1 });
  assert.equal(mixed.status, 200);
  assert.equal(((await mixed.json()) as { jobs: { kind: string }[] }).jobs[0]?.kind, "engine.sync");
});
