import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../http.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { createBasket } from "./collections.ts";
import { getItemDetail, listItems } from "./items.ts";
import { keepLink, renameKeptLink } from "./links.ts";
import type { MetadataLookup } from "./links.ts";
import { applySyncBatch } from "./sync.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const basket = createBasket(app, p, { name: "Later", captureMode: "metadata" });
  return { app, p, basket, cleanup };
}

const video: MetadataLookup = async () => ({ kind: "video", title: "A Very Good Video", siteName: "YouTube", author: "The Channel", imageUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg" });

test("a kept link takes its title, picture and channel or site from the page", async (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  const seen: string[] = [];
  const out = await keepLink(app, p, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", basketId: basket.id }, async (u) => (seen.push(u), video(u)));
  assert.deepEqual(seen, ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  const item = listItems(app, p, { scope: `basket:${basket.id}` }).items.find((i) => i.id === out.itemId)!;
  assert.deepEqual([item.title, item.kind, item.author, item.imageUrl], ["A Very Good Video", "video", "The Channel", "https://i.ytimg.com/vi/x/hqdefault.jpg"]);
  assert.equal(item.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  const page = await keepLink(app, p, { url: "example.org/essay", basketId: basket.id }, async () => ({ kind: "link", title: "An Essay", siteName: "Example Times", author: null, imageUrl: null }));
  const link = getItemDetail(app, p, page.itemId);
  assert.deepEqual([link.title, link.kind, link.author, link.url], ["An Essay", "link", "Example Times", "https://example.org/essay"]);
});

test("the person's own title wins; a page that says nothing, fails or throws still keeps the address", async (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  const own = await keepLink(app, p, { url: "https://example.org/a", basketId: basket.id, title: "book a week ahead!" }, video);
  assert.equal(getItemDetail(app, p, own.itemId).title, "book a week ahead!");
  const none = await keepLink(app, p, { url: "https://www.example.org/news/story/", basketId: basket.id }, async () => null);
  assert.equal(getItemDetail(app, p, none.itemId).title, "www.example.org/news/story");
  const boom = await keepLink(app, p, { url: "https://example.org/b", basketId: basket.id }, async () => { throw new Error("network"); });
  assert.equal(getItemDetail(app, p, boom.itemId).title, "example.org/b");
  assert.equal(listItems(app, p, { scope: `basket:${basket.id}` }).total, 3);
});

test("a bad address or an unknown basket is refused before anything is fetched or saved", async (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  let asked = 0;
  const lookup: MetadataLookup = async () => (asked++, null);
  await assert.rejects(keepLink(app, p, { url: "javascript:alert(1)", basketId: basket.id }, lookup), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(keepLink(app, p, { url: "ftp://example.org/x", basketId: basket.id }, lookup), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(keepLink(app, p, { url: "https://example.org/x", basketId: "bsk_nope" }, lookup), (e: unknown) => e instanceof HttpError && e.status === 404);
  const other = makeOwner(app);
  await assert.rejects(keepLink(app, other, { url: "https://example.org/x", basketId: basket.id }, lookup), (e: unknown) => e instanceof HttpError && e.status === 404, "another account's basket");
  assert.equal(asked, 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM items")!.n, 0);
});

test("a link kept by hand can be renamed, and search follows; a followed source's titles and other accounts' items are out of reach", async (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  const kept = await keepLink(app, p, { url: "https://example.org/a", basketId: basket.id }, async () => ({ kind: "link", title: "Old name", siteName: null, author: null, imageUrl: null }));
  const renamed = renameKeptLink(app, p, kept.itemId, "  A name  I chose ");
  assert.equal(renamed.title, "A name I chose");
  assert.deepEqual(listItems(app, p, { scope: "all", q: "chose" }).items.map((i) => i.id), [kept.itemId]);
  assert.deepEqual(listItems(app, p, { scope: "all", q: "old" }).items, []);
  assert.throws(() => renameKeptLink(app, p, kept.itemId, "   "), (e: unknown) => e instanceof HttpError && e.status === 400);

  const src = makeSource(app, p, "Blog", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const fed = app.db.get<{ id: string }>("SELECT id FROM items WHERE source_id = ?", src)!;
  assert.throws(() => renameKeptLink(app, p, fed.id, "Mine"), (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === "not_renamable");
  const other = makeOwner(app);
  assert.throws(() => renameKeptLink(app, other, kept.itemId, "Theirs"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(getItemDetail(app, p, kept.itemId).title, "A name I chose");
});
