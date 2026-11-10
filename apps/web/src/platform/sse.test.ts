import test from "node:test";
import assert from "node:assert/strict";
import { EventStreamParser, followEvents, reconnectDelay } from "./sse.ts";

test("messages are their data lines; comments and other fields are skipped; line ends may split anywhere", () => {
  const got: string[] = [];
  const p = new EventStreamParser((d) => got.push(d));
  p.push(": connected\n\n");
  p.push('data: {"type":"items"}\n\n');
  p.push("data: one\r");
  p.push("\ndata: two\r\n\r\n");
  p.push("event: x\nid: 4\ndata:no-space\n");
  p.push("\n");
  p.push("data: half");
  assert.deepEqual(got, ['{"type":"items"}', "one\ntwo", "no-space"]);
  p.push(" more\n\n");
  assert.deepEqual(got.at(-1), "half more");
});

test("reconnecting waits 1 s, doubling to a minute, with a little randomness", () => {
  assert.equal(reconnectDelay(0, () => 0), 1000);
  assert.equal(reconnectDelay(3, () => 0), 8000);
  assert.equal(reconnectDelay(20, () => 0), 60_000);
  assert.equal(reconnectDelay(1, () => 1), 2400);
});

function stream(chunks: string[]): Response {
  return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
}

test("a dropped stream is opened again; a refusal stops it; stopping stops it", async () => {
  const timers: (() => void)[] = [];
  const opened: number[] = [];
  const answers: (() => Response)[] = [
    () => stream(["data: a\n\n"]),
    () => { throw new TypeError("network"); },
    () => stream(["data: b\n\n"]),
    () => new Response('{"error":{"code":"device_signed_out"}}', { status: 401 }),
  ];
  let refused = 0;
  const got: string[] = [];
  const stop = followEvents({
    open: async () => { opened.push(opened.length); return answers.shift()!(); },
    onRefused: () => { refused++; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
  }, (d) => got.push(d));
  const settle = () => new Promise((r) => setTimeout(r, 10));
  await settle();
  assert.deepEqual(got, ["a"]);
  for (let i = 0; i < 3; i++) { timers.shift()?.(); await settle(); }
  assert.deepEqual(got, ["a", "b"]);
  assert.equal(refused, 1);
  assert.equal(opened.length, 4);
  assert.equal(timers.length, 0, "no reconnect after a refusal");
  stop();
});
