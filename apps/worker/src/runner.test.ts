import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@purss/freshrss";
import { InternalApi, InternalApiError } from "./internal-api.ts";
import { createLogger } from "./log.ts";
import { Backoff, JobFailure, KeyedLock, Worker, classify } from "./runner.ts";
import type { Handlers } from "./runner.ts";
import { FakeInternalApi } from "./testing/fake-internal-api.ts";

const quiet = createLogger(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await wait(10);
  }
}

async function harness(opts: { handlers: Handlers; concurrency?: number; drainTimeoutMs?: number; leaseSeconds?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; pollIntervalMs?: number }) {
  const fake = new FakeInternalApi();
  if (opts.leaseSeconds) fake.leaseSeconds = opts.leaseSeconds;
  const srv = await fake.listen();
  const api = new InternalApi({ baseUrl: srv.url, token: { get: () => fake.token, invalidate() {} }, retryDelaysMs: [10, 10] });
  const worker = new Worker({
    api,
    handlers: opts.handlers,
    log: quiet,
    concurrency: opts.concurrency ?? 2,
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    maxBackoffMs: 200,
    drainTimeoutMs: opts.drainTimeoutMs ?? 2000,
    sleep: opts.sleep,
  });
  const loop = worker.run();
  return {
    fake,
    worker,
    async stop() {
      await worker.drain();
      await loop;
      await srv.close();
    },
  };
}

const mark = (id = "eu1") => ({ engineUserId: id, externalIds: ["1"], read: true });

test("leases a job, validates its payload, runs the handler and reports completion with the result", async () => {
  let seen: unknown;
  const h = await harness({ handlers: { "engine.mark_read": async ({ payload }) => { seen = payload; return { count: 1 }; } } });
  const id = h.fake.enqueue("engine.mark_read", mark());
  await until(() => h.fake.calls.complete.length === 1);
  assert.deepEqual(seen, mark());
  assert.deepEqual(h.fake.calls.complete[0], { id, result: { count: 1 } });
  assert.equal(h.fake.calls.fail.length, 0);
  await h.stop();
});

test("concurrency is bounded: never more jobs in flight than configured, and all jobs finish", async () => {
  let running = 0;
  let peak = 0;
  const h = await harness({
    concurrency: 2,
    handlers: { "engine.mark_read": async () => { running++; peak = Math.max(peak, running); await wait(60); running--; return {}; } },
  });
  for (let i = 0; i < 6; i++) h.fake.enqueue("engine.mark_read", mark(`eu${i}`));
  await until(() => h.fake.calls.complete.length === 6);
  assert.equal(peak, 2);
  await h.stop();
});

test("long jobs are heartbeated until they finish", async () => {
  const h = await harness({ leaseSeconds: 1, handlers: { "engine.mark_read": async () => { await wait(1400); return {}; } } });
  const id = h.fake.enqueue("engine.mark_read", mark());
  await until(() => h.fake.calls.complete.length === 1, 6000);
  assert.ok(h.fake.calls.heartbeat.filter((x) => x === id).length >= 2, `heartbeats: ${h.fake.calls.heartbeat.length}`);
  await h.stop();
});

test("when the lease is lost the handler is aborted and neither completion nor failure is reported", async () => {
  let aborted = false;
  const h = await harness({
    leaseSeconds: 1,
    handlers: {
      "engine.mark_read": async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        return { shouldNotBeReported: true };
      },
    },
  });
  const id = h.fake.enqueue("engine.mark_read", mark());
  h.fake.loseLeaseOnHeartbeat.add(id);
  await until(() => aborted, 5000);
  await wait(100);
  assert.equal(h.fake.calls.complete.length, 0);
  assert.equal(h.fake.calls.fail.length, 0);
  await h.stop();
});

test("failures are reported with the right retry decision and without secrets", async () => {
  const h = await harness({
    handlers: {
      "engine.unsubscribe": async () => { throw new JobFailure("gone for good password=hunter2hunter2 https://user:pw@example.org/x?token=abc", false); },
      "engine.rename": async () => { throw new EngineError("network", "The engine could not be reached."); },
      "engine.sync": async () => { throw new Error("TypeError: secret stack token=abcdefabcdefabcdefabcdefabcdefabcdef"); },
    },
  });
  h.fake.enqueue("engine.unsubscribe", { engineUserId: "eu1", streamId: "feed/1" });
  h.fake.enqueue("engine.rename", { engineUserId: "eu1", streamId: "feed/1", title: "t" });
  h.fake.enqueue("engine.sync", { engineUserId: "eu1" });
  await until(() => h.fake.calls.fail.length === 3);
  const by = new Map(h.fake.calls.fail.map((f) => [f.error.slice(0, 12), f]));
  const unsub = h.fake.calls.fail.find((f) => f.error.startsWith("gone for good"))!;
  assert.equal(unsub.retryable, false);
  assert.ok(!unsub.error.includes("hunter2") && !unsub.error.includes("user:pw") && !unsub.error.includes("token=abc"), unsub.error);
  const net = h.fake.calls.fail.find((f) => f.error.includes("could not be reached"))!;
  assert.equal(net.retryable, true);
  const unexpected = h.fake.calls.fail.find((f) => f.error.includes("unexpected error"))!;
  assert.equal(unexpected.retryable, true);
  assert.ok(!unexpected.error.includes("abcdef"));
  void by;
  await h.stop();
});

test("a job kind without a handler or with a payload that breaks its contract fails permanently", async () => {
  const h = await harness({ handlers: { "engine.mark_read": async () => ({}) }, });
  // the harness leases only kinds it has handlers for, so lease a job of an unknown kind through a worker that claims it
  await h.stop();
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  const api = new InternalApi({ baseUrl: srv.url, token: { get: () => fake.token, invalidate() {} } });
  const worker = new Worker({ api, handlers: { "engine.mark_read": async () => ({}) }, kinds: ["engine.mark_read", "engine.sync"], log: quiet, concurrency: 2, pollIntervalMs: 20, maxBackoffMs: 100, drainTimeoutMs: 500 });
  const loop = worker.run();
  fake.enqueue("engine.sync", { engineUserId: "eu1" }); // leased but has no handler
  fake.enqueue("engine.mark_read", { nonsense: true }); // payload violates the contract
  await until(() => fake.calls.fail.length === 2);
  assert.ok(fake.calls.fail.every((f) => f.retryable === false));
  await worker.drain();
  await loop;
  await srv.close();
});

test("lease errors back off exponentially with jitter, capped, and recover", async () => {
  const delays: number[] = [];
  const fake = new FakeInternalApi();
  fake.failLease = { status: 503, remaining: 4 };
  const srv = await fake.listen();
  const api = new InternalApi({ baseUrl: srv.url, token: { get: () => fake.token, invalidate() {} }, retryDelaysMs: [] });
  const worker = new Worker({
    api,
    handlers: { "engine.mark_read": async () => ({}) },
    log: quiet,
    concurrency: 1,
    pollIntervalMs: 10,
    maxBackoffMs: 80,
    drainTimeoutMs: 500,
    random: () => 1,
    sleep: async (ms) => { delays.push(ms); await wait(1); },
  });
  const loop = worker.run();
  await until(() => fake.calls.lease >= 6);
  await worker.drain();
  await loop;
  await srv.close();
  const errorDelays = delays.slice(0, 4);
  assert.deepEqual(errorDelays, [10, 20, 40, 80], "doubles each time and stops at the cap");
  assert.ok(delays.slice(4, -1).every((d) => d === 10), "back to the poll interval after a successful lease (the last entry is the drain budget)");
});

test("Backoff: failures grow the ceiling, jitter stays within it, reset restores the base", () => {
  const b = new Backoff(100, 1000, () => 0.5);
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next()], [100, 100, 200, 400, 500]);
  b.reset();
  assert.equal(b.failures, 0);
  assert.equal(new Backoff(100, 1000, () => 0).next(), 100, "never below the base");
});

test("drain lets a running job finish, reports it, and leases nothing further", async () => {
  const h = await harness({ concurrency: 1, handlers: { "engine.mark_read": async () => { await wait(300); return { done: true }; } } });
  h.fake.enqueue("engine.mark_read", mark("eu1"));
  await until(() => h.fake.leased.size === 1);
  h.fake.enqueue("engine.mark_read", mark("eu2")); // queued behind it; must not be leased after drain starts
  const leasesBefore = h.fake.calls.lease;
  await h.worker.drain();
  assert.equal(h.fake.calls.complete.length, 1);
  assert.deepEqual(h.fake.calls.complete[0]!.result, { done: true });
  assert.equal(h.fake.queued.length, 1, "the second job stays queued for the next worker");
  assert.ok(h.fake.calls.lease - leasesBefore <= 1);
  await h.stop();
});

test("when the drain budget runs out the job is interrupted and released as retryable", async () => {
  let sawAbort = false;
  const h = await harness({
    drainTimeoutMs: 150,
    handlers: {
      "engine.sync": async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true }));
        throw new Error("interrupted");
      },
    },
  });
  h.fake.enqueue("engine.sync", { engineUserId: "eu1" });
  await until(() => h.fake.leased.size === 1);
  const started = Date.now();
  await h.worker.drain();
  assert.ok(Date.now() - started >= 140);
  assert.equal(sawAbort, true);
  assert.equal(h.fake.calls.fail.length, 1);
  assert.equal(h.fake.calls.fail[0]!.retryable, true);
  assert.match(h.fake.calls.fail[0]!.error, /stopped before this job finished/);
  assert.equal(h.fake.calls.complete.length, 0);
  await h.stop();
});

test("KeyedLock runs one task per key at a time and different keys in parallel", async () => {
  const lock = new KeyedLock();
  const order: string[] = [];
  const task = (name: string, ms: number) => async () => { order.push(`${name}:start`); await wait(ms); order.push(`${name}:end`); };
  await Promise.all([lock.run("a", task("a1", 50)), lock.run("a", task("a2", 10)), lock.run("b", task("b1", 10))]);
  assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"));
  assert.ok(order.indexOf("b1:start") < order.indexOf("a1:end"));
  await assert.rejects(lock.run("a", async () => { throw new Error("x"); }));
  await lock.run("a", async () => order.push("after-failure"));
  assert.equal(order.at(-1), "after-failure");
});

test("classify: engine and API errors map to stored messages and retry flags", () => {
  assert.deepEqual(classify(new EngineError("auth", "The engine rejected the account's API credentials.")).retryable, false);
  assert.equal(classify(new EngineError("timeout", "slow")).retryable, true);
  assert.equal(classify(new JobFailure("nope", false)).retryable, false);
  assert.equal(classify(new TypeError("bug")).retryable, true);
});

test("classify gives every failure a reason the product can put into words", () => {
  const reason = (e: unknown) => classify(e).reason;
  assert.equal(reason(new EngineError("rate_limited", "x")), "rate_limited");
  for (const kind of ["unavailable", "api_disabled", "network", "timeout", "exec"] as const) assert.equal(reason(new EngineError(kind, "x")), "unavailable", kind);
  assert.equal(reason(new EngineError("rejected", "x", { reason: "not_found" })), "not_found", "a reason the engine boundary found wins over the kind");
  assert.equal(reason(new EngineError("auth", "x")), "other");
  assert.equal(reason(new JobFailure("x", false, "too_large")), "too_large");
  assert.equal(reason(new JobFailure("x", false)), "other");
  const tooLarge = classify(new InternalApiError("protocol", "The product API answered with an unexpected status (413).", 413));
  assert.deepEqual([tooLarge.reason, tooLarge.retryable], ["too_large", false], "the 413 that used to end an account's sync is named");
  assert.equal(reason(new TypeError("bug")), "other");
});

test("the reason is passed to the API with the failure", async () => {
  const h = await harness({ handlers: { "engine.rename": async () => { throw new EngineError("rejected", "There is no feed at that address (HTTP 404).", { reason: "not_found" }); } } });
  h.fake.enqueue("engine.rename", { engineUserId: "eu1", streamId: "feed/1", title: "t" });
  await until(() => h.fake.calls.fail.length === 1);
  assert.equal(h.fake.calls.fail[0]!.reason, "not_found");
  assert.equal(h.fake.calls.fail[0]!.retryable, false);
  await h.stop();
});
