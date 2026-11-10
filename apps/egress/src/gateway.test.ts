import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFeed } from "@purss/connectors";
import { FixtureAdapter, fixtureEntry } from "./gateway/fixture-adapter.ts";
import { createGatewayServer } from "./gateway/http.ts";
import { GatewayError, GatewayService } from "./gateway/service.ts";
import { PRODUCTION_ADAPTERS, startEgress } from "./server.ts";
import { control, gatewayGet, makeConfig, TOKEN } from "./testing.ts";
import type { AddressInfo } from "node:net";
import type { LogEvent } from "./proxy.ts";

const DAY = 86_400_000;
const FEED = "feed-aaaaaaaa";

type Harness = { service: GatewayService; adapter: FixtureAdapter; port: number; clock: { now: number }; logs: LogEvent[]; stop: () => Promise<void> };

async function harness(entries = 0, adapter?: FixtureAdapter): Promise<Harness> {
  const clock = { now: Date.parse("2026-11-03T12:00:00Z") };
  const fx = adapter ?? new FixtureAdapter("fixture", Array.from({ length: entries }, (_, i) => fixtureEntry(i + 1)));
  const service = new GatewayService({ adapters: [fx], now: () => clock.now });
  const logs: LogEvent[] = [];
  const server = createGatewayServer(service, { log: (e) => logs.push(e), now: () => clock.now });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    service,
    adapter: fx,
    port: (server.address() as AddressInfo).port,
    clock,
    logs,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      service.close();
    },
  };
}

function setup(h: Harness, limits: Parameters<GatewayService["upsertFeed"]>[0]["limits"] = {}) {
  h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "Maya's trip", siteUrl: "https://source.example/maya", description: "A private stream", limits });
  return h.service.issueCredential(FEED);
}

const get = (h: Harness, cred: { username: string; secret: string }, headers: Record<string, string> = {}) => gatewayGet(h.port, `/feeds/${FEED}`, { user: cred.username, pass: cred.secret, headers });

test("serves RSS with stable GUIDs to an engine that sends HTTP Basic credentials", async () => {
  const h = await harness(5);
  try {
    const cred = setup(h);
    const r = await get(h, cred);
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /application\/rss\+xml/);
    assert.equal(r.headers["cache-control"], "private, max-age=0, must-revalidate");
    const feed = parseFeed(r.body);
    assert.equal(feed.title, "Maya's trip");
    assert.equal(feed.siteUrl, "https://source.example/maya");
    assert.deepEqual(feed.items.map((i) => i.guid).sort(), ["fixture-1", "fixture-2", "fixture-3", "fixture-4", "fixture-5"]);
    assert.equal(feed.items.find((i) => i.guid === "fixture-3")!.url, "https://source.example/items/3");
    assert.equal(feed.items[0]!.author, "Fixture Author");
    assert.ok(feed.items.every((i) => i.publishedAt && i.contentHtml?.startsWith("<p>Full content")));
    // the same entries keep the same GUIDs on every poll
    const again = parseFeed((await get(h, cred)).body);
    assert.deepEqual(again.items.map((i) => i.guid), feed.items.map((i) => i.guid));
  } finally {
    await h.stop();
  }
});

test("authentication: missing, wrong, cross-feed, unknown feed and revoked credentials all get the same 401", async () => {
  const h = await harness(2);
  try {
    const cred = setup(h);
    h.service.upsertFeed({ feedId: "feed-bbbbbbbb", adapter: "fixture", title: "Other tenant" });
    const other = h.service.issueCredential("feed-bbbbbbbb");
    const bodies = new Set<string>();
    const attempts: [string, Promise<Awaited<ReturnType<typeof gatewayGet>>>][] = [
      ["no header", gatewayGet(h.port, `/feeds/${FEED}`)],
      ["bad scheme", gatewayGet(h.port, `/feeds/${FEED}`, { headers: { authorization: "Bearer " + cred.secret } })],
      ["wrong secret", gatewayGet(h.port, `/feeds/${FEED}`, { user: FEED, pass: "purssg_wrong" })],
      ["wrong user", gatewayGet(h.port, `/feeds/${FEED}`, { user: "someone", pass: cred.secret })],
      ["other feed's credential", gatewayGet(h.port, `/feeds/${FEED}`, { user: "feed-bbbbbbbb", pass: other.secret })],
      ["secret of A on B", gatewayGet(h.port, "/feeds/feed-bbbbbbbb", { user: FEED, pass: cred.secret })],
      ["unknown feed", gatewayGet(h.port, "/feeds/feed-zzzzzzzz", { user: "feed-zzzzzzzz", pass: cred.secret })],
      ["empty password", gatewayGet(h.port, `/feeds/${FEED}`, { user: FEED, pass: "" })],
    ];
    for (const [name, p] of attempts) {
      const r = await p;
      assert.equal(r.status, 401, name);
      assert.match(String(r.headers["www-authenticate"]), /^Basic realm="feed"/, name);
      bodies.add(r.body);
    }
    assert.equal(bodies.size, 1, "responses do not reveal which part was wrong or whether a feed exists");
    assert.equal((await get(h, cred)).status, 200);
    assert.equal((await gatewayGet(h.port, "/feeds/feed-bbbbbbbb", { user: "feed-bbbbbbbb", pass: other.secret })).status, 200);
    h.service.revokeCredential(FEED);
    assert.equal((await get(h, cred)).status, 401, "revocation takes effect immediately");
    assert.equal(h.service.state(FEED)!.credential.status, "revoked");
    assert.equal((await gatewayGet(h.port, "/feeds/feed-bbbbbbbb", { user: "feed-bbbbbbbb", pass: other.secret })).status, 200, "other feeds are unaffected");
    assert.ok(h.logs.every((l) => !JSON.stringify(l).includes(cred.secret)));
  } finally {
    await h.stop();
  }
});

test("rotation replaces the secret; a grace period keeps the old one valid only until it ends", async () => {
  const h = await harness(1);
  try {
    const first = setup(h);
    const hard = h.service.issueCredential(FEED);
    assert.notEqual(hard.secret, first.secret);
    assert.equal((await get(h, first)).status, 401, "plain rotation invalidates the previous secret at once");
    assert.equal((await get(h, hard)).status, 200);
    const graceful = h.service.issueCredential(FEED, { graceSeconds: 600 });
    assert.equal((await get(h, hard)).status, 200, "old secret still works during the grace period");
    assert.equal((await get(h, graceful)).status, 200);
    assert.equal(h.service.state(FEED)!.credential.previousValidUntil !== null, true);
    h.clock.now += 601_000;
    assert.equal((await get(h, hard)).status, 401, "grace period over");
    assert.equal((await get(h, graceful)).status, 200);
    assert.equal(h.service.state(FEED)!.credential.previousValidUntil, null);
    // re-issue after revocation is allowed and yields a working credential
    h.service.revokeCredential(FEED);
    assert.equal((await get(h, graceful)).status, 401);
    const reissued = h.service.issueCredential(FEED);
    assert.equal((await get(h, reissued)).status, 200);
  } finally {
    await h.stop();
  }
});

test("secrets are stored hashed only and never appear in feed state or the database", async () => {
  const h = await harness(1);
  try {
    const cred = setup(h);
    assert.doesNotMatch(JSON.stringify(h.service.state(FEED)), new RegExp(cred.secret));
    const rows = JSON.stringify(h.service.db.prepare("SELECT * FROM feeds").all());
    assert.doesNotMatch(rows, new RegExp(cred.secret));
    assert.match(cred.secret, /^purssg_[A-Za-z0-9_-]{43}$/, "256 bits of randomness");
  } finally {
    await h.stop();
  }
});

test("the engine-facing listener serves /feeds/<id> and nothing else", async () => {
  const h = await harness(1);
  try {
    const cred = setup(h);
    await get(h, cred); // stage the entry
    for (const path of ["/", "/status", "/feeds", "/feeds/", `/feeds/${FEED}/`, `/feeds/${FEED}/extra`, "/feeds/short", `/gateway/feeds/${FEED}/ack`, `/control/feeds/${FEED}/ack`, "/internal/jobs", "/api/session", "/admin", `/feeds/${FEED}/ack`, "/%2e%2e/etc/passwd", "/feeds/../status"]) {
      const r = await gatewayGet(h.port, path, { user: cred.username, pass: cred.secret });
      assert.equal(r.status, 404, path);
      assert.equal(r.body, "Not found.\n");
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await gatewayGet(h.port, `/feeds/${FEED}`, { user: cred.username, pass: cred.secret, method });
      assert.equal(r.status, 405, method);
    }
    const acked = await gatewayGet(h.port, `/feeds/${FEED}/ack`, { method: "POST", user: cred.username, pass: cred.secret });
    assert.equal(acked.status, 404, "acknowledgement is not reachable with feed credentials");
    assert.equal(h.service.state(FEED)!.staged.entries, 1);
  } finally {
    await h.stop();
  }
});

test("repeated failures for one feed from one client are throttled", async () => {
  const h = await harness(1);
  try {
    const cred = setup(h);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await gatewayGet(h.port, `/feeds/${FEED}`, { user: FEED, pass: `wrong-${i}` })).status;
    assert.equal(last, 429);
    const blocked = await gatewayGet(h.port, `/feeds/${FEED}`, { user: cred.username, pass: cred.secret });
    assert.equal(blocked.status, 429, "even the right secret waits out the throttle");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    h.clock.now += 61_000;
    assert.equal((await get(h, cred)).status, 200);
  } finally {
    await h.stop();
  }
});

test("staging: serving never releases entries; only acknowledgement does, and it is replay-safe", async () => {
  const h = await harness(5);
  try {
    const cred = setup(h);
    for (let i = 0; i < 3; i++) await get(h, cred);
    assert.equal(h.service.state(FEED)!.staged.entries, 5, "served three times, still staged");
    assert.equal(h.service.ack(FEED, ["fixture-1", "fixture-2"]), 2);
    assert.equal(h.service.ack(FEED, ["fixture-1", "fixture-2", "never-existed"]), 0, "replaying an acknowledgement is harmless");
    const guids = parseFeed((await get(h, cred)).body).items.map((i) => i.guid).sort();
    assert.deepEqual(guids, ["fixture-3", "fixture-4", "fixture-5"]);
    assert.throws(() => h.service.ack("feed-zzzzzzzz", ["x"]), GatewayError);
    assert.throws(() => h.service.ack(FEED, new Array(501).fill("x")), GatewayError);
  } finally {
    await h.stop();
  }
});

test("backpressure: the provider is asked only for what fits, the cursor advances with the staged entries, and acknowledgement frees room", async () => {
  const h = await harness(100);
  try {
    const cred = setup(h, { maxEntries: 10, maxBytes: 10 * 1024 * 1024, minRefreshSeconds: 1 });
    await get(h, cred);
    assert.equal(h.adapter.calls.length, 1);
    assert.equal(h.adapter.calls[0]!.limit, 10);
    assert.equal(h.adapter.calls[0]!.cursor, null);
    assert.equal(h.service.state(FEED)!.staged.entries, 10);

    h.clock.now += 5000;
    await get(h, cred);
    assert.equal(h.adapter.calls.length, 1, "no provider call while staging is full");
    assert.equal(h.service.state(FEED)!.health.code, "staging_full");
    assert.equal((await get(h, cred)).status, 200, "staged entries are still delivered while backlogged");

    h.service.ack(FEED, ["fixture-1", "fixture-2", "fixture-3", "fixture-4"]);
    h.clock.now += 5000;
    await get(h, cred);
    assert.equal(h.adapter.calls.length, 2);
    assert.equal(h.adapter.calls[1]!.limit, 4, "asks for exactly the free room");
    assert.equal(h.adapter.calls[1]!.cursor, "10", "resumes from the committed cursor");
    const st = h.service.state(FEED)!;
    assert.equal(st.staged.entries, 10);
    assert.equal(st.health.status, "ok");
    assert.deepEqual(st.gaps, [], "backpressure never creates a gap");
  } finally {
    await h.stop();
  }
});

test("refreshes are rate-limited per feed and concurrent requests share one provider call", async () => {
  const h = await harness(30);
  try {
    const cred = setup(h, { minRefreshSeconds: 60, maxEntries: 5 });
    await Promise.all([get(h, cred), get(h, cred), get(h, cred), get(h, cred)]);
    assert.equal(h.adapter.calls.length, 1);
    h.service.ack(FEED, ["fixture-1", "fixture-2"]);
    h.clock.now += 30_000;
    await get(h, cred);
    assert.equal(h.adapter.calls.length, 1, "inside the minimum interval");
    h.clock.now += 31_000;
    await get(h, cred);
    assert.equal(h.adapter.calls.length, 2);
  } finally {
    await h.stop();
  }
});

test("the response window is bounded; entries beyond it stay staged for later polls", async () => {
  const h = await harness(8);
  try {
    const cred = setup(h, { maxItemsPerResponse: 3 });
    const first = parseFeed((await get(h, cred)).body).items.map((i) => i.guid);
    assert.equal(first.length, 3);
    assert.equal(h.service.state(FEED)!.staged.entries, 8);
    h.service.ack(FEED, first as string[]);
    const second = parseFeed((await get(h, cred)).body).items.map((i) => i.guid);
    assert.equal(second.length, 3);
    assert.ok(second.every((g) => !first.includes(g)));
    const small = await harness(2);
    try {
      const c = setup(small, { maxResponseBytes: 1 });
      assert.equal(parseFeed((await get(small, c)).body).items.length, 1, "at least one entry is always delivered");
    } finally {
      await small.stop();
    }
  } finally {
    await h.stop();
  }
});

test("time bound: unacknowledged entries are released with a recorded coverage gap, never silently", async () => {
  const h = await harness(6);
  try {
    const cred = setup(h, { maxAgeSeconds: 10 * 86_400, minRefreshSeconds: 1, maxEntries: 6 });
    await get(h, cred);
    h.clock.now += 9 * DAY;
    assert.equal(parseFeed((await get(h, cred)).body).items.length, 6, "inside the bound everything is still there");
    assert.deepEqual(h.service.state(FEED)!.gaps, []);
    h.clock.now += 2 * DAY;
    await get(h, cred);
    const st = h.service.state(FEED)!;
    assert.equal(st.gaps.length, 1);
    assert.equal(st.gaps[0]!.reason, "age");
    assert.equal(st.gaps[0]!.count, 6);
    assert.match(st.gaps[0]!.firstPublishedAt ?? "", /^2026-10-0[2-7]/);
    assert.match(st.gaps[0]!.lastPublishedAt ?? "", /^2026-10-0[2-7]/);
    assert.equal(h.service.clearGaps(FEED, [st.gaps[0]!.id]), 1);
    assert.deepEqual(h.service.state(FEED)!.gaps, []);
  } finally {
    await h.stop();
  }
});

test("lowering a limit below what is staged releases the oldest entries and records the gap", async () => {
  const h = await harness(8);
  try {
    const cred = setup(h, { maxEntries: 8 });
    await get(h, cred);
    h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "Maya's trip", limits: { maxEntries: 3 } });
    const st = h.service.state(FEED)!;
    assert.equal(st.staged.entries, 3);
    assert.equal(st.gaps[0]!.reason, "entries");
    assert.equal(st.gaps[0]!.count, 5);
    assert.deepEqual(parseFeed((await get(h, cred)).body).items.map((i) => i.guid).sort(), ["fixture-6", "fixture-7", "fixture-8"], "the newest entries are the ones kept");
  } finally {
    await h.stop();
  }
});

test("a provider outage with entries waiting still delivers them; without entries it reports the failure", async () => {
  const h = await harness(4);
  try {
    const cred = setup(h, { minRefreshSeconds: 1, maxAgeSeconds: 30 * 86_400 });
    await get(h, cred);
    const t0 = h.service.state(FEED)!.health.lastProviderSuccessAt;
    assert.ok(t0);
    h.adapter.script.push({ kind: "temporary", code: "rate_limited", message: "Slow down", retryAfterSeconds: 120 });
    h.clock.now += 5000;
    const during = await get(h, cred);
    assert.equal(during.status, 200, "rate limited upstream, but held entries are delivered with 2xx");
    assert.equal(parseFeed(during.body).items.length, 4);
    let st = h.service.state(FEED)!;
    assert.equal(st.health.status, "degraded");
    assert.equal(st.health.code, "rate_limited");
    assert.equal(st.health.lastProviderSuccessAt, t0, "provider success time is not refreshed by delivery");
    assert.notEqual(st.health.lastDeliveryAt, null);
    assert.notEqual(st.health.lastDeliveryAt, st.health.lastProviderSuccessAt);
    assert.equal(h.adapter.calls.length, 2);
    // the outage outlasts staging's time limit for older entries, delivery of the rest is not blocked
    h.adapter.script.push({ kind: "temporary", code: "provider_error", message: "Still down" });
    h.clock.now += 20 * DAY;
    assert.equal((await get(h, cred)).status, 200, "still inside staging's time limit: deliverable although the provider is down");
    h.adapter.script.push({ kind: "temporary", code: "provider_error", message: "Still down" });
    h.clock.now += 11 * DAY;
    const after = await get(h, cred);
    assert.equal(after.status, 503, "nothing left to deliver and the upstream is failing: report it");
    assert.ok(Number(after.headers["retry-after"]) >= 1);
    st = h.service.state(FEED)!;
    assert.equal(st.gaps[0]!.reason, "age");
    assert.equal(st.gaps[0]!.count, 4);
  } finally {
    await h.stop();
  }
});

test("an unreachable or failing provider is never served as a successful empty feed", async () => {
  const h = await harness(0);
  try {
    const cred = setup(h, { minRefreshSeconds: 1 });
    h.adapter.script.push({ kind: "temporary", code: "network", message: "Provider unreachable" });
    const r = await get(h, cred);
    assert.equal(r.status, 503);
    assert.doesNotMatch(r.body, /<rss/);
    assert.equal(h.service.state(FEED)!.health.status, "error");
    // an honestly empty source is a valid, empty 200
    h.clock.now += 200_000;
    const ok = await get(h, cred);
    assert.equal(ok.status, 200);
    assert.equal(parseFeed(ok.body).items.length, 0);
    assert.equal(h.service.state(FEED)!.health.status, "ok");
  } finally {
    await h.stop();
  }
});

test("confirmed authorization loss stops access at once: non-2xx, staged data purged, credential revoked", async () => {
  const h = await harness(4);
  try {
    const cred = setup(h, { minRefreshSeconds: 1 });
    await get(h, cred);
    assert.equal(h.service.state(FEED)!.staged.entries, 4);
    h.adapter.script.push({ kind: "grant_lost", code: "invalid_grant", message: "The provider revoked the grant" });
    h.clock.now += 5000;
    const r = await get(h, cred);
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /<rss|fixture/);
    const st = h.service.state(FEED)!;
    assert.equal(st.grant, "lost");
    assert.equal(st.health.status, "permission_removed");
    assert.equal(st.health.code, "invalid_grant");
    assert.equal(st.staged.entries, 0, "stale cached entries do not outlive the authorization");
    assert.equal(st.credential.status, "revoked");
    assert.equal((await get(h, cred)).status, 401);
    assert.throws(() => h.service.issueCredential(FEED), /reconnect/i);
    assert.equal(h.adapter.calls.length, 2);
  } finally {
    await h.stop();
  }
});

test("a feed removed or disconnected while the provider call is in flight is not resurrected", async () => {
  const adapter = new FixtureAdapter("fixture", []);
  let release: (() => void) | undefined;
  adapter.refresh = () =>
    new Promise((resolve) => {
      release = () => resolve({ kind: "ok", entries: [fixtureEntry(1)], nextCursor: "1" });
    });
  const h = await harness(0, adapter);
  try {
    const cred = setup(h);
    const pending = get(h, cred);
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    h.service.deleteFeed(FEED);
    release!();
    const r = await pending;
    assert.equal(r.status, 404);
    assert.equal(h.service.state(FEED), null);
    assert.equal(h.service.summary().stagedEntries, 0);
  } finally {
    await h.stop();
  }
});

test("a user disconnect through the control path has the same effect", async () => {
  const h = await harness(3);
  try {
    const cred = setup(h);
    await get(h, cred);
    h.service.markGrantLost(FEED, "user_disconnect");
    assert.equal((await get(h, cred)).status, 401);
    const st = h.service.state(FEED)!;
    assert.deepEqual([st.grant, st.staged.entries, st.health.code], ["lost", 0, "user_disconnect"]);
  } finally {
    await h.stop();
  }
});

test("an adapter that breaks the contract stages nothing and does not advance the cursor", async () => {
  const adapter = new FixtureAdapter("fixture", []);
  const h = await harness(0, adapter);
  try {
    const cred = setup(h, { maxEntries: 3, minRefreshSeconds: 1 });
    adapter.script.push({ kind: "ok", entries: Array.from({ length: 10 }, (_, i) => fixtureEntry(i + 1)), nextCursor: "10" });
    const r = await get(h, cred);
    assert.equal(r.status, 503);
    const st = h.service.state(FEED)!;
    assert.equal(st.health.code, "adapter_invalid");
    assert.equal(st.staged.entries, 0);
    adapter.entries = [fixtureEntry(1), fixtureEntry(2)];
    h.clock.now += 5000;
    await get(h, cred);
    assert.equal(adapter.calls.at(-1)!.cursor, null, "the cursor never moved");
    assert.equal(h.service.state(FEED)!.staged.entries, 2);
    // an adapter that throws is a temporary failure, not a crash
    adapter.refresh = async () => {
      throw new Error("boom with secret token abc");
    };
    h.clock.now += 400_000;
    await get(h, cred);
    assert.equal(h.service.state(FEED)!.health.code, "provider_error");
    assert.doesNotMatch(JSON.stringify(h.service.state(FEED)), /secret token/);
  } finally {
    await h.stop();
  }
});

test("replay is safe: re-delivered entries do not duplicate and keep their GUID", async () => {
  const adapter = new FixtureAdapter("fixture", []);
  const h = await harness(0, adapter);
  try {
    const cred = setup(h, { minRefreshSeconds: 1 });
    adapter.script.push({ kind: "ok", entries: [fixtureEntry(1), fixtureEntry(2)], nextCursor: "a" });
    await get(h, cred);
    adapter.script.push({ kind: "ok", entries: [fixtureEntry(2, { title: "Edited title" }), fixtureEntry(3)], nextCursor: "b" });
    h.clock.now += 5000;
    await get(h, cred);
    const guids = parseFeed((await get(h, cred)).body).items.map((i) => i.guid).sort();
    assert.deepEqual(guids, ["fixture-1", "fixture-2", "fixture-3"]);
  } finally {
    await h.stop();
  }
});

test("emitted content is bounded: an oversized body is dropped as a whole and marked", async () => {
  const adapter = new FixtureAdapter("fixture", [fixtureEntry(1, { contentHtml: `<p>${"x".repeat(600_000)}</p>` }), fixtureEntry(2, { title: "t".repeat(5000), summaryHtml: "s".repeat(100_000) })]);
  const h = await harness(0, adapter);
  try {
    const cred = setup(h, { maxEntryBytes: 128 * 1024 });
    const r = await get(h, cred);
    assert.ok(r.body.length < 300_000);
    const feed = parseFeed(r.body);
    const big = feed.items.find((i) => i.guid === "fixture-1")!;
    assert.equal(big.contentHtml, null);
    assert.match(r.body, /<category>content-limited<\/category>/);
    const long = feed.items.find((i) => i.guid === "fixture-2")!;
    assert.ok((long.title ?? "").length <= 500);
  } finally {
    await h.stop();
  }
});

test("conditional requests: unchanged healthy feeds answer 304; any change or failure yields a full response", async () => {
  const h = await harness(3);
  try {
    const cred = setup(h, { minRefreshSeconds: 1 });
    const first = await get(h, cred);
    const etag = String(first.headers.etag);
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const again = await get(h, cred, { "if-none-match": etag });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    h.service.ack(FEED, ["fixture-1"]);
    const changed = await get(h, cred, { "if-none-match": etag });
    assert.equal(changed.status, 200, "an acknowledgement changes the served window");
    assert.notEqual(changed.headers.etag, etag);
    h.adapter.script.push({ kind: "temporary", code: "provider_error", message: "down" });
    h.clock.now += 100_000;
    const degraded = await get(h, cred, { "if-none-match": String(changed.headers.etag) });
    assert.equal(degraded.status, 200, "a known failure is not hidden behind 'not modified'");
    assert.equal((await gatewayGet(h.port, `/feeds/${FEED}`, { headers: { "if-none-match": etag } })).status, 401, "conditional requests still need credentials");
  } finally {
    await h.stop();
  }
});

test("feed configuration is validated, tenant-scoped by id, and cannot name an unregistered connector", async () => {
  const h = await harness(0);
  try {
    assert.throws(() => h.service.upsertFeed({ feedId: "x", adapter: "fixture", title: "t" }), /8 to 64/);
    assert.throws(() => h.service.upsertFeed({ feedId: FEED, adapter: "polarsteps", title: "t" }), (e: unknown) => e instanceof GatewayError && e.code === "unknown_adapter");
    assert.throws(() => h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "" }), GatewayError);
    assert.throws(() => h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "t", limits: { maxEntries: 100_000 } }), /ceiling/);
    assert.throws(() => h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "t", limits: { notALimit: 5 } as never }), /Unknown limit/);
    h.service.upsertFeed({ feedId: FEED, adapter: "fixture", title: "t" });
    assert.throws(() => h.service.upsertFeed({ feedId: FEED, adapter: "fixture2", title: "t" }), GatewayError);
    assert.equal(h.service.deleteFeed(FEED), true);
    assert.equal(h.service.state(FEED), null);
    assert.equal(h.service.deleteFeed(FEED), false);
  } finally {
    await h.stop();
  }
});

test("state survives a restart: staged entries, cursor, credential and gaps persist on disk with restricted permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "purss-gw-"));
  try {
    const path = join(dir, "egress", "gateway.db");
    const cfg = makeConfig({ gatewayDbPath: path });
    const adapter = new FixtureAdapter("fixture", Array.from({ length: 5 }, (_, i) => fixtureEntry(i + 1)));
    const first = await startEgress(cfg, { adapters: [adapter] });
    first.gateway.upsertFeed({ feedId: FEED, adapter: "fixture", title: "Persisted" });
    const cred = first.gateway.issueCredential(FEED);
    const served = await gatewayGet(first.ports.gateway, `/feeds/${FEED}`, { user: cred.username, pass: cred.secret });
    assert.equal(served.status, 200);
    first.gateway.ack(FEED, ["fixture-1"]);
    await first.stop();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "egress")).mode & 0o777, 0o700);

    const second = await startEgress(cfg, { adapters: [adapter] });
    try {
      const st = second.gateway.state(FEED)!;
      assert.equal(st.staged.entries, 4, "the acknowledgement persisted");
      assert.equal(st.credential.status, "active");
      const r = await gatewayGet(second.ports.gateway, `/feeds/${FEED}`, { user: cred.username, pass: cred.secret });
      assert.equal(r.status, 200, "the old credential keeps working after a restart");
      assert.equal(adapter.calls.length, 1, "the restart did not re-collect from the start (cursor persisted)");
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control routes: service-token only, full lifecycle, and no real connectors in this build", async () => {
  const adapter = new FixtureAdapter("fixture", Array.from({ length: 3 }, (_, i) => fixtureEntry(i + 1)));
  const egress = await startEgress(makeConfig(), { adapters: [adapter] });
  try {
    const c = egress.ports.control;
    assert.equal((await control(c, "GET", "/gateway/status", { token: null })).status, 401);
    assert.equal((await control(c, "PUT", `/gateway/feeds/${FEED}`, { token: "x".repeat(48), body: {} })).status, 401);
    const put = await control(c, "PUT", `/gateway/feeds/${FEED}`, { body: { adapter: "fixture", title: "Via control", siteUrl: "https://s.example/", limits: { maxEntries: 50 } } });
    assert.equal(put.status, 200);
    assert.equal(put.json.title, "Via control");
    const bad = await control(c, "PUT", `/gateway/feeds/${FEED}`, { body: { adapter: "polarsteps", title: "x" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "unknown_adapter");
    const cred = await control(c, "POST", `/gateway/feeds/${FEED}/credential`, { body: {} });
    assert.equal(cred.status, 200);
    assert.equal(cred.json.username, FEED);
    const secret = cred.json.secret as string;
    const served = await gatewayGet(egress.ports.gateway, `/feeds/${FEED}`, { user: FEED, pass: secret });
    assert.equal(served.status, 200);
    const state = await control(c, "GET", `/gateway/feeds/${FEED}`);
    assert.equal(state.json.staged.entries, 3);
    assert.doesNotMatch(JSON.stringify(state.json), new RegExp(secret));
    const ack = await control(c, "POST", `/gateway/feeds/${FEED}/ack`, { body: { guids: ["fixture-1", "fixture-2"] } });
    assert.deepEqual(ack.json, { released: 2 });
    assert.equal((await control(c, "POST", `/gateway/feeds/${FEED}/ack`, { body: { guids: "nope" } })).status, 400);
    assert.equal((await control(c, "POST", `/gateway/feeds/feed-zzzzzzzz/ack`, { body: { guids: [] } })).status, 404);
    assert.equal((await control(c, "POST", `/gateway/feeds/${FEED}/ack`, { body: undefined })).status, 400, "bodies must be JSON");
    const rotated = await control(c, "POST", `/gateway/feeds/${FEED}/credential`, { body: { graceSeconds: 0 } });
    assert.equal((await gatewayGet(egress.ports.gateway, `/feeds/${FEED}`, { user: FEED, pass: secret })).status, 401);
    assert.equal((await gatewayGet(egress.ports.gateway, `/feeds/${FEED}`, { user: FEED, pass: rotated.json.secret })).status, 200);
    assert.equal((await control(c, "DELETE", `/gateway/feeds/${FEED}/credential`)).status, 200);
    assert.equal((await gatewayGet(egress.ports.gateway, `/feeds/${FEED}`, { user: FEED, pass: rotated.json.secret })).status, 401);
    const lost = await control(c, "POST", `/gateway/feeds/${FEED}/grant-lost`, { body: { code: "user_disconnect" } });
    assert.equal(lost.json.grant, "lost");
    assert.equal((await control(c, "GET", "/gateway/status")).json.adapters[0], "fixture");
    assert.equal((await control(c, "DELETE", `/gateway/feeds/${FEED}`)).status, 200);
    assert.equal((await control(c, "GET", `/gateway/feeds/${FEED}`)).status, 404);
    assert.equal((await control(c, "GET", "/nothing")).status, 404);
    const huge = await control(c, "PUT", `/gateway/feeds/${FEED}`, { body: { adapter: "fixture", title: "x".repeat(200_000) } });
    assert.equal(huge.status, 400, "request bodies are bounded");
  } finally {
    await egress.stop();
  }
  assert.deepEqual([...PRODUCTION_ADAPTERS], [], "no real service adapter is approved or registered");
  const production = await startEgress(makeConfig());
  try {
    const attempt = await control(production.ports.control, "PUT", `/gateway/feeds/${FEED}`, { body: { adapter: "fixture", title: "x" } });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.json.error.code, "unknown_adapter");
    assert.deepEqual((await control(production.ports.control, "GET", "/gateway/status")).json, { feeds: 0, stagedEntries: 0, adapters: [] });
  } finally {
    await production.stop();
  }
  assert.equal(TOKEN.length, 48);
});
