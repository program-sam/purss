import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { jevConfigFromEnv } from "@purss/connectors";
import type { AiJudgeInput, LeasedJob } from "@purss/domain";
import { createHandlers } from "./handlers.ts";
import type { HandlerDeps } from "./handlers.ts";
import type { InternalApi } from "./internal-api.ts";
import { JobFailure } from "./runner.ts";

/** The worker's filter.judge job (plan/36): the key it asks with, and what it reports when Jev fails. */

const request = (itemId: string) => ({ itemId, state: { source: "S", title: itemId, author: null, summary: null }, questions: { f1_aif: { type: "noul" as const, instructions: "Keep?", criteria: { true: "a", false: "b" } } } });

function setup(input: AiJudgeInput, jevFetch: (url: string, init: RequestInit) => Promise<Response>) {
  const secretsDir = mkdtempSync(path.join(os.tmpdir(), "purss-worker-ai-"));
  writeFileSync(path.join(secretsDir, "jev-server-key"), "server-key\n");
  const api = { filterInput: async () => input } as unknown as InternalApi;
  const deps = {
    api, secretsDir, log: () => {}, syncPageSize: 10, syncOverlapSeconds: 0, syncMaxBatchBytes: 100_000, requestTimeoutMs: 1000,
    jev: { config: { ...jevConfigFromEnv({}), baseUrl: "https://jev.test" }, fetch: jevFetch },
  } as unknown as HandlerDeps;
  const handler = createHandlers(deps)["filter.judge"]!;
  const job: LeasedJob = { id: "job_1", kind: "filter.judge", payload: {}, leaseId: "lse_1", leaseExpiresAt: "", attempts: 1 };
  return { run: () => handler({ job, payload: { itemIds: input.requests.map((r) => r.itemId), announce: true }, signal: new AbortController().signal }), cleanup: () => rmSync(secretsDir, { recursive: true, force: true }) };
}

const ok = (p: number) => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { f1_aif: { type: "noul", noul: p } }, usage: { input_tokens: 90 } }), { status: 200 });

test("the worker asks with the server's key from the secrets folder", async (t) => {
  const auths: string[] = [];
  const fetch = async (_u: string, init: RequestInit) => { auths.push((init.headers as Record<string, string>).authorization!); return ok(0.7); };
  const s = setup({ route: "server", model: "jev-1.13.0", requests: [request("itm_a")] }, fetch);
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { route: "server", model: "jev-1.13.0", keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: [{ itemId: "itm_a", answers: { f1_aif: 0.7 }, inputTokens: 90 }] });
  assert.deepEqual(auths, ["Bearer server-key"]);
});

test("no route or nothing to ask: Jev is not called", async (t) => {
  let called = false;
  const s = setup({ route: null, model: "jev-1.13.0", requests: [] }, async () => { called = true; return ok(1); });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { route: null, model: null, keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: [] });
  assert.equal(called, false);
});

test("some posts answered: the rest are reported unfinished; none answered: the job fails and is retried; a refused key is reported", async (t) => {
  let n = 0;
  const partly = setup({ route: "server", model: "jev-1.13.0", requests: [request("itm_a"), request("itm_b")] }, async () => (++n === 1 ? ok(0.2) : new Response("{}", { status: 503 })));
  t.after(partly.cleanup);
  const r = await partly.run() as { verdicts: unknown[]; unfinished: string[] };
  assert.equal(r.verdicts.length, 1);
  assert.deepEqual(r.unfinished, ["itm_b"]);

  const none = setup({ route: "server", model: "jev-1.13.0", requests: [request("itm_a")] }, async () => new Response("{}", { status: 429 }));
  t.after(none.cleanup);
  await assert.rejects(none.run(), (e: unknown) => e instanceof JobFailure && e.retryable && e.reason === "rate_limited");

  const refused = setup({ route: "server", model: "jev-1.13.0", requests: [request("itm_a")] }, async () => new Response("{}", { status: 401 }));
  t.after(refused.cleanup);
  const r2 = await refused.run() as { keyRejected: boolean; keyFingerprint: string };
  assert.equal(r2.keyRejected, true);
  assert.match(r2.keyFingerprint, /^[0-9a-f]{16}$/, "a fingerprint, never the key");
});
