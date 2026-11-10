import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeIcon } from "@purss/connectors/image";
import assert from "node:assert/strict";
import type { App } from "../app.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { createBasket } from "./collections.ts";
import { getItemDetail, insertItem, listItems } from "./items.ts";
import { changeState, keepItem } from "./state.ts";
import { reconcile } from "./storage.ts";
import { completeIconCheck, readIcon, scheduleIconChecks } from "./icons.ts";
import { discoverSources, followSource, getSource, patchSource, unfollowSource } from "./sources.ts";
import { NEWS_INITIAL_POSTS, NEWS_TITLE, createNewsPost, deleteNewsPost, deliverNews, newsAdmin, renderNewsAtom, renderNewsBody, updateNewsPost } from "./news.ts";

type Owner = ReturnType<typeof makeOwner>;
const newsSource = (app: App, p: Owner) => app.db.get<{ id: string; followed: number }>("SELECT id, followed FROM sources WHERE workspace_id = ? AND builtin = 'news'", p.workspaceId);
const copies = (app: App, p: Owner) => listItems(app, p, { scope: "all" }).items.filter((i) => i.sourceTitle === NEWS_TITLE);
const publish = (app: App, admin: Owner, title: string, body = `About ${title}.`) => createNewsPost(app, admin, { title, body, publish: true });
const follow = { collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false, fullText: false };

test("no PURSS gets a news source before anything is published; then every PURSS, new ones included, gets it", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  createNewsPost(app, admin, { title: "Draft", body: "Not yet.", publish: false });
  deliverNews(app);
  assert.equal(newsSource(app, reader), undefined, "a draft reaches nobody, and no empty source appears");

  const post = publish(app, admin, "Hello");
  for (const p of [admin, reader]) {
    const items = copies(app, p);
    assert.deepEqual(items.map((i) => i.title), ["Hello"], "the post is in every PURSS");
    assert.equal(items[0]!.fresh, true, "as New");
    assert.equal(items[0]!.url, `${app.config.publicOrigin}/news/${post.id}`);
  }
  const s = getSource(app, reader, newsSource(app, reader)!.id);
  assert.equal(s.health, "ok", "it never waits for the engine");
  assert.equal(s.fullTextAvailable, false);
  assert.equal(app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe'"), undefined, "the engine is not asked to fetch it");

  for (let i = 0; i < NEWS_INITIAL_POSTS + 1; i++) publish(app, admin, `Update ${i}`);
  const late = makeOwner(app, { admin: false });
  assert.equal(copies(app, late).length, NEWS_INITIAL_POSTS, "someone joining later gets the newest few");
  assert.equal(copies(app, reader).length, NEWS_INITIAL_POSTS + 2, "the others got each one");
  deliverNews(app);
  assert.equal(copies(app, reader).length, NEWS_INITIAL_POSTS + 2, "and a later pass delivers nothing twice");
});

test("an unfollowed news source stays unfollowed; following its address again takes it up without the engine", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  publish(app, admin, "First");
  const id = newsSource(app, reader)!.id;
  unfollowSource(app, reader, id);
  publish(app, admin, "Second");
  deliverNews(app);
  assert.equal(newsSource(app, reader)!.followed, 0, "not added back");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND source_id = ?", reader.workspaceId, id)!.n, 1, "and nothing new arrives");

  // Pasting the news address finds it without a fetch (the engine and discovery never fetch this server's own address).
  const found = await discoverSources(app, reader, `${app.config.publicOrigin}/news`);
  assert.ok(found.ok);
  const again = followSource(app, reader, { ...follow, token: found.candidates[0]!.token });
  assert.equal(again.id, id, "the same source");
  assert.deepEqual(copies(app, reader).map((i) => i.title).sort(), ["First", "Second"], "and it catches up");
  assert.equal(app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe'"), undefined);
});

test("a paused news source or a full account catches up later; nothing fails", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  publish(app, admin, "First");
  patchSource(app, reader, newsSource(app, reader)!.id, { paused: true });
  const full = makeOwner(app, { admin: false, allocationBytes: 1 });
  publish(app, admin, "Second");
  assert.deepEqual(copies(app, reader).map((i) => i.title), ["First"], "paused: nothing new");
  assert.equal(copies(app, full).length, 0, "a full account gets nothing");
  assert.equal(app.db.get<{ paused_reason: string }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", full.accountId)!.paused_reason, "quota");
  patchSource(app, reader, newsSource(app, reader)!.id, { paused: false });
  deliverNews(app);
  assert.deepEqual(copies(app, reader).map((i) => i.title).sort(), ["First", "Second"], "resumed: it catches up");
  app.db.run("UPDATE storage_accounts SET allocation_bytes = NULL, paused_reason = NULL WHERE account_id = ?", full.accountId);
  deliverNews(app);
  assert.deepEqual(copies(app, full).map((i) => i.title).sort(), ["First", "Second"], "with room again, the full account gets what it missed, its first posts included");
});

test("a copy the PURSS already has (brought back by an import) is recorded, not added twice", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  publish(app, admin, "First");
  const source = newsSource(app, reader)!.id;
  patchSource(app, reader, source, { paused: true });
  const post = publish(app, admin, "Second");
  const imported = insertItem(app, {
    accountId: reader.accountId, workspaceId: reader.workspaceId, sourceId: source, kind: "article", title: "Second", url: post.url, author: null,
    summaryHtml: null, contentHtml: "<p>About Second.</p>", imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: post.publishedAt, discoveredAt: post.publishedAt!, enclosures: [], fresh: true, reason: "test import",
  }).id;
  patchSource(app, reader, source, { paused: false });
  deliverNews(app);
  assert.deepEqual(copies(app, reader).map((i) => i.title).sort(), ["First", "Second"]);
  assert.equal(app.db.get<{ item_id: string }>("SELECT item_id FROM news_deliveries WHERE post_id = ? AND workspace_id = ?", post.id, reader.workspaceId)!.item_id, imported);
});

test("editing a published post changes every copy, except the version someone kept; deleting it leaves only kept copies", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  const keeper = makeOwner(app, { admin: false });
  const post = publish(app, admin, "Typo", "Teh text.");
  const kept = copies(app, keeper)[0]!;
  const basket = createBasket(app, keeper, { name: "Keep", captureMode: "metadata" });
  keepItem(app, keeper, kept.id, basket.id);
  const pinned = app.db.get<{ version_id: string }>("SELECT version_id FROM basket_items WHERE item_id = ?", kept.id)!.version_id;

  updateNewsPost(app, admin, post.id, { title: "Fixed", body: "The text.", publish: false });
  assert.equal(copies(app, reader)[0]!.title, "Fixed");
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM news_posts WHERE id = ?", post.id)!.status, "published", "an edit doesn't take a post back");
  assert.ok(app.db.get("SELECT 1 FROM item_versions WHERE id = ?", pinned), "the kept version stays");

  const out = deleteNewsPost(app, admin, post.id);
  assert.deepEqual(out, { removedCopies: 2, keptCopies: 1 });
  assert.equal(copies(app, reader).length, 0);
  assert.equal(listItems(app, keeper, { scope: `basket:${basket.id}` }).total, 1, "the kept copy is theirs");
  for (const p of [admin, reader, keeper]) assert.equal(reconcile(app, p.accountId).difference, 0, "storage stays counted right");
  assert.ok(renderNewsAtom(app).includes("</feed>") && !renderNewsAtom(app).includes("Fixed"), "it leaves the feed");
});

test("statistics count copies read, kept, ignored and deleted, never who", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const [a, b, c] = [makeOwner(app, { admin: false }), makeOwner(app, { admin: false }), makeOwner(app, { admin: false })];
  const post = publish(app, admin, "Hello");
  const item = (p: Owner) => copies(app, p)[0]!;
  changeState(app, a, item(a).id, { opened: true, expectedRevision: item(a).revision });
  changeState(app, b, item(b).id, { workflow: "ignored", expectedRevision: item(b).revision });
  unfollowSource(app, c, newsSource(app, c)!.id, { deleteUnkept: true });
  const d = newsAdmin(app);
  assert.deepEqual(d.audience, { following: 3, unfollowed: 1 });
  assert.deepEqual(d.posts.find((p) => p.id === post.id)!.stats, { delivered: 4, read: 1, kept: 0, ignored: 1, removed: 1 });
  assert.equal(JSON.stringify(d).includes(a.accountId), false);
});

test("the body's simple markup becomes safe HTML", () => {
  assert.equal(renderNewsBody("Hi <b>there</b>\nline two\n\n- one\n- **two**"), "<p>Hi &lt;b&gt;there&lt;/b&gt;<br>line two</p>\n<ul><li>one</li><li><strong>two</strong></li></ul>");
  assert.equal(renderNewsBody("See [the guide](https://example.org/a?b=1&c=2) or https://example.org/x."),
    `<p>See <a href="https://example.org/a?b=1&amp;c=2">the guide</a> or <a href="https://example.org/x">https://example.org/x</a>.</p>`);
  assert.equal(renderNewsBody("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>", "only web addresses become links");
  assert.equal(renderNewsBody(`[a" onmouseover="x](https://e.org/)`), `<p><a href="https://e.org/">a&quot; onmouseover=&quot;x</a></p>`);
});

test("an edit a full account couldn't take reaches its copy once it has room; a post never reads as a summary", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  const post = publish(app, admin, "Short", "Brief.");
  assert.equal(getItemDetail(app, reader, copies(app, reader)[0]!.id).summaryOnly, false, "a short post is the whole post");
  app.db.run("UPDATE storage_accounts SET allocation_bytes = 1 WHERE account_id = ?", reader.accountId);
  updateNewsPost(app, admin, post.id, { title: "Longer", body: "A longer text this time.", publish: false });
  assert.equal(copies(app, reader)[0]!.title, "Short", "no room: the copy waits");
  deliverNews(app);
  assert.equal(copies(app, reader)[0]!.title, "Short", "and keeps waiting while the account is full");
  app.db.run("UPDATE storage_accounts SET allocation_bytes = NULL, paused_reason = NULL WHERE account_id = ?", reader.accountId);
  deliverNews(app);
  assert.equal(copies(app, reader)[0]!.title, "Longer", "with room again it is brought up to date");
  assert.equal(copies(app, admin)[0]!.title, "Longer");
  assert.equal(reconcile(app, reader.accountId).difference, 0);
});

test("the news source shows the app's own icon, which no icon lookup replaces", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app);
  const reader = makeOwner(app, { admin: false });
  publish(app, admin, "Hello");
  const id = newsSource(app, reader)!.id;
  const icon = getSource(app, reader, id).iconUrl;
  assert.ok(icon, "it has an icon from the start");
  const shipped = readFileSync(new URL("./news-icon.webp", import.meta.url));
  assert.deepEqual(Buffer.from(readIcon(app, reader, id).bytes), shipped);

  scheduleIconChecks(app);
  assert.equal(app.db.get("SELECT 1 FROM jobs WHERE kind = 'source.icon' AND idempotency_key = ?", `icon:${id}`), undefined, "the worker is never asked to look for one");
  const other = (await normalizeIcon(readFileSync(new URL("../../../web/public/apple-touch-icon.png", import.meta.url)))) as { ok: true; data: Buffer };
  completeIconCheck(app, id, { found: true, data: other.data.toString("base64"), from: "https://example.org/favicon.ico" });
  assert.deepEqual(Buffer.from(readIcon(app, reader, id).bytes), shipped, "and an answer that arrives anyway doesn't replace it");

  // A source made before the icon changed gets the new one on the next pass.
  app.db.run("UPDATE source_icons SET digest = 'old' WHERE source_id = ?", id);
  deliverNews(app);
  assert.equal(app.db.get<{ digest: string }>("SELECT digest FROM source_icons WHERE source_id = ?", id)!.digest === "old", false);
  assert.equal(getSource(app, reader, id).iconUrl, icon);
});

test("the shipped news icon is the app icon, encoded as the worker encodes source icons", async () => {
  const fresh = await normalizeIcon(readFileSync(new URL("../../../web/public/icon-512.png", import.meta.url)));
  assert.ok(fresh.ok);
  // When the app icon changes: write `fresh.data` to apps/api/src/services/news-icon.webp.
  assert.deepEqual(readFileSync(new URL("./news-icon.webp", import.meta.url)), fresh.data, "news-icon.webp no longer matches apps/web/public/icon-512.png");
});
