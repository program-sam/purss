import assert from "node:assert/strict";
import test from "node:test";
import { fileTokenProvider } from "./config.ts";
import { InternalApi, InternalApiError } from "./internal-api.ts";
import { FakeInternalApi } from "./testing/fake-internal-api.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("sends the service token as a bearer credential and re-reads it once after a 401", async () => {
  const fake = new FakeInternalApi("rotated-token");
  const srv = await fake.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "purss-token-"));
  try {
    const file = path.join(dir, "service-token");
    writeFileSync(file, "stale-token\n");
    const token = fileTokenProvider(file);
    assert.equal(token.get(), "stale-token"); // cached
    writeFileSync(file, "rotated-token\n"); // the API rotated the token meanwhile
    const api = new InternalApi({ baseUrl: srv.url, token, retryDelaysMs: [] });
    assert.deepEqual(await api.lease(["engine.sync"], 1), []);
    assert.equal(fake.calls.unauthorized, 1, "one rejected attempt with the cached token, then success after re-reading the file");

    fake.calls.unauthorized = 0;
    const bad = new InternalApi({ baseUrl: srv.url, token: { get: () => "wrong-token", invalidate() {} }, retryDelaysMs: [] });
    await assert.rejects(bad.lease(["engine.sync"], 1), (e: unknown) => e instanceof InternalApiError && e.kind === "auth" && !e.message.includes("wrong-token"));
    assert.equal(fake.calls.unauthorized, 2, "a rejected token is retried exactly once");
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing token file is reported plainly", () => {
  const p = fileTokenProvider("/nonexistent/purss/service-token");
  assert.throws(() => p.get(), /service token file is missing/);
});

test("responses map to lease-lost, not-found, bad-request and transient errors", async () => {
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  try {
    const api = new InternalApi({ baseUrl: srv.url, token: { get: () => fake.token, invalidate() {} }, retryDelaysMs: [] });
    await assert.rejects(api.heartbeat("job_unknown", "lse_x"), (e: unknown) => e instanceof InternalApiError && e.kind === "lease_lost");
    await assert.rejects(api.complete("job_unknown", "lse_x", {}), (e: unknown) => e instanceof InternalApiError && e.kind === "lease_lost");
    await assert.rejects(api.engineUser("nobody"), (e: unknown) => e instanceof InternalApiError && e.kind === "not_found");
    fake.failLease = { status: 503, remaining: 1 };
    await assert.rejects(api.lease(["engine.sync"], 1), (e: unknown) => e instanceof InternalApiError && e.kind === "transient" && e.retryable);
    await assert.rejects(
      api.submitBatch("eu1", { leaseId: "x", idempotencyKey: "short", engineIdentity: "i", entries: [], checkpoint: { continuation: null, newestCrawlUsec: null }, done: true }),
      (e: unknown) => e instanceof InternalApiError && e.kind === "bad_request" && !e.retryable,
    );
  } finally { await srv.close(); }
});

test("idempotent calls retry transient failures; the lease call itself does not", async () => {
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  try {
    fake.engineUsers.set("eu1", { id: "eu1", username: "u", baseUrl: "http://x" });
    const api = new InternalApi({ baseUrl: srv.url, token: { get: () => fake.token, invalidate() {} }, retryDelaysMs: [5, 5] });
    let hits = 0;
    const origFail = fake.failLease;
    void origFail;
    const flaky = new InternalApi({
      baseUrl: srv.url,
      token: { get: () => fake.token, invalidate() {} },
      retryDelaysMs: [5, 5],
      fetch: async (input, init) => { hits += 1; if (hits < 3) return new Response("x", { status: 502 }); return fetch(input, init); },
    });
    assert.equal((await flaky.engineUser("eu1")).username, "u");
    assert.equal(hits, 3);
    hits = 0;
    const noRetry = new InternalApi({
      baseUrl: srv.url,
      token: { get: () => fake.token, invalidate() {} },
      retryDelaysMs: [5, 5],
      fetch: async () => { hits += 1; return new Response("x", { status: 502 }); },
    });
    await assert.rejects(noRetry.lease(["engine.sync"], 1), InternalApiError);
    assert.equal(hits, 1, "lease is not retried inside the client; the worker's backoff owns that");
    void api;
  } finally { await srv.close(); }
});
