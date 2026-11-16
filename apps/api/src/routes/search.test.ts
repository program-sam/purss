import test from "node:test";
import assert from "node:assert/strict";
import type { SearchResult } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "../services/sync.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { publicRouter } from "./public.ts";

async function boot(matches: number) {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { admin: false });
  makeSource(app, owner, "Tides", "feed/tides");
  applySyncBatch(app, owner.engineUserId, batch(Array.from({ length: matches }, (_, i) => entry("feed/tides", {
    title: `Tide table ${i + 1}`, summaryHtml: `<p>Low water at ${i + 1}.</p>`, publishedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }))));
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, session: signIn(app, owner.accountId), server, close: async () => { await server.close(); cleanup(); } };
}
const search = async (b: Awaited<ReturnType<typeof boot>>, query: string) => {
  const r = await call(b.app, b.server.base, "GET", `/api/search?${query}`, b.session);
  assert.equal(r.status, 200, r.text);
  return r.json as SearchResult;
};

test("a search answers with the first 8 items and says there are more; asking for more returns them, to a ceiling of 100", async (t) => {
  const b = await boot(120);
  t.after(b.close);
  const first = await search(b, "q=tide");
  assert.equal(first.items.length, 8, "the search box starts with a few");
  assert.equal(first.hasMore, true);
  const more = await search(b, "q=tide&limit=24");
  assert.equal(more.items.length, 24);
  assert.equal(more.hasMore, true);
  assert.deepEqual(more.items.slice(0, 8).map((i) => i.id), first.items.map((i) => i.id), "the first answer's items stay where they were");
  const most = await search(b, "q=tide&limit=100000");
  assert.equal(most.items.length, 100, "a huge limit is capped at 100, not refused");
  assert.equal(most.hasMore, true, "and there are still more than that");
  assert.equal(new Set(most.items.map((i) => i.id)).size, 100, "none twice");
});

test("when every match fits in what was asked for, there is nothing more", async (t) => {
  const b = await boot(30);
  t.after(b.close);
  const all = await search(b, "q=tide&limit=100");
  assert.equal(all.items.length, 30);
  assert.equal(all.hasMore, false);
  const exact = await search(b, "q=tide&limit=30");
  assert.deepEqual([exact.items.length, exact.hasMore], [30, false], "asking for exactly as many as there are");
  assert.deepEqual([(await search(b, "q=tide&limit=29")).items.length, (await search(b, "q=tide&limit=29")).hasMore], [29, true]);
});

test("what is asked for is kept within bounds, and a few matches say there are no more", async (t) => {
  const b = await boot(3);
  t.after(b.close);
  assert.equal((await search(b, "q=tide")).hasMore, false);
  assert.equal((await search(b, "q=tide&limit=0")).items.length, 3, "nonsense falls back to the first answer's size");
  assert.equal((await search(b, "q=tide&limit=abc")).items.length, 3);
  assert.equal((await search(b, "q=tide&limit=1")).items.length, 1);
  assert.equal((await search(b, "q=tide&limit=1")).hasMore, true);
  const none = await search(b, "q=");
  assert.deepEqual([none.items.length, none.hasMore], [0, false]);
});
