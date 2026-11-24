import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { internalServer } from "../server.ts";
import { internalRouter } from "./internal.ts";
import { enqueue, leaseJobs } from "../services/jobs.ts";
import { getSource } from "../services/sources.ts";
import { syncFailureText } from "../services/failures.ts";

async function boot() {
  const { app, cleanup } = makeTestApp();
  const server = internalServer(app, internalRouter(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${app.serviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const owner = makeOwner(app);
  const close = async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); cleanup(); };
  return { app, owner, post, close };
}

/** Lease the job just enqueued, as the worker would. */
function leaseOne(app: App, kind: Parameters<typeof leaseJobs>[1][number]) {
  const job = leaseJobs(app, [kind], 1)[0];
  assert.ok(job, `a ${kind} job is waiting`);
  return job;
}

const syncJob = (app: App, owner: { accountId: string; engineUserId: string }) =>
  enqueue(app, "engine.sync", { engineUserId: owner.engineUserId }, { accountId: owner.accountId, idempotencyKey: `sync:${owner.engineUserId}` });

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

test("the job routes hand out leases and take back reports; what a report means is the job kind's (services/jobs.test.ts)", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Arabic", "feed/1");

  // Failed: the report reaches the kind's rules, and the answer carries nothing else.
  syncJob(b.app, b.owner);
  const leased = (await (await b.post("/internal/jobs/lease", { kinds: ["engine.sync"], max: 1 })).json()) as { jobs: { id: string; leaseId: string }[] };
  const failing = leased.jobs[0]!;
  const reported = await b.post(`/internal/jobs/${failing.id}/fail`, { leaseId: failing.leaseId, error: "The product API refused a request as too large (413).", retryable: false, reason: "too_large" });
  assert.equal(reported.status, 200);
  assert.deepEqual(await reported.json(), { ok: true });
  assert.equal(b.app.db.get<{ last_error: string }>("SELECT last_error FROM sync_checkpoints WHERE engine_user_id = ?", b.owner.engineUserId)!.last_error, syncFailureText("too_large"));
  assert.equal((await b.post(`/internal/jobs/${failing.id}/fail`, { leaseId: failing.leaseId, error: "again", retryable: false })).status, 409, "a lease that has ended answers lease_lost");

  // Completed: the result reaches the kind's rules; a malformed one is refused and leaves the job leased; a wrong lease is lost.
  const id = makeSource(b.app, b.owner, "Reddit: r/x", "feed/9");
  b.app.db.run("UPDATE sources SET engine_stream_id = NULL, health = 'pending' WHERE id = ?", id);
  enqueue(b.app, "engine.subscribe", { engineUserId: b.owner.engineUserId, sourceId: id, feedUrl: "https://www.reddit.com/r/x/.rss", title: "Reddit: r/x" }, { accountId: b.owner.accountId });
  const subscribe = leaseOne(b.app, "engine.subscribe");
  assert.equal((await b.post(`/internal/jobs/${subscribe.id}/complete`, { leaseId: subscribe.leaseId, result: {} })).status, 400);
  assert.equal((await b.post(`/internal/jobs/${subscribe.id}/complete`, { leaseId: "lse_other", result: { streamId: "feed/9" } })).status, 409);
  assert.equal((await b.post(`/internal/jobs/${subscribe.id}/complete`, { leaseId: subscribe.leaseId, result: { streamId: "feed/9" } })).status, 200);
  assert.equal(getSource(b.app, b.owner, id).health, "pending");
  assert.equal(b.app.db.get<{ engine_stream_id: string }>("SELECT engine_stream_id FROM sources WHERE id = ?", id)!.engine_stream_id, "feed/9");
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
