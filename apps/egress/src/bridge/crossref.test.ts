import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeRoutePath, bridgeService, parseFeed } from "@purss/connectors";
import type { FetchFn, SafeFetchResult } from "@purss/connectors";
import { crossrefBackend } from "./crossref.ts";
import { BridgeLog } from "./log.ts";
import { BridgeRouter } from "./router.ts";
import type { BridgeBackend } from "./router.ts";

const crossref = bridgeService("crossref")!;
const telegram = bridgeService("telegram")!;
const SECRET = "k".repeat(43);

function answer(url: string, status: number, body: string, headers: Record<string, string> = {}): SafeFetchResult {
  return { ok: true, response: { url, requestedUrl: url, redirects: [], status, headers: { "content-type": "application/json", ...headers }, mediaType: "application/json", contentType: "application/json", body: Buffer.from(body), bytes: body.length, truncated: false, remoteAddress: "104.18.0.1", fetchedAt: "2026-11-17T12:00:00.000Z" } } as SafeFetchResult;
}

const WORKS = JSON.stringify({ message: { items: [{ DOI: "10.1155/cad/1", type: "journal-article", title: ["One"], "container-title": ["Journal"], created: { "date-time": "2026-11-01T00:00:00Z" } }] } });

/** A clock that only moves when the backend sleeps, and a fetch that records when and what it was asked. */
function harness(reply: (url: string, n: number) => SafeFetchResult) {
  const clock = { now: 0 };
  const asked: { url: string; at: number; opts: Parameters<FetchFn>[1] }[] = [];
  const fetch: FetchFn = async (url, opts) => {
    asked.push({ url, at: clock.now, opts });
    return reply(url, asked.length);
  };
  const backend = crossrefBackend({ fetch, now: () => clock.now, sleep: async (ms) => { clock.now += ms; } });
  return { backend, asked, clock };
}

test("Crossref is asked for the journal's newest works at a fixed address, without following redirects, within size and time limits", async () => {
  const { backend, asked } = harness((url) => answer(url, 200, WORKS));
  const r = await backend.fetch(crossref, "15348687");
  assert.ok("status" in r && r.status === 200);
  assert.equal(parseFeed(r.body).items[0]!.url, "https://doi.org/10.1155/cad/1");
  assert.equal(asked[0]!.url, "https://api.crossref.org/journals/1534-8687/works?sort=created&order=desc&rows=40&select=DOI,title,subtitle,author,abstract,created,published-online,type,container-title");
  assert.equal(asked[0]!.opts?.maxRedirects, 0);
  assert.equal(asked[0]!.opts?.maxBytes, 4 * 1024 * 1024);
  assert.equal(asked[0]!.opts?.timeoutMs, 30_000);
});

test("journals are asked one at a time, at least 250 ms apart, in the order asked", async () => {
  let inFlight = 0;
  let most = 0;
  const clock = { now: 0 };
  const starts: number[] = [];
  const fetch: FetchFn = async (url) => {
    inFlight++;
    most = Math.max(most, inFlight);
    starts.push(clock.now);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return answer(url, 200, WORKS);
  };
  const backend = crossrefBackend({ fetch, now: () => clock.now, sleep: async (ms) => { clock.now += ms; } });
  await Promise.all(["15348687", "18344461", "15481433"].map((k) => backend.fetch(crossref, k)));
  assert.equal(most, 1, "never two requests at once");
  assert.deepEqual(starts, [0, 250, 500]);
});

test("after a 429 every journal waits out Retry-After (at least a minute) without asking Crossref; then asking resumes", async () => {
  const { backend, asked, clock } = harness((url, n) => (n === 1 ? answer(url, 429, "", { "retry-after": "5" }) : answer(url, 200, WORKS)));
  const first = await backend.fetch(crossref, "15348687");
  assert.ok("status" in first && first.status === 429);
  clock.now += 30_000;
  const other = await backend.fetch(crossref, "18344461");
  assert.ok("status" in other && other.status === 429, "another journal during the wait");
  assert.equal(asked.length, 1, "nothing was asked during the wait");
  clock.now += 31_000;
  const later = await backend.fetch(crossref, "18344461");
  assert.ok("status" in later && later.status === 200);
  assert.equal(asked.length, 2);
});

test("an ISSN Crossref doesn't know is a 404 and an answer that isn't works is unreadable: failures, never an empty feed", async () => {
  const log = new BridgeLog({ now: () => 0 });
  const make = (reply: SafeFetchResult) => new BridgeRouter({ secret: SECRET, backends: [crossrefBackend({ fetch: async () => reply, sleep: async () => {} })], log, now: () => 0 });
  const sig = bridgeRoutePath(SECRET, "crossref", "15348687").split("/").at(-1)!;
  assert.equal((await make(answer("x", 404, "Resource not found.")).serve("crossref", "15348687", sig)).status, 503);
  assert.equal((await make(answer("x", 200, "<html>")).serve("crossref", "15348687", sig)).status, 503);
  const outcomes = (log.db.prepare("SELECT outcome FROM bridge_fetches ORDER BY id").all() as { outcome: string }[]).map((r) => r.outcome);
  assert.deepEqual(outcomes, ["http_404", "parse_error"]);
  const good = await make(answer("x", 200, WORKS)).serve("crossref", "15348687", sig);
  assert.equal(good.status, 200);
  assert.deepEqual(parseFeed(good.body).items.map((i) => i.guid), ["doi:10.1155/cad/1"]);
});

test("each service goes to its own kind of backend; a service whose backend isn't run here is not served", async () => {
  const asked: string[] = [];
  const fake = (kind: BridgeBackend["kind"]): BridgeBackend => ({ name: kind, kind, fetch: async (s, k) => { asked.push(`${kind}:${s.id}/${k}`); return { status: 500, body: Buffer.alloc(0) }; } });
  const log = new BridgeLog({ now: () => 0 });
  const onlyCrossref = new BridgeRouter({ secret: SECRET, backends: [fake("crossref")], log, now: () => 0 });
  const tsig = bridgeRoutePath(SECRET, telegram.id, "durov").split("/").at(-1)!;
  assert.equal((await onlyCrossref.serve("telegram", "durov", tsig)).status, 404, "Telegram without RSS-Bridge");
  const both = new BridgeRouter({ secret: SECRET, backends: [fake("rss-bridge"), fake("crossref")], log, now: () => 0 });
  await both.serve("telegram", "durov", tsig);
  await both.serve("crossref", "15348687", bridgeRoutePath(SECRET, "crossref", "15348687").split("/").at(-1)!);
  assert.deepEqual(asked, ["rss-bridge:telegram/durov", "crossref:crossref/15348687"]);
});

test("Retry-After is kept as Crossref gives it: a delay beyond an hour, or an HTTP date", async () => {
  for (const retry of ["7200", new Date(7_200_000).toUTCString()]) {
    const { backend, asked, clock } = harness((url, n) => (n === 1 ? answer(url, 503, "", { "retry-after": retry }) : answer(url, 200, WORKS)));
    await backend.fetch(crossref, "15348687");
    clock.now = 7_199_000;
    assert.ok("status" in (await backend.fetch(crossref, "15348687")), retry);
    assert.equal(asked.length, 1, `${retry}: still waiting just before the time Crossref named`);
    clock.now = 7_200_000;
    await backend.fetch(crossref, "15348687");
    assert.equal(asked.length, 2, `${retry}: asking resumes at that time`);
  }
});
