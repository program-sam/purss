import test from "node:test";
import assert from "node:assert/strict";
import { itemPath } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { publicRouter } from "../routes/public.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem, itemIdByNumber } from "./items.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { deleteItemNow } from "./item-store.ts";

/*
 * An item's number names it in its short link, /app/i/<number>. Numbers count per account, are never given
 * twice (deleting an item doesn't free its number), and survive an export restored into a new account.
 */

function arrive(app: App, p: Principal & { engineUserId: string }, stream: string, n: number): string[] {
  makeSource(app, p, `Source ${stream}`, stream);
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: n }, () => entry(stream))));
  return app.db.all<{ id: string }>("SELECT id FROM items WHERE account_id = ? ORDER BY seq", p.accountId).map((r) => r.id);
}
const numbers = (app: App, p: Principal) =>
  app.db.all<{ number: number }>("SELECT number FROM items WHERE account_id = ? ORDER BY seq", p.accountId).map((r) => r.number);

test("items are numbered 1, 2, 3… per account, and the number is in the item and its short link", (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted" });
  t.after(cleanup);
  const p = makeOwner(app);
  const q = makeOwner(app);
  const mine = arrive(app, p, "feed/p", 3);
  arrive(app, q, "feed/q", 2);
  assert.deepEqual(numbers(app, p), [1, 2, 3]);
  assert.deepEqual(numbers(app, q), [1, 2], "another account counts on its own");
  assert.equal(getItem(app, p, mine[2]!).number, 3);
  assert.equal(itemPath(3), "/app/i/3");
});

test("a deleted item's number is never given again, not even when it was the newest", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const ids = arrive(app, p, "feed/a", 3);
  app.db.tx(() => { deleteItemNow(app, p, ids[2]!); });
  assert.throws(() => itemIdByNumber(app, p, 3), /isn't|not/i, "the deleted item's number names nothing");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/a")]));
  assert.deepEqual(numbers(app, p), [1, 2, 4]);
  assert.throws(() => itemIdByNumber(app, p, 3), /isn't|not/i, "and still names nothing after a new item arrived");
});

test("GET /api/items/number/:number finds the item in the signed-in account only", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted" });
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await server.close(); cleanup(); });
  const p = makeOwner(app);
  const q = makeOwner(app);
  const mine = arrive(app, p, "feed/p", 2);
  const s = signIn(app, p.accountId);
  const found = await call(app, server.base, "GET", "/api/items/number/2", s);
  assert.equal(found.status, 200);
  assert.deepEqual(found.json, { id: mine[1] });
  assert.equal((await call(app, server.base, "GET", "/api/items/number/3", s)).status, 404, "a number not given yet");
  assert.equal((await call(app, server.base, "GET", "/api/items/number/2", signIn(app, q.accountId))).status, 404, "another account's item number names nothing for this one");
  for (const bad of ["0", "02", "1e3", "-1", "x", "1234567890123456"]) {
    assert.equal((await call(app, server.base, "GET", `/api/items/number/${bad}`, s)).status, 400, bad);
  }
});

async function exported(app: App, p: Principal): Promise<unknown> {
  const parts: string[] = [];
  await streamExport(app, p, (c) => { parts.push(c); });
  return JSON.parse(parts.join(""));
}

test("restoring an export into a new account keeps every item's number; the next item continues after them", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allowanceBytes: null });
  const ids = arrive(app, p, "feed/a", 4);
  app.db.tx(() => { deleteItemNow(app, p, ids[1]!); });
  const doc = await exported(app, p) as { items: { id: string; number: number }[] };
  assert.deepEqual(doc.items.map((i) => i.number), [1, 3, 4], "the export carries the numbers");

  const { app: second, cleanup: cleanupSecond } = makeTestApp();
  t.after(cleanupSecond);
  const q = makeOwner(second, { allowanceBytes: null });
  applyImport(second, q, stageImport(second, q, doc).token);
  const titles = (a: App, w: Principal) => a.db.all<{ number: number; title: string }>("SELECT number, title FROM items WHERE account_id = ? ORDER BY number", w.accountId).map((r) => ({ ...r }));
  assert.deepEqual(titles(second, q), titles(app, p), "each item has its number from before");
  makeSource(second, q, "Later", "feed/later");
  applySyncBatch(second, q.engineUserId, batch([entry("feed/later")]));
  assert.equal(second.db.get<{ n: number }>("SELECT MAX(number) AS n FROM items WHERE account_id = ?", q.accountId)!.n, 5);
});

test("importing into a account that already gave those numbers gives the imported items new ones", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted" });
  t.after(cleanup);
  const p = makeOwner(app, { allowanceBytes: null });
  arrive(app, p, "feed/a", 3);
  const doc = await exported(app, p);
  const q = makeOwner(app, { allowanceBytes: null });
  const theirs = arrive(app, q, "feed/b", 2);
  app.db.tx(() => { deleteItemNow(app, q, theirs[1]!); }); // number 2 was given and must not come back
  applyImport(app, q, stageImport(app, q, doc).token);
  const got = numbers(app, q);
  assert.equal(got.length, 4);
  assert.deepEqual([...got].sort((a, b) => a - b), [1, 3, 4, 5], "no number twice, and the deleted item's 2 stays unused");
  assert.equal(got[3], 3, "3 was never given here, so the item that had it keeps it; the items whose numbers were given get the next ones");
});
