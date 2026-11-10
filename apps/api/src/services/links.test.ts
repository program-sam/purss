import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { createBasket } from "./collections.ts";
import { keepLink, lookupUrl, underSite } from "./links.ts";

/** Tests here don't ask pages about themselves. */
const noLookup = async () => null;
import { keepItem } from "./state.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app);
  const other = makeOwner(app, { admin: false });
  return { app, owner, other, cleanup };
}
const count = (app: ReturnType<typeof setup>["app"], sql: string, ...args: string[]) => app.db.get<{ n: number }>(sql, ...args)!.n;

test("keeping a page the PURSS already has keeps that item instead of making a duplicate", async (t) => {
  const { app, owner, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, owner, "Sediment Letters", "feed/1");
  applySyncBatch(app, owner.engineUserId, batch([entry("feed/1", { url: "http://example.org/post/7", title: "Tidal flats" })]));
  const feedItem = app.db.get<{ id: string }>("SELECT id FROM items WHERE source_id = ?", src)!.id;
  const reading = createBasket(app, owner, { name: "Reading", captureMode: "metadata" }).id;
  const later = createBasket(app, owner, { name: "Later", captureMode: "metadata" }).id;

  const first = (await keepLink(app, owner, { url: "https://Example.org/post/7/?utm_source=newsletter#comments", basketId: reading }, noLookup));
  assert.deepEqual([first.itemId, first.existing, first.alreadyInBasket], [feedItem, true, false], "the feed item is kept, not a new link");
  const again = (await keepLink(app, owner, { url: "example.org/post/7", basketId: reading }, noLookup));
  assert.deepEqual([again.itemId, again.existing, again.alreadyInBasket], [feedItem, true, true]);
  const elsewhere = (await keepLink(app, owner, { url: "https://example.org/post/7", basketId: later }, noLookup));
  assert.equal(elsewhere.itemId, feedItem);
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?", owner.workspaceId), 1, "still one item");
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM basket_items WHERE item_id = ?", feedItem), 2, "in both baskets");

  // A new page becomes a saved link, and keeping it again finds it.
  const fresh = (await keepLink(app, owner, { url: "https://example.org/other", basketId: later, title: "Other" }, noLookup));
  assert.equal(fresh.existing, false);
  assert.equal((await keepLink(app, owner, { url: "https://example.org/other/", basketId: reading }, noLookup)).itemId, fresh.itemId);
  // Different query parameters are a different page.
  assert.notEqual((await keepLink(app, owner, { url: "https://example.org/other?page=2", basketId: reading }, noLookup)).itemId, fresh.itemId);
});

test("a kept copy is preferred when the PURSS has the page more than once", async (t) => {
  const { app, owner, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, owner, "One", "feed/1");
  makeSource(app, owner, "Two", "feed/2");
  applySyncBatch(app, owner.engineUserId, batch([entry("feed/1", { url: "https://example.org/shared" }), entry("feed/2", { url: "https://example.org/shared" })]));
  const ids = app.db.all<{ id: string }>("SELECT id FROM items ORDER BY seq").map((r) => r.id);
  assert.equal(lookupUrl(app, owner, "https://example.org/shared").item?.id, ids[0], "the oldest when none is kept");
  const basket = createBasket(app, owner, { name: "Reading", captureMode: "metadata" }).id;
  keepItem(app, owner, ids[1]!, basket);
  assert.equal(lookupUrl(app, owner, "https://example.org/shared").item?.id, ids[1], "the kept one");
  assert.equal((await keepLink(app, owner, { url: "https://example.org/shared", basketId: basket }, noLookup)).alreadyInBasket, true);
});

test("lookup reports the item, its baskets and state, and followed sources whose site contains the page", async (t) => {
  const { app, owner, other, cleanup } = setup();
  t.after(cleanup);
  const basket = createBasket(app, owner, { name: "Reading", captureMode: "metadata" }).id;
  const kept = (await keepLink(app, owner, { url: "https://blog.example/notes/1", basketId: basket, title: "Note one" }, noLookup));
  const src = makeSource(app, owner, "Blog notes", "feed/9");
  app.db.run("UPDATE sources SET site_url = 'https://www.blog.example/notes/' WHERE id = ?", src);
  const root = makeSource(app, owner, "Elsewhere", "feed/10");
  app.db.run("UPDATE sources SET site_url = 'https://elsewhere.example' WHERE id = ?", root);

  const hit = lookupUrl(app, owner, "http://blog.example/notes/1#x");
  assert.equal(hit.item?.id, kept.itemId);
  assert.equal(hit.item?.title, "Note one");
  assert.equal(hit.item?.workflow, "new");
  assert.deepEqual(hit.item?.baskets, [{ id: basket, name: "Reading" }]);
  assert.deepEqual(hit.followedSources, [{ id: src, title: "Blog notes" }]);

  const miss = lookupUrl(app, owner, "https://blog.example/other/2");
  assert.equal(miss.item, null);
  assert.deepEqual(miss.followedSources, [], "a different path on the same site isn't claimed");
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", src);
  assert.deepEqual(lookupUrl(app, owner, "https://blog.example/notes/1").followedSources, [], "unfollowed sources don't count");

  // Another account with the same page and site sees only its own.
  assert.deepEqual(lookupUrl(app, other, "https://blog.example/notes/1"), { item: null, followedSources: [] });
  assert.throws(() => lookupUrl(app, owner, "ftp://blog.example/x"), /Only web addresses/);
});

test("keeping cannot reach another account's items or baskets", async (t) => {
  const { app, owner, other, cleanup } = setup();
  t.after(cleanup);
  const mine = createBasket(app, owner, { name: "Mine", captureMode: "metadata" }).id;
  const theirs = createBasket(app, other, { name: "Theirs", captureMode: "metadata" }).id;
  const theirItem = (await keepLink(app, other, { url: "https://example.org/a", basketId: theirs }, noLookup)).itemId;
  const out = (await keepLink(app, owner, { url: "https://example.org/a", basketId: mine }, noLookup));
  assert.equal(out.existing, false, "their copy isn't found");
  assert.notEqual(out.itemId, theirItem);
  await assert.rejects(keepLink(app, owner, { url: "https://example.org/a", basketId: theirs }, noLookup), /doesn't exist or isn't yours/);
  await assert.rejects(keepLink(app, owner, { url: "https://example.org/b", basketId: theirs }, noLookup), /doesn't exist or isn't yours/);
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND url_key = 'example.org/b'", owner.workspaceId), 0, "a refused keep leaves nothing behind");
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM basket_items WHERE basket_id = ?", theirs), 1);
});

test("an upstream edit that changes an item's address updates its key", async (t) => {
  const { app, owner, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, owner, "One", "feed/1");
  const e = entry("feed/1", { url: "https://example.org/draft" });
  applySyncBatch(app, owner.engineUserId, batch([e]));
  applySyncBatch(app, owner.engineUserId, batch([{ ...e, url: "https://example.org/final", title: "Final title" }]));
  assert.ok(lookupUrl(app, owner, "https://example.org/final").item);
  assert.equal(lookupUrl(app, owner, "https://example.org/draft").item, null);
});

test("a site address matches pages under its path only", () => {
  const page = new URL("https://www.example.org/blog/2026/post");
  assert.ok(underSite(page, "https://example.org"));
  assert.ok(underSite(page, "http://example.org/blog/"));
  assert.ok(!underSite(page, "https://example.org/blo"));
  assert.ok(!underSite(page, "https://example.org/news"));
  assert.ok(!underSite(page, "https://sub.example.org/"));
  assert.ok(!underSite(page, "not a url"));
  assert.ok(!underSite(new URL("https://www.youtube.com/watch?v=1"), "https://www.youtube.com/channel/UC123"), "a channel doesn't claim every video");
});
