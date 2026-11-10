import assert from "node:assert/strict";
import test from "node:test";
import type { SyncEntry } from "@purss/domain";
import { EngineError } from "./errors.ts";
import { runSync } from "./sync.ts";
import type { SyncBatchDraft, SyncCheckpoint } from "./sync.ts";
import { FakeEngine } from "./testing/fake-engine.ts";

const T0 = 1_762_000_000n; // seconds
const usec = (sec: bigint, micro = 0n) => sec * 1_000_000n + micro;
const IDENTITY = "freshrss:aaaaaaaa";

function seed(engine: FakeEngine, n: number, start = T0): void {
  const feed = engine.feeds[0] ?? engine.addFeed("https://example.org/feed.xml", "Example");
  for (let i = 0; i < n; i++) {
    engine.addEntry({ id: usec(start + BigInt(i * 60), BigInt(i)), feedId: feed.id, title: `Entry ${i}`, content: `<p>${i}</p>`, link: `https://example.org/${i}` });
  }
}

/** A stand-in for the product API: stores batches by idempotency key, holds the checkpoint. */
function productStore() {
  const seen = new Map<string, number>();
  const imported = new Map<string, SyncEntry>();
  const batches: SyncBatchDraft[] = [];
  let checkpoint: SyncCheckpoint = { continuation: null, newestCrawlUsec: null, engineIdentity: null };
  return {
    batches,
    imported,
    get checkpoint() { return checkpoint; },
    submit: async (b: SyncBatchDraft) => {
      batches.push(b);
      if (seen.has(b.idempotencyKey)) return { accepted: 0, duplicates: seen.get(b.idempotencyKey)! };
      let dup = 0;
      for (const e of b.entries) {
        if (imported.has(e.externalId)) dup += 1;
        imported.set(e.externalId, e);
      }
      seen.set(b.idempotencyKey, b.entries.length);
      checkpoint = { ...b.checkpoint, engineIdentity: b.engineIdentity };
      return { accepted: b.entries.length - dup, duplicates: dup };
    },
  };
}

test("walks a multi-page backlog with continuation and ends with a complete, empty-continuation checkpoint", async () => {
  const engine = new FakeEngine();
  seed(engine, 25);
  const store = productStore();
  const summary = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 10 });
  assert.equal(summary.complete, true);
  assert.equal(store.imported.size, 25);
  assert.deepEqual(store.batches.map((b) => b.entries.length), [10, 10, 5]);
  assert.deepEqual(store.batches.map((b) => b.done), [false, false, true]);
  assert.notEqual(store.batches[0]!.checkpoint.continuation, null);
  assert.equal(store.batches[2]!.checkpoint.continuation, null);
  assert.equal(store.checkpoint.newestCrawlUsec, usec(T0 + 24n * 60n, 24n).toString());
  // ascending crawl order, no gaps, no repeats
  const ids = store.batches.flatMap((b) => b.entries.map((e) => BigInt(e.externalId)));
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)));
  assert.equal(new Set(ids).size, 25);
});

test("a page that is exactly full is followed by one empty terminal batch", async () => {
  const engine = new FakeEngine();
  seed(engine, 20);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 10 });
  assert.deepEqual(store.batches.map((b) => [b.entries.length, b.done]), [[10, false], [10, false], [0, true]]);
  assert.equal(store.imported.size, 20);
});

test("incremental pass imports only what is new (plus the overlap window) and replay of committed pages is a no-op", async () => {
  const engine = new FakeEngine();
  seed(engine, 30);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 100, overlapSeconds: 0 });
  assert.equal(store.imported.size, 30);

  // two new entries crawled later
  const feed = engine.feeds[0]!;
  engine.addEntry({ id: usec(T0 + 5000n), feedId: feed.id, title: "New A", content: "a", link: "https://example.org/a" });
  engine.addEntry({ id: usec(T0 + 5100n), feedId: feed.id, title: "New B", content: "b", link: "https://example.org/b" });
  const second = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, pageSize: 100, overlapSeconds: 0 });
  // lower bound = newest seen second; the newest old entry is re-read (id >= bound) and absorbed as a duplicate
  assert.equal(second.entries, 3);
  assert.equal(second.accepted, 2);
  assert.equal(second.duplicates, 1);
  assert.equal(store.imported.size, 32);
});

test("an entry edited upstream (same id, new content, newer modified time) comes back and carries the new content", async () => {
  const engine = new FakeEngine();
  seed(engine, 10);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 100, overlapSeconds: 0 });
  const old = engine.entries[2]!;
  old.content = "<p>corrected</p>";
  old.title = "Entry 2 (corrected)";
  old.lastModified = Number(T0) + 99_999;
  const again = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, pageSize: 100, overlapSeconds: 0 });
  assert.ok(again.entries >= 2);
  const stored = store.imported.get(old.id.toString())!;
  assert.equal(stored.title, "Entry 2 (corrected)");
  assert.equal(stored.contentHtml, "<p>corrected</p>");
  assert.equal(stored.crawledAt, new Date(Number(old.id / 1000n)).toISOString(), "crawl time does not move on edit");
});

test("a late-arriving old article is a new engine entry with a new id and is found", async () => {
  const engine = new FakeEngine();
  seed(engine, 5);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, overlapSeconds: 0 });
  engine.addEntry({ id: usec(T0 + 10_000n), feedId: 1, title: "Published last year, found today", content: "late", link: "https://example.org/late", published: Number(T0) - 31_536_000 });
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, overlapSeconds: 0 });
  assert.equal([...store.imported.values()].some((e) => e.title.startsWith("Published last year")), true);
});

test("the overlap window re-reads entries that became visible after a newer one was already imported", async () => {
  const engine = new FakeEngine();
  seed(engine, 3);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, overlapSeconds: 600 });
  // engine stamped this id before the newest imported one but committed it afterwards
  const newest = engine.entries.at(-1)!.id;
  engine.addEntry({ id: newest - usec(30n), feedId: 1, title: "Committed late", content: "x", link: "https://example.org/c" });
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, overlapSeconds: 600 });
  assert.equal([...store.imported.values()].some((e) => e.title === "Committed late"), true);
});

test("crash between pages resumes from the stored continuation without gaps or duplicates of committed pages", async () => {
  const engine = new FakeEngine();
  seed(engine, 35);
  const store = productStore();
  let calls = 0;
  const crashing = async (b: SyncBatchDraft) => {
    calls += 1;
    if (calls === 3) throw new EngineError("network", "boom");
    return store.submit(b);
  };
  await assert.rejects(runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: crashing, pageSize: 10 }), /boom/);
  assert.equal(store.imported.size, 20);
  assert.notEqual(store.checkpoint.continuation, null);

  const resumed = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, pageSize: 10 });
  assert.equal(resumed.complete, true);
  assert.equal(store.imported.size, 35);
  assert.equal(resumed.duplicates, 0, "committed pages are not re-read");
});

test("submitting the same page twice carries the same idempotency key (replay is safe)", async () => {
  const engine = new FakeEngine();
  seed(engine, 12);
  const a = productStore();
  const b = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: a.submit, pageSize: 10 });
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: b.submit, pageSize: 10 });
  assert.deepEqual(a.batches.filter((x) => x.entries.length).map((x) => x.idempotencyKey), b.batches.filter((x) => x.entries.length).map((x) => x.idempotencyKey));
  // replaying into one store changes nothing
  const replay = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: a.submit, pageSize: 10 });
  assert.equal(replay.accepted, 0);
  assert.equal(a.imported.size, 12);
  // different content in the same position yields a different key
  engine.entries[0]!.content = "changed";
  const c = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: c.submit, pageSize: 10 });
  assert.notEqual(c.batches[0]!.idempotencyKey, a.batches[0]!.idempotencyKey);
  assert.ok(a.batches.every((x) => x.idempotencyKey.length >= 8 && x.idempotencyKey.length <= 200));
});

test("a checkpoint from a different engine is ignored and the history restarts", async () => {
  const engine = new FakeEngine();
  seed(engine, 6);
  const store = productStore();
  const summary = await runSync({
    client: asClient(engine),
    engineUserId: "eu1",
    engineIdentity: "freshrss:new",
    checkpoint: { continuation: usec(T0 + 120n).toString(), newestCrawlUsec: usec(T0 + 300n).toString(), engineIdentity: "freshrss:old" },
    submit: store.submit,
  });
  assert.equal(summary.identityChanged, true);
  assert.equal(store.imported.size, 6, "everything is offered again for the product to reconcile");
  assert.ok(store.batches.every((b) => b.engineIdentity === "freshrss:new"));
});

test("absence never produces anything but absence: entries purged in the engine are simply not offered", async () => {
  const engine = new FakeEngine();
  seed(engine, 10);
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, overlapSeconds: 0 });
  engine.entries.splice(0, 5); // retention purge
  engine.feeds.splice(0, 1); // subscription removed
  const before = store.imported.size;
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store.checkpoint, submit: store.submit, overlapSeconds: 0 });
  assert.equal(store.imported.size, before, "nothing is removed from the product's records");
  assert.ok(store.batches.every((b) => !("deleted" in b) && !("removed" in b)));
});

test("an empty up-to-date pass is still recorded once per pass", async () => {
  const engine = new FakeEngine();
  const store = productStore();
  const t = [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:05:00Z")];
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, now: () => t[0]! });
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, now: () => t[1]! });
  assert.equal(store.batches.length, 2);
  assert.notEqual(store.batches[0]!.idempotencyKey, store.batches[1]!.idempotencyKey);
  assert.equal(store.batches[0]!.done, true);
  assert.equal(store.batches[0]!.entries.length, 0);
});

test("a page larger than the byte budget is split; only the last part moves the checkpoint, and a crash between parts re-reads the page", async () => {
  const engine = new FakeEngine();
  engine.addFeed("https://example.org/feed.xml", "Example");
  const big = "x".repeat(4000);
  for (let i = 0; i < 9; i++) engine.addEntry({ id: usec(T0 + BigInt(i * 60), BigInt(i)), feedId: 1, title: `Big ${i}`, content: `<p>${big}</p>`, link: `https://example.org/${i}` });
  const store = productStore();
  const summary = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 9, maxBatchBytes: 10_000 });
  assert.equal(summary.complete, true);
  assert.equal(store.imported.size, 9);
  // 4000-byte entries: two per batch under a 10 000-byte budget → 5 parts for the first page, then the empty terminal page
  assert.deepEqual(store.batches.map((b) => b.entries.length), [2, 2, 2, 2, 1, 0]);
  const firstPage = store.batches.slice(0, 5);
  assert.ok(firstPage.slice(0, 4).every((b) => b.checkpoint.continuation === null && b.checkpoint.newestCrawlUsec === null), "intermediate parts keep the old checkpoint");
  assert.notEqual(firstPage[4]!.checkpoint.continuation, null, "the last part advances it");
  assert.ok(firstPage.every((b) => b.done === false));
  assert.equal(new Set(store.batches.map((b) => b.idempotencyKey)).size, store.batches.length, "every part has its own key");
  assert.equal(summary.pages, 2);
  assert.equal(summary.batches, 6);

  // crash after the second part: the stored checkpoint is still the page start, so the next run re-reads the whole page
  const store2 = productStore();
  let n = 0;
  const crashing = async (b: SyncBatchDraft) => {
    n += 1;
    if (n === 3) throw new EngineError("network", "boom");
    return store2.submit(b);
  };
  await assert.rejects(runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: crashing, pageSize: 9, maxBatchBytes: 10_000 }), /boom/);
  assert.equal(store2.imported.size, 4);
  assert.equal(store2.checkpoint.continuation, null);
  const resumed = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: store2.checkpoint, submit: store2.submit, pageSize: 9, maxBatchBytes: 10_000 });
  assert.equal(resumed.complete, true);
  assert.equal(store2.imported.size, 9, "nothing lost");
  assert.equal(resumed.accepted, 5);
  assert.equal(resumed.duplicates, 4, "the two parts committed before the crash replay as no-ops by key");
});

/** The request body the worker would post for a batch (the API reads and limits it in UTF-8 bytes). */
const bodyBytes = (b: SyncBatchDraft) => Buffer.byteLength(JSON.stringify({ leaseId: "lse_01m6nfz1a8kgj74t7m5kgbqbpx", ...b }), "utf8");

test("batches are sized in UTF-8 bytes: Arabic and CJK text takes two or three bytes a character", async () => {
  const engine = new FakeEngine();
  engine.addFeed("https://example.org/feed.xml", "Example");
  // 40 entries of 10 000 Arabic letters: about 10 000 UTF-16 units but 20 000 bytes each, 800 KB in all.
  const arabic = "ع".repeat(10_000);
  for (let i = 0; i < 40; i++) engine.addEntry({ id: usec(T0 + BigInt(i * 60), BigInt(i)), feedId: 1, title: `مقال ${i}`, content: `<p>${arabic}</p>`, link: `https://example.org/${i}` });
  const store = productStore();
  const cap = 300_000;
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 40, maxBatchBytes: cap });
  assert.equal(store.imported.size, 40, "every entry arrives");
  assert.ok(store.batches.length >= 3, "the page is split");
  for (const b of store.batches) assert.ok(bodyBytes(b) <= cap, `a batch of ${bodyBytes(b)} bytes is over the ${cap}-byte cap`);
  assert.ok([...store.imported.values()].every((e) => e.contentOmitted === undefined && e.contentHtml!.length > 10_000), "nothing was cut: they fit when split");
});

test("the default cap keeps a page of Arabic text under the API's body limit", async () => {
  const engine = new FakeEngine();
  engine.addFeed("https://example.org/feed.xml", "Example");
  for (let i = 0; i < 100; i++) engine.addEntry({ id: usec(T0 + BigInt(i * 60), BigInt(i)), feedId: 1, title: `مقال ${i}`, content: `<p>${"ع".repeat(7_000)}</p>`, link: `https://example.org/${i}` });
  const store = productStore();
  await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 100 });
  assert.equal(store.imported.size, 100);
  // The API's default request limit is 1 MB; the sync batch route allows more, but a batch stays under the worker's own cap.
  for (const b of store.batches) assert.ok(bodyBytes(b) <= 700_000, `${bodyBytes(b)} bytes`);
});

test("an entry that alone is over the cap keeps its details and summary, loses its full text, and says so", async () => {
  const engine = new FakeEngine();
  engine.addFeed("https://example.org/feed.xml", "Example");
  engine.addEntry({ id: usec(T0), feedId: 1, title: "small", content: "s", link: "https://example.org/s" });
  const long = `<p>First the <b>opening</b> &amp; its point.</p>${"<p>filler</p>".repeat(20_000)}`;
  engine.addEntry({ id: usec(T0 + 1n), feedId: 1, title: "huge", content: long, link: "https://example.org/h", author: "A. Writer", published: Number(T0) });
  engine.addEntry({ id: usec(T0 + 2n), feedId: 1, title: "small2", content: "s", link: "https://example.org/s2" });
  const store = productStore();
  const cap = 50_000;
  const summary = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, pageSize: 10, maxBatchBytes: cap });
  assert.equal(summary.complete, true);
  for (const b of store.batches) assert.ok(bodyBytes(b) <= cap, `a batch of ${bodyBytes(b)} bytes is over the ${cap}-byte cap`);
  const huge = [...store.imported.values()].find((e) => e.title === "huge")!;
  assert.equal(huge.contentOmitted, true);
  assert.equal(huge.contentHtml, null);
  assert.equal(huge.url, "https://example.org/h");
  assert.equal(huge.author, "A. Writer");
  assert.ok(huge.publishedAt && huge.crawledAt);
  assert.match(huge.summaryHtml!, /^<p>First the opening &amp; its point\./, "the summary is the start of the text, as safe HTML");
  assert.ok(huge.summaryHtml!.length < 2000);
  const small = [...store.imported.values()].filter((e) => e.title.startsWith("small"));
  assert.equal(small.length, 2);
  assert.ok(small.every((e) => e.contentOmitted === undefined), "only the entry that did not fit is marked");
});

test("a very large text in another script is cut to a short summary and the entry fits", async () => {
  const client = { streamContents: async () => ({ items: [{ id: "tag:google.com,2005:reader/item/0000000000000001", timestampUsec: "1", origin: { streamId: "feed/1" }, title: "t", summary: { content: `<p>${"ع".repeat(400_000)}</p>` }, canonical: [{ href: "https://example.org/x" }] }], continuation: null }) };
  const store = productStore();
  await runSync({ client, engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit: store.submit, maxBatchBytes: 100_000 });
  const only = [...store.imported.values()][0]!;
  assert.equal(only.contentOmitted, true);
  assert.equal(only.contentHtml, null);
  assert.ok(only.summaryHtml!.startsWith("<p>ععع") && only.summaryHtml!.length < 2000, "the start of the text, not all of it");
  assert.ok(store.batches.every((b) => bodyBytes(b) <= 100_000));
});

test("a stuck continuation is detected instead of looping forever", async () => {
  const stuck = { streamContents: async () => ({ items: [], continuation: "123" }) };
  const store = productStore();
  await assert.rejects(
    runSync({ client: stuck, engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: { continuation: "123", newestCrawlUsec: "1", engineIdentity: IDENTITY }, submit: store.submit }),
    (e: unknown) => e instanceof EngineError && e.kind === "protocol" && !e.retryable,
  );
});

test("aborting stops between pages and reports an incomplete run with the last committed checkpoint", async () => {
  const engine = new FakeEngine();
  seed(engine, 40);
  const store = productStore();
  const ac = new AbortController();
  const submit = async (b: SyncBatchDraft) => {
    const r = await store.submit(b);
    if (store.batches.length === 2) ac.abort();
    return r;
  };
  const summary = await runSync({ client: asClient(engine), engineUserId: "eu1", engineIdentity: IDENTITY, checkpoint: null, submit, pageSize: 10, signal: ac.signal });
  assert.equal(summary.complete, false);
  assert.equal(summary.pages, 2);
  assert.equal(summary.checkpoint.continuation, store.checkpoint.continuation);
});

function asClient(engine: FakeEngine) {
  return { streamContents: async (o: Parameters<FakeEngine["page"]>[0]) => engine.page(o) };
}
