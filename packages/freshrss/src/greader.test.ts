import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "./errors.ts";
import { GReaderClient } from "./greader.ts";
import { FakeEngine } from "./testing/fake-engine.ts";

async function withEngine<T>(fn: (engine: FakeEngine, client: GReaderClient, baseUrl: string) => Promise<T>): Promise<T> {
  const engine = new FakeEngine();
  const srv = await engine.listen();
  try {
    return await fn(engine, new GReaderClient({ baseUrl: srv.baseUrl, username: "user1", apiPassword: "pw-user1-0123456789abcdef", requestTimeoutMs: 3000 }), srv.baseUrl);
  } finally {
    await srv.close();
  }
}

test("login, user-info and subscription list", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/feed.xml", "Example");
    await client.login();
    assert.deepEqual(await client.userInfo(), { userId: "user1", userName: "user1" });
    const subs = await client.listSubscriptions();
    assert.deepEqual(subs.map((s) => [s.streamId, s.url, s.title]), [["feed/1", "https://example.org/feed.xml", "Example"]]);
  });
});

test("wrong credentials are an auth error that is not retryable and does not leak the password", async () => {
  const engine = new FakeEngine();
  const srv = await engine.listen();
  try {
    const client = new GReaderClient({ baseUrl: srv.baseUrl, username: "user1", apiPassword: "wrong-wrong-wrong-wrong" });
    await assert.rejects(client.login(), (e: unknown) => e instanceof EngineError && e.kind === "auth" && !e.retryable && !e.message.includes("wrong-wrong"));
  } finally {
    await srv.close();
  }
});

test("stream contents sends ascending order, page size, continuation and lower bound", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/feed.xml", "Example");
    for (let i = 0; i < 5; i++) engine.addEntry({ id: BigInt(1_700_000_000 + i) * 1_000_000n, feedId: 1, title: `t${i}`, content: "c", link: `https://example.org/${i}` });
    const first = await client.streamContents({ count: 2, order: "asc", newerThanSeconds: 1_700_000_001 });
    assert.equal(first.items.length, 2);
    assert.ok(first.continuation);
    const last = engine.requests.at(-1)!;
    assert.deepEqual([last.query.n, last.query.r, last.query.ot, last.query.c], ["2", "o", "1700000001", undefined]);
    const second = await client.streamContents({ count: 2, order: "asc", continuation: first.continuation, newerThanSeconds: 1_700_000_001 });
    assert.equal(engine.requests.at(-1)!.query.c, first.continuation);
    // ids at/after the lower bound: t1..t4. Page 1 = t1,t2. The engine re-reads the continuation entry (t2) and discards it.
    assert.deepEqual(second.items.map((i) => i.title), ["t3", "t4"]);
    assert.ok(second.continuation, "a full page may have more, so a token is returned");
    const third = await client.streamContents({ count: 2, order: "asc", continuation: second.continuation, newerThanSeconds: 1_700_000_001 });
    assert.deepEqual(third.items, []);
    assert.equal(third.continuation, null);
  });
});

test("whether one subscription holds items is asked of its own stream, not of the reading list", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/a.xml", "Has items");
    engine.addFeed("https://example.org/b.xml", "Empty");
    engine.addEntry({ id: 1_700_000_000n * 1_000_000n, feedId: 1, title: "t", content: "c", link: "https://example.org/t" });
    assert.equal(await client.feedHasItems("feed/1"), true);
    assert.equal(await client.feedHasItems("feed/2"), false, "the reading list has an item, but not this feed");
    const asked = engine.requests.at(-1)!;
    assert.equal(asked.path, "/reader/api/0/stream/contents/feed/2");
    assert.equal(asked.query.n, "1");
    await assert.rejects(client.feedHasItems("user/-/state/com.google/reading-list"), (e: unknown) => e instanceof EngineError && !e.retryable);
    await assert.rejects(client.feedHasItems("feed/../x"), (e: unknown) => e instanceof EngineError);
  });
});

test("an expired session is renewed once transparently", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/feed.xml", "Example");
    await client.listSubscriptions();
    engine.users.set("user1", "pw-user1-0123456789abcdef"); // same password; force a 401 on the next call by dropping the user briefly
    engine.failNext = { status: 401, remaining: 1 };
    const subs = await client.listSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(engine.requests.filter((r) => r.path === "/accounts/ClientLogin").length, 2);
  });
});

test("status codes map to retryable and non-retryable kinds", async () => {
  await withEngine(async (engine, client) => {
    for (const [status, kind, retryable] of [[429, "rate_limited", true], [500, "unavailable", true], [503, "api_disabled", true], [400, "bad_request", false]] as const) {
      engine.failNext = { status, remaining: 1 };
      await assert.rejects(client.listSubscriptions(), (e: unknown) => e instanceof EngineError && e.kind === kind && e.retryable === retryable, `${status}`);
    }
  });
});

test("an unreachable engine is a retryable network error", async () => {
  const client = new GReaderClient({ baseUrl: "http://127.0.0.1:1", username: "u", apiPassword: "p", requestTimeoutMs: 1000 });
  await assert.rejects(client.login(), (e: unknown) => e instanceof EngineError && (e.kind === "network" || e.kind === "timeout") && e.retryable);
});

test("a caller abort is reported as cancelled, not as a network error", async () => {
  await withEngine(async (engine, _c, baseUrl) => {
    engine.delayMs = 500;
    const ac = new AbortController();
    const client = new GReaderClient({ baseUrl, username: "user1", apiPassword: "pw-user1-0123456789abcdef", signal: ac.signal });
    const p = client.login();
    ac.abort();
    await assert.rejects(p, (e: unknown) => e instanceof EngineError && e.kind === "cancelled");
  });
});

test("quick-add returns the new stream, reports an existing subscription, and rejects an unreadable feed", async () => {
  await withEngine(async (_engine, client) => {
    const added = await client.quickAdd("https://example.org/a.xml");
    assert.ok("streamId" in added && added.streamId === "feed/1");
    const again = await client.quickAdd("https://example.org/a.xml");
    assert.ok("already" in again);
    await assert.rejects(client.quickAdd("https://example.org/broken.xml?token=secret"), (e: unknown) => e instanceof EngineError && e.kind === "rejected" && !e.retryable && !e.message.includes("secret") && !e.message.includes("example.org") && /404/.test(e.message));
    await assert.rejects(client.quickAdd("https://example.org/flaky.xml"), (e: unknown) => e instanceof EngineError && e.kind === "unavailable" && e.retryable && !e.message.includes("example.org"));
  });
});

test("unsubscribe and rename; unknown streams are bad requests", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/a.xml", "A");
    await client.renameSubscription("feed/1", "Renamed");
    assert.equal(engine.feeds[0]!.title, "Renamed");
    await client.unsubscribe("feed/1");
    assert.equal(engine.feeds.length, 0);
    await assert.rejects(client.unsubscribe("feed/1"), (e: unknown) => e instanceof EngineError && e.kind === "bad_request");
    await client.renameSubscription("feed/99", "x"); // accepted silently by the engine; callers must check existence themselves
  });
});

test("mark read/unread and star use edit-tag with the action token and repeat the item parameter", async () => {
  await withEngine(async (engine, client) => {
    engine.addFeed("https://example.org/a.xml", "A");
    const e1 = engine.addEntry({ id: 1_700_000_000_000_001n, feedId: 1, title: "a", content: "", link: "https://example.org/1" });
    const e2 = engine.addEntry({ id: 1_700_000_000_000_002n, feedId: 1, title: "b", content: "", link: "https://example.org/2" });
    await client.markRead([e1.id.toString(), e2.id.toString()], true);
    const call = engine.requests.filter((r) => r.path === "/reader/api/0/edit-tag").at(-1)!;
    assert.deepEqual(call.form!.getAll("i"), [e1.id.toString(), e2.id.toString()]);
    assert.deepEqual(call.form!.getAll("a"), ["user/-/state/com.google/read"]);
    assert.equal(call.form!.get("T")!.length, 57);
    assert.equal(e1.read && e2.read, true);
    await client.markRead([e1.id.toString()], false);
    assert.equal(e1.read, false);
    await client.setStarred([e2.id.toString()], true);
    assert.equal(e2.starred, true);
    await assert.rejects(client.markRead(["abc"], true), (e: unknown) => e instanceof EngineError && e.kind === "bad_request");
    await client.markRead([], true); // no request
  });
});

test("a YouTube feed's 404 at subscribe time is temporary; other 404s are not", async () => {
  const { quickAddFailure } = await import("./greader.ts");
  const yt = quickAddFailure('HTTP request failed: unsupported status code "404"', "https://www.youtube.com/feeds/videos.xml?channel_id=UCbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(yt.retryable, true);
  const other = quickAddFailure('HTTP request failed: unsupported status code "404"', "https://example.org/feed");
  assert.equal(other.retryable, false);
});

test("a site's rate limit and an overlarge feed are told apart from permanent refusals, in every wording the engine uses", async () => {
  const { quickAddFailure } = await import("./greader.ts");
  // The engine's own wording at subscribe time, as logged for Reddit feeds.
  for (const message of ["HTTP 429 Too Many Requests!", 'HTTP request failed: unsupported status code "429"', "cURL error 22: The requested URL returned error: 429"]) {
    const e = quickAddFailure(message, "https://www.reddit.com/r/x/.rss");
    assert.equal(e.kind, "rate_limited", message);
    assert.equal(e.retryable, true, message);
    assert.equal(e.reason, "rate_limited", message);
    assert.ok(!e.message.includes("reddit.com"));
  }
  for (const message of ["HTTP 503 Service Unavailable!", 'unsupported status code "502"']) {
    const e = quickAddFailure(message);
    assert.equal(e.reason, "unavailable", message);
    assert.equal(e.retryable, true, message);
  }
  assert.equal(quickAddFailure("cURL error 7: Failed to connect").reason, "unavailable");
  assert.deepEqual([quickAddFailure("HTTP 404 Not Found!").reason, quickAddFailure("HTTP 404 Not Found!").retryable], ["not_found", false]);
  assert.equal(quickAddFailure('unsupported status code "403"').reason, "refused");
  assert.equal(quickAddFailure("cURL error 63: Maximum file size exceeded").reason, "too_large");
  assert.equal(quickAddFailure("cURL error 63: Maximum file size exceeded").retryable, false);
  assert.equal(quickAddFailure("Feed could not be parsed").reason, "not_a_feed");
});
