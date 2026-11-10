import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { listItems } from "./items.ts";
import { createBasket } from "./collections.ts";
import { keepItem } from "./state.ts";
import { listNotifications, runProblemCheck } from "./notifications.ts";
import { followSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { followSchema } from "@purss/domain";
import { completeCapture, failCapture, queueCapture, retryCapture } from "./captures.ts";
import { keepLink } from "./links.ts";

type Owner = Principal & { engineUserId: string };

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  return { app, p, cleanup };
}

/** n new items in a feed, newest last; returns their ids. They have no page of their own, so nothing queues a copy by itself: the failures are the ones the tests record. */
function items(app: App, p: Owner, source: string, stream: string, n: number): string[] {
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: n }, () => entry(stream, { url: null }))));
  return listItems(app, p, { scope: `source:${source}`, sort: "oldest" }).items.slice(-n).map((i) => i.id);
}

let attempt = 0;
/** A readable copy that failed at `at`. */
function failed(app: App, p: Owner, itemId: string, at: Date): string {
  const id = `cap_f${++attempt}`;
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'failed', 'x', ?, ?)",
    id, p.workspaceId, itemId, at.toISOString(), at.toISOString());
  return id;
}

const bell = (app: App, p: Owner) => listNotifications(app, p).filter((n) => n.kind === "system");
const NOW = new Date("2026-11-06T10:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

test("a source's failed texts are one named notification for the day that counts items, not attempts, and opens the failed items", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  // Marta's morning: a busy source with full articles on (three items fail), and two posts kept in a basket that keeps text, one of which was tried twice.
  const reddit = makeSource(app, p, "r/Genealogy", "feed/reddit");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", reddit);
  const blog = makeSource(app, p, "A family blog", "feed/blog");
  const basket = createBasket(app, p, { name: "Family history finds", captureMode: "text" }).id;
  const posts = items(app, p, reddit, "feed/reddit", 3);
  const kept = items(app, p, blog, "feed/blog", 2);
  for (const id of kept) keepItem(app, p, id, basket);

  failed(app, p, posts[0]!, minutes(-50));
  failed(app, p, kept[0]!, minutes(-45));
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, minutes(-40)), 2);
  failed(app, p, kept[0]!, minutes(-30)); // the same item again
  failed(app, p, posts[1]!, minutes(-20));
  failed(app, p, posts[2]!, minutes(-10));
  failed(app, p, kept[1]!, minutes(-5));
  runProblemCheck(app, p.workspaceId, p.accountId, NOW);

  const rows = bell(app, p);
  assert.deepEqual(rows.map((n) => n.title).sort(), ["Couldn't save the text of 2 items from A family blog", "Couldn't save the text of 3 items from r/Genealogy"],
    "one row per source, named, counting the five different items once each");
  const bySource = new Map(rows.map((n) => [n.sourceId, n]));
  assert.equal(bySource.get(reddit)!.listFilter, "capture-failed");
  assert.equal(bySource.get(blog)!.listFilter, "capture-failed");

  // What the row opens: that source, filtered to the items whose text failed.
  assert.deepEqual(listItems(app, p, { scope: `source:${reddit}`, capture: "failed" }).items.map((i) => i.id).sort(), [...posts].sort());
  assert.deepEqual(listItems(app, p, { scope: `source:${blog}`, capture: "failed" }).items.map((i) => i.id).sort(), [...kept].sort());
  assert.equal(listItems(app, p, { scope: "all", capture: "failed" }).items.length, 5);
});

test("a later failure the same day grows that day's notification and makes it unread; the next day is a new row", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Journal", "feed/1");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", src);
  const [a, b, c] = items(app, p, src, "feed/1", 3);
  failed(app, p, a!, minutes(-60));
  runProblemCheck(app, p.workspaceId, p.accountId, minutes(-50));
  assert.deepEqual(bell(app, p).map((n) => n.title), ["Couldn't save the text of 1 item from Journal"]);
  app.db.run("UPDATE notifications SET read_at = ?", NOW.toISOString());

  failed(app, p, b!, minutes(-30));
  runProblemCheck(app, p.workspaceId, p.accountId, minutes(-20));
  assert.deepEqual(bell(app, p).map((n) => [n.title, n.read]), [["Couldn't save the text of 2 items from Journal", false]], "the same row, grown and unread again");

  const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
  failed(app, p, c!, new Date(tomorrow.getTime() - 60_000));
  runProblemCheck(app, p.workspaceId, p.accountId, tomorrow);
  assert.deepEqual(bell(app, p).map((n) => n.title).sort(), ["Couldn't save the text of 1 item from Journal", "Couldn't save the text of 2 items from Journal"]);
});

test("only where the person turned text saving on: a source with full articles, or a basket that keeps text", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const plain = makeSource(app, p, "Plain", "feed/plain"); // full articles off
  const [loose, inMetadataBasket, inTextBasket] = items(app, p, plain, "feed/plain", 3);
  keepItem(app, p, inMetadataBasket!, createBasket(app, p, { name: "Links only", captureMode: "metadata" }).id);
  keepItem(app, p, inTextBasket!, createBasket(app, p, { name: "With text", captureMode: "text" }).id);
  // The text copies of the first two are not something this person asked for; nothing says so.
  failed(app, p, loose!, minutes(-10));
  failed(app, p, inMetadataBasket!, minutes(-10));
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, NOW), 0);
  assert.deepEqual(bell(app, p), []);

  failed(app, p, inTextBasket!, minutes(-5));
  runProblemCheck(app, p.workspaceId, p.accountId, NOW);
  assert.deepEqual(bell(app, p).map((n) => n.title), ["Couldn't save the text of 1 item from Plain"]);

  // Turned off again, a new failure on an item no text basket holds is not news.
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", plain);
  const [fresh] = items(app, p, plain, "feed/plain", 1);
  app.db.run("UPDATE sources SET full_text = 0 WHERE id = ?", plain);
  failed(app, p, fresh!, minutes(-1));
  runProblemCheck(app, p.workspaceId, p.accountId, minutes(1));
  assert.equal(bell(app, p)[0]!.title, "Couldn't save the text of 1 item from Plain");
});

test("an item that has a copy by now, or a muted source, is not news; kept links have no source to name", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Journal", "feed/1");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", src);
  const [recovered, stillFailed] = items(app, p, src, "feed/1", 2);
  failed(app, p, recovered!, minutes(-10));
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at, completed_at) VALUES ('cap_ok', ?, ?, 'fulltext', 'done', ?, ?)", p.workspaceId, recovered!, minutes(-5).toISOString(), minutes(-5).toISOString());
  failed(app, p, stillFailed!, minutes(-10));
  runProblemCheck(app, p.workspaceId, p.accountId, NOW);
  assert.deepEqual(bell(app, p).map((n) => n.title), ["Couldn't save the text of 1 item from Journal"], "the item that now has its text is left out");
  assert.deepEqual(listItems(app, p, { scope: "all", capture: "failed" }).items.map((i) => i.id), [stillFailed], "and is not in the filtered list either");

  const noisy = makeSource(app, p, "Noisy", "feed/noisy");
  app.db.run("UPDATE sources SET full_text = 1, notify = 'muted' WHERE id = ?", noisy);
  failed(app, p, items(app, p, noisy, "feed/noisy", 1)[0]!, minutes(-3));
  runProblemCheck(app, p.workspaceId, p.accountId, minutes(1));
  assert.equal(bell(app, p).length, 1, "a source set to muted never notifies");

});

test("a kept link has no feed to open: its notification names the basket and opens that, filtered to the failed ones", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const saved = makeSource(app, p, "Saved links", "manual/1", { kind: "manual" });
  const pages = createBasket(app, p, { name: "Pages", captureMode: "text" }).id;
  const [a, b] = items(app, p, saved, "manual/1", 2);
  for (const id of [a!, b!]) keepItem(app, p, id, pages);
  failed(app, p, a!, minutes(-5));
  failed(app, p, b!, minutes(-4));
  runProblemCheck(app, p.workspaceId, p.accountId, NOW);
  const row = bell(app, p).find((n) => n.listFilter === "capture-failed")!;
  assert.equal(row.title, "Couldn't save the text of 2 kept links in Pages");
  assert.equal(row.sourceId, null, "the Saved links source is not a page of its own");
  assert.equal(row.basketId, pages);
  assert.deepEqual(listItems(app, p, { scope: `basket:${row.basketId}`, capture: "failed" }).items.map((i) => i.id).sort(), [a, b].sort());

  // The same when the item has no source at all, or its source is no longer followed.
  const gone = makeSource(app, p, "Gone", "feed/gone");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", gone);
  const [c] = items(app, p, gone, "feed/gone", 1);
  const more = createBasket(app, p, { name: "More", captureMode: "text" }).id;
  keepItem(app, p, c!, more);
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", gone);
  failed(app, p, c!, minutes(-3));
  runProblemCheck(app, p.workspaceId, p.accountId, minutes(1));
  const unfollowed = bell(app, p).find((n) => n.basketId === more)!;
  assert.equal(unfollowed.title, "Couldn't save the text of 1 kept item in More");
  assert.equal(unfollowed.sourceId, null);
});

test("a readable copy asked for on one link counts, in a basket that keeps only the details; a source's setting being off does not", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Plain", "feed/plain"); // full articles off
  applySyncBatch(app, p.engineUserId, batch([entry("feed/plain", { url: "https://plain.example/a" }), entry("feed/plain", { url: "https://plain.example/b" })]));
  const [a, b] = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items.map((i) => i.id);
  const details = createBasket(app, p, { name: "Links only", captureMode: "metadata" }).id;
  // "Keep readable text too" on the link, in a basket that doesn't keep text by itself.
  const kept = await keepLink(app, p, { url: "https://plain.example/a", basketId: details, readableText: true }, async () => null);
  assert.equal(kept.captureQueued, true);
  const pending = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", a!)!.id;
  app.db.tx(() => failCapture(app, pending, "The page couldn't be captured."));
  // The same basket without the box ticked: no copy was asked for, and a failed one (made some other way) is not news.
  await keepLink(app, p, { url: "https://plain.example/b", basketId: details }, async () => null);
  failed(app, p, b!, minutes(-5));
  runProblemCheck(app, p.workspaceId, p.accountId, new Date(Date.now() + 60_000));
  assert.deepEqual(bell(app, p).map((n) => n.title), ["Couldn't save the text of 1 item from Plain"]);
});

test("a link of a private source is not fetched for its readable text, however it is kept", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const secret = makeSource(app, p, "Secret", "feed/secret", { isPrivate: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/secret", { url: "https://secret.example/post/1" })]));
  const item = listItems(app, p, { scope: `source:${secret}` }).items[0]!.id;
  const basket = createBasket(app, p, { name: "Mixed", captureMode: "metadata" }).id;
  const kept = await keepLink(app, p, { url: "https://secret.example/post/1", basketId: basket, readableText: true }, async () => null);
  assert.equal(kept.itemId, item);
  assert.equal(kept.captureQueued, false);
  assert.match(kept.captureNote ?? "", /private sources/);
  assert.equal(app.db.get("SELECT 1 FROM captures WHERE item_id = ?", item), undefined, "no copy was made");
  assert.equal(app.db.get("SELECT 1 FROM jobs WHERE kind = 'capture.fulltext'"), undefined, "and nothing is queued for the worker");
  assert.ok(app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", item), "the link itself is kept");
  // queueCapture itself refuses, so no other caller can bypass it.
  assert.equal(queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item, url: "https://secret.example/post/1" }), false);
});

test("following a source starts text saving only when it is asked for", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const candidate = (token: string, feedUrl: string) => holdCandidate(token, p.workspaceId, { feedUrl, siteUrl: "https://s.example/", title: feedUrl, kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: true, privateWarning: null });
  // A summaries-only feed, followed with the box left alone: the request carries no choice at all.
  candidate("dsc_a", "https://a.example/feed.xml");
  const left = followSource(app, p, followSchema.parse({ token: "dsc_a", collectionId: null, newCollectionName: null }));
  assert.equal(left.fullText, false);
  assert.equal(app.db.get<{ full_text: number }>("SELECT full_text FROM sources WHERE id = ?", left.id)!.full_text, 0);
  // Unticked is off, ticked is on.
  candidate("dsc_b", "https://b.example/feed.xml");
  assert.equal(followSource(app, p, followSchema.parse({ token: "dsc_b", collectionId: null, newCollectionName: null, fullText: false })).fullText, false);
  candidate("dsc_c", "https://c.example/feed.xml");
  const ticked = followSource(app, p, followSchema.parse({ token: "dsc_c", collectionId: null, newCollectionName: null, fullText: true }));
  assert.equal(ticked.fullText, true);
  assert.equal(app.db.get<{ full_text: number }>("SELECT full_text FROM sources WHERE id = ?", ticked.id)!.full_text, 1);
});

test("a try again that fails after a partial copy is told about and listed, like any failed copy", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Journal", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { url: "https://journal.example/a", summaryHtml: "<p>The journal's summary of the paper.</p>", contentHtml: null })]));
  const item = listItems(app, p, { scope: `source:${src}` }).items[0]!.id;
  // A copy that is only part of the page, from the person's own Keep; then they try again and the page can't be read.
  const basket = createBasket(app, p, { name: "Papers", captureMode: "text" }).id;
  keepItem(app, p, item, basket);
  const first = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", item)!.id;
  const wall = "Pour accéder à l’intégralité des contenus, nous vous invitons à vous identifier. Vous n’avez pas encore de compte ? Abonnez-vous";
  app.db.tx(() => completeCapture(app, first, { ok: true, title: "T", text: wall, html: `<p>${wall}</p>`, finalUrl: "https://journal.example/a", bytes: 300 }));
  assert.equal(app.db.get<{ quality: string }>("SELECT quality FROM captures WHERE id = ?", first)!.quality, "partial");
  retryCapture(app, p, item);
  const again = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", item)!.id;
  app.db.tx(() => failCapture(app, again, "The page couldn't be captured."));

  runProblemCheck(app, p.workspaceId, p.accountId, new Date(Date.now() + 1000));
  assert.deepEqual(bell(app, p).map((n) => n.title), ["Couldn't save the text of 1 item from Journal"]);
  assert.deepEqual(listItems(app, p, { scope: `source:${src}`, capture: "failed" }).items.map((i) => i.id), [item]);
  // An item that only has a partial copy, and nothing failed, is neither.
  const other = createBasket(app, p, { name: "More", captureMode: "text" }).id;
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { url: "https://journal.example/b" })]));
  const second = listItems(app, p, { scope: `source:${src}`, sort: "newest" }).items[0]!.id;
  keepItem(app, p, second, other);
  const cap2 = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", second)!.id;
  app.db.tx(() => completeCapture(app, cap2, { ok: true, title: "T", text: wall, html: `<p>${wall}</p>`, finalUrl: "https://journal.example/b", bytes: 300 }));
  assert.deepEqual(listItems(app, p, { scope: `source:${src}`, capture: "failed" }).items.map((i) => i.id), [item]);
});
