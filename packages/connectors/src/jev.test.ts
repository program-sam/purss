import test from "node:test";
import assert from "node:assert/strict";
import { askJev, askJevEach, JevError, jevConfigFromEnv, jevKeySource, readAnswer } from "./jev.ts";

const config = { ...jevConfigFromEnv({}), baseUrl: "https://jev.test" };
const request = { state: { source: "S", title: "T", author: null, summary: null }, questions: { a: { type: "noul" as const, instructions: "Keep?", criteria: { true: "yes", false: "no" } } } };

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers });

test("the defaults are TypeSafe's address and the newest Jev; OpenRouter gets its own alias; the operator can pin a version", () => {
  assert.deepEqual(jevConfigFromEnv({}), { baseUrl: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 20_000 });
  assert.equal(jevConfigFromEnv({ PURSS_JEV_URL: "https://openrouter.ai/api" }).model, "~typesafe/jev-latest");
  assert.equal(jevConfigFromEnv({ PURSS_JEV_URL: "https://openrouter.ai/api", PURSS_JEV_MODEL: "typesafe/jev-1.13" }).model, "typesafe/jev-1.13");
  assert.equal(jevConfigFromEnv({ PURSS_JEV_URL: "https://jev.example/", PURSS_JEV_MODEL: "jev-preview" }).baseUrl, "https://jev.example");
  assert.equal(jevKeySource("https://openrouter.ai/api"), "OpenRouter (openrouter.ai/keys)");
  assert.equal(jevKeySource("https://api.typesafe.ai"), "TypeSafe (console.typesafe.ai)");
});

test("a request carries the key, the model, the state and the questions, and an answer gives each question's chance", async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const answer = await askJev(config, "k-1", request, {
    fetch: async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.81 } }, usage: { input_tokens: 120, output_tokens: 12 } }), { status: 200 });
    },
  });
  assert.deepEqual(answer, { model: "jev-1.13.0", answers: { a: 0.81 }, inputTokens: 120 });
  assert.equal(sent!.url, "https://jev.test/v1/systemone");
  assert.equal((sent!.init.headers as Record<string, string>).authorization, "Bearer k-1");
  assert.equal(sent!.init.redirect, "error", "a key is never carried to another address");
  assert.deepEqual(JSON.parse(String(sent!.init.body)), { model: "jev-latest", state: request.state, questions: request.questions });
});

test("failures are told apart: a refused key, a refused request, busy (with its wait) and no answer", async () => {
  const failure = async (f: () => Promise<Response>) => {
    try { await askJev(config, "k", request, { fetch: f }); } catch (e) { return e as JevError; }
    throw new Error("expected a failure");
  };
  assert.equal((await failure(reply(401))).failure, "key_rejected");
  assert.equal((await failure(reply(422))).failure, "invalid");
  const busy = await failure(reply(429, {}, { "retry-after": "7" }));
  assert.equal(busy.failure, "busy");
  assert.equal(busy.retryAfterSeconds, 7);
  assert.ok(busy.retryable);
  assert.equal((await failure(reply(529))).failure, "busy");
  assert.equal((await failure(reply(500))).failure, "unavailable");
  assert.equal((await failure(async () => { throw new TypeError("fetch failed"); })).failure, "unavailable");
  assert.ok(!(await failure(reply(401))).retryable);
});

test("an answer that leaves out a question, or isn't a chance, is not used", () => {
  assert.throws(() => readAnswer({ answers: {} }, ["a"]), JevError);
  assert.throws(() => readAnswer({ answers: { a: { noul: 1.5 } } }, ["a"]), JevError);
  assert.throws(() => readAnswer({ answers: { a: { noul: "0.5" } } }, ["a"]), JevError);
  assert.deepEqual(readAnswer({ answers: { a: { noul: 0 } } }, ["a"]), { model: null, answers: { a: 0 }, inputTokens: null });
});

test("a reply without its token count is counted by the size of what was sent, never as free", async () => {
  const answer = await askJev(config, "k", request, { fetch: reply(200, { answers: { a: { noul: 0.4 } } }) });
  assert.ok(answer.inputTokens > 10, `counted ${answer.inputTokens}`);
});

test("asking about several posts keeps each answer, and stops asking after a refused key", async () => {
  let calls = 0;
  const answers = await askJevEach(config, "k", [request, request, request, request], {
    concurrency: 1,
    fetch: async () => {
      calls++;
      return calls === 2 ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ answers: { a: { noul: 0.5 } }, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });
  assert.equal(calls, 2, "nothing more is sent with a key Jev refused");
  assert.equal((answers[0] as { inputTokens: number }).inputTokens, 10);
  assert.ok(answers.slice(1).every((a) => a instanceof JevError && a.failure === "key_rejected"));
});
