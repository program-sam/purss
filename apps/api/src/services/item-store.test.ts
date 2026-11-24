import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { basketDeletePreview, createBasket, deleteBasket } from "./collections.ts";
import { deleteItemNow } from "./item-store.ts";
import { keepLink, keepWithBrowserCapture } from "./links.ts";
import { keepItem, unkeepItem } from "./state.ts";
import { putAnnotation } from "./annotations.ts";
import { savePlayback } from "./media.ts";
import { setItemReminder } from "./item-reminders.ts";
import { setShareNote } from "./shares.ts";
import { shareRow } from "../features-testing.ts";
import { createNewsPost, deleteNewsPost, updateNewsPost } from "./news.ts";
import { NO_TITLE, excerpt, readMinutes, toText } from "./content.ts";
import { nowIso } from "../http.ts";
import { newId } from "@purss/domain";
import { foldForSearch } from "./search-text.ts";
import { linkKey, urlKey } from "./url-key.ts";
import { reconcile } from "./storage.ts";
import { getItemDetail } from "./items.ts";
import { completeCapture, queueCapture, stepCaptureCheck } from "./captures.ts";

/*
 * The item store: whichever way an item is made, revised or removed (an engine sync, an archive import, a news post, a link kept
 * by hand, a deletion), the row, its derived columns, its search entry and the storage ledger agree. Each test ends in
 * `assertStoreConsistent`, which recomputes everything from the item's current version.
 */

type ItemRow = {
  seq: number; id: string; kind: string; title: string; url: string | null; url_key: string | null; link_key: string | null; author: string | null; excerpt: string | null;
  read_minutes: number | null; source_id: string | null; source_title: string; current_version_id: string | null; image_url: string | null;
  v_title: string; v_url: string | null; summary_html: string | null; content_html: string | null;
};

/** The words the search index holds for an item, by column (the index keeps no text, so they are read from its vocabulary). */
function indexedWords(app: App, seq: number): Record<"title" | "excerpt" | "author" | "body", string[]> {
  const out: Record<string, Set<string>> = { title: new Set(), excerpt: new Set(), author: new Set(), body: new Set() };
  for (const r of app.db.all<{ term: string; col: string }>("SELECT term, col FROM temp.items_vocab WHERE doc = ?", seq)) out[r.col]!.add(r.term);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()])) as Record<"title" | "excerpt" | "author" | "body", string[]>;
}
const wordsOf = (text: string): string[] => [...new Set(foldForSearch(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort();

function assertStoreConsistent(app: App, accountId: string): number {
  app.db.exec("DROP TABLE IF EXISTS temp.items_vocab; CREATE VIRTUAL TABLE temp.items_vocab USING fts5vocab(main, items_fts, instance)");
  const items = app.db.all<ItemRow>(
    `SELECT i.seq, i.id, i.kind, i.title, i.url, i.url_key, i.link_key, i.author, i.excerpt, i.read_minutes, i.source_id, i.source_title, i.current_version_id, i.image_url,
       v.title AS v_title, v.url AS v_url, v.summary_html, v.content_html
     FROM items i LEFT JOIN item_versions v ON v.id = i.current_version_id WHERE i.account_id = ? ORDER BY i.seq`, accountId);
  for (const i of items) {
    const label = `${i.title} (${i.id})`;
    assert.ok(i.current_version_id && i.v_title !== null, `${label} has a current version`);
    assert.equal(i.title, i.v_title || NO_TITLE, `${label}: the title is the current version's`);
    assert.equal(i.url, i.v_url, `${label}: the link is the current version's`);
    const text = toText(i.content_html ?? i.summary_html);
    assert.equal(i.url_key, urlKey(i.url), `${label}: url_key`);
    assert.equal(i.link_key, i.url ? linkKey(i.url) : null, `${label}: link_key`);
    assert.equal(i.excerpt, excerpt(toText(i.summary_html) || text), `${label}: excerpt`);
    // Reading time follows a readable copy once one is saved; every item here has only its feed text.
    assert.equal(i.read_minutes, i.kind === "video" || i.kind === "podcast" ? null : readMinutes(text), `${label}: read_minutes`);
    assert.equal(i.source_title, i.source_id ? app.db.get<{ title: string }>("SELECT title FROM sources WHERE id = ?", i.source_id)!.title : "", `${label}: source_title`);

    const indexed = indexedWords(app, i.seq);
    assert.deepEqual(indexed, {
      title: wordsOf(i.title), excerpt: wordsOf(i.excerpt ?? ""), author: wordsOf(i.author ?? ""), body: wordsOf(text),
    }, `${label}: search entry`);

    assert.ok(app.db.get("SELECT 1 FROM item_state WHERE item_id = ?", i.id), `${label}: has its state`);
    const versions = app.db.all<{ id: string }>("SELECT id FROM item_versions WHERE item_id = ?", i.id);
    for (const v of versions) {
      const live = app.db.all<{ bytes: number }>("SELECT bytes FROM stored_objects WHERE kind = 'item_version' AND ref_id = ? AND released_at IS NULL", v.id);
      assert.equal(live.length, 1, `${label}: version ${v.id} is in the ledger once`);
      assert.ok(live[0]!.bytes > 0);
    }
  }
  assert.equal(app.db.get("SELECT 1 FROM temp.items_vocab WHERE doc NOT IN (SELECT seq FROM items) LIMIT 1"), undefined, "the index holds nothing for an item that is gone");
  const live = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE account_id = ? AND kind = 'item_version' AND released_at IS NULL", accountId)!.n;
  assert.equal(live, app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions WHERE account_id = ?", accountId)!.n, "a live ledger object for every version and none without one");
  const r = reconcile(app, accountId);
  assert.deepEqual([r.difference, r.trackedDifference], [0, 0], "the ledger, its total and the objects agree");
  return items.length;
}

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const source = makeSource(app, p, "Tide Letters", "feed/1");
  return { app, p, source, cleanup };
}

type Owner = ReturnType<typeof makeOwner>;
const longText = (words: number, tag = "w") => `<p>${Array.from({ length: words }, (_, i) => `${tag}${i}`).join(" ")}</p>`;
const itemOf = (app: App, url: string) => app.db.get<{ id: string }>("SELECT id FROM items WHERE url = ?", url)!.id;

test("an entry the engine delivers becomes an item whose derived columns, search entry and ledger agree", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { url: "https://Example.org/post/a/?utm_source=x#top", title: "Sediment & silt", summaryHtml: "<p>Short summary.</p>", contentHtml: longText(500) }),
    entry("feed/1", { title: "", summaryHtml: "<p>A post with no headline at all, only its summary text.</p>", contentHtml: null }),
    entry("feed/1", { url: null, title: "No link", summaryHtml: null, contentHtml: "<p>Body only.</p>" }),
    entry("feed/1", { title: "A talk", enclosures: [{ url: "https://example.org/a.mp3", type: "audio/mpeg", length: null }], summaryHtml: longText(900) }),
  ]));
  assert.equal(assertStoreConsistent(app, p.accountId), 4);
});

test("an upstream edit revises the item: derived columns, search entry and ledger follow the new version", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Grows", summaryHtml: "<p>Short.</p>", contentHtml: "<p>Five short words here.</p>" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  assert.equal(app.db.get<{ read_minutes: number }>("SELECT read_minutes FROM items WHERE id = ?", id)!.read_minutes, 1);

  const edited = { ...e, url: "https://example.org/moved/?utm_medium=mail", title: "Grows a lot", summaryHtml: "<p>A longer summary of the post.</p>", contentHtml: longText(700, "later") };
  assert.equal(applySyncBatch(app, p.engineUserId, batch([edited])).updated, 1);
  assert.equal(assertStoreConsistent(app, p.accountId), 1);
  assert.equal(app.db.get<{ read_minutes: number }>("SELECT read_minutes FROM items WHERE id = ?", id)!.read_minutes, 4, "700 words are four minutes");
});

test("an entry that arrives without a headline keeps the one it was given when it is delivered again", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "", summaryHtml: "<p>Only a summary, no headline.</p>" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  const title = app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", id)!.title;
  assert.equal(applySyncBatch(app, p.engineUserId, batch([e])).updated, 0, "nothing changed upstream");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions WHERE item_id = ?", id)!.n, 1, "no new version");
  assert.equal(app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", id)!.title, title);
  // An edit to its text revises it, and the headline stays what it was made from.
  applySyncBatch(app, p.engineUserId, batch([{ ...e, summaryHtml: "<p>Only a summary, no headline, now longer.</p>" }]));
  assertStoreConsistent(app, p.accountId);
});

test("an archive import makes items whose derived columns, search entry and ledger agree, and an export of them round-trips", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  applySyncBatch(a.app, pa.engineUserId, batch([
    entry("feed/1", { url: "https://example.org/post/a/?utm_source=x", title: "Sediment", summaryHtml: "<p>Short summary.</p>", contentHtml: longText(500) }),
    entry("feed/1", { title: "A talk", enclosures: [{ url: "https://example.org/a.mp3", type: "audio/mpeg", length: null }], summaryHtml: longText(900) }),
    entry("feed/1", { url: null, title: "No link", summaryHtml: null, contentHtml: "<p>Body only.</p>" }),
  ]));
  const kept = createBasket(a.app, pa, { name: "Reading", captureMode: "metadata" }).id;
  keepItem(a.app, pa, itemOf(a.app, "https://example.org/post/a/?utm_source=x"), kept);
  await keepLink(a.app, pa, { url: "https://example.org/bare-link", basketId: kept, title: "A link with no text" }, async () => null);
  assertStoreConsistent(a.app, pa.accountId);
  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));
  const preview = stageImport(b.app, pb, doc);
  assert.equal(applyImport(b.app, pb, preview.token).created.items, 4);
  assert.equal(assertStoreConsistent(b.app, pb.accountId), 4);
});

test("a news post and its revision keep the copy consistent, and deleting the post removes the copy completely", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const post = createNewsPost(app, p, { title: "Hello", body: "First words.", publish: true });
  assert.equal(assertStoreConsistent(app, p.accountId), 1);
  updateNewsPost(app, p, post.id, { title: "Hello again", body: Array.from({ length: 600 }, (_, i) => `word${i}`).join(" "), publish: true });
  assert.equal(assertStoreConsistent(app, p.accountId), 1);
  deleteNewsPost(app, p, post.id);
  assert.equal(assertStoreConsistent(app, p.accountId), 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions")!.n, 0);
});

test("a link kept by hand is a consistent item", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const basket = createBasket(app, p, { name: "Reading", captureMode: "metadata" }).id;
  await keepLink(app, p, { url: "https://Example.org/other/?utm_source=x#frag", basketId: basket, title: "Other" }, async () => null);
  await keepLink(app, p, { url: "https://example.org/bare", basketId: basket }, async () => ({ title: "Found title", author: "Someone", siteName: null, imageUrl: "https://example.org/i.png", kind: "article" }) as never);
  assert.equal(assertStoreConsistent(app, p.accountId), 2);
});

test("deleting an item removes its rows, search entry and ledger objects, and leaves a tombstone for the engine's entry", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Doomed", contentHtml: longText(50) });
  const other = entry("feed/1", { title: "Stays" });
  applySyncBatch(app, p.engineUserId, batch([e, other]));
  const id = itemOf(app, e.url!);
  const before = reconcile(app, p.accountId).objects;
  const released = app.db.tx(() => deleteItemNow(app, p, id));
  assert.ok(released! > 0);
  assert.equal(before - reconcile(app, p.accountId).objects, released);
  assert.equal(assertStoreConsistent(app, p.accountId), 1);
  assert.ok(app.db.get("SELECT 1 FROM item_tombstones WHERE external_id = ?", e.externalId), "the engine's entry is remembered as deleted");
  assert.equal(applySyncBatch(app, p.engineUserId, batch([e])).duplicates, 1, "and does not come back");
  assert.equal(app.db.get("SELECT 1 FROM items WHERE id = ?", id), undefined);
  assert.equal(app.db.get("SELECT 1 FROM stored_objects WHERE item_id = ? AND released_at IS NULL", id), undefined);
  assert.deepEqual(rowsAbout(app, id), []);
  assert.equal(deleteItemNow(app, { accountId: makeOwner(app, { admin: false }).accountId }, itemOf(app, other.url!)), null, "another PURSS's item is not deleted");
});

test("deleting an item takes everything that belongs to it: pins, notes, playback, reminders, shared notes and Smart filter verdicts", (t) => {
  const { app, p, source, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Loved", contentHtml: longText(80) });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  const basket = createBasket(app, p, { name: "Reading", captureMode: "metadata" }).id;
  keepItem(app, p, id, basket);
  putAnnotation(app, p, id, newId("ann"), { kind: "note", body: "Compare with the delta paper.", updatedAt: new Date().toISOString() });
  savePlayback(app, p, id, { positionSeconds: 30, durationSeconds: 600 });
  setItemReminder(app, p, id, { remindOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), note: "Look again" });
  setShareNote(app, p, shareRow(app, p, "basket", basket), id, "Worth it.");
  const filter = newId("flt");
  app.db.run("INSERT INTO ai_filters (id, account_id, source_id, keep_text, created_at, updated_at) VALUES (?, ?, ?, 'maps', ?, ?)", filter, p.accountId, source, nowIso(), nowIso());
  app.db.run("INSERT INTO ai_filter_verdicts (filter_id, item_id, account_id, version, keep_probability, dropped, judged_at) VALUES (?, ?, ?, 1, 0.9, 0, ?)", filter, id, p.accountId, nowIso());
  assert.ok(rowsAbout(app, id).length >= 8, "the item has rows in many tables to begin with");

  app.db.tx(() => deleteItemNow(app, p, id));
  assert.deepEqual(rowsAbout(app, id), []);
  assert.equal(app.db.get("SELECT 1 FROM annotations_fts WHERE annotations_fts MATCH 'delta'"), undefined, "the note's search entry goes too");
  assert.equal(app.db.get("SELECT 1 FROM stored_objects WHERE item_id = ? AND released_at IS NULL", id), undefined);
  assert.equal(app.db.get("SELECT 1 FROM stored_objects WHERE ref_id LIKE 'basket:%' AND released_at IS NULL"), undefined, "nor does its place in the basket stay in the ledger");
  const r = reconcile(app, p.accountId);
  assert.deepEqual([r.objects, r.difference, r.trackedDifference], [0, 0, 0]);
});

/** The reading time an item is sent with describes the text the reader shows for it: a readable copy, else the version a basket kept, else the current version. */
function assertReadingTimeIsOfShownText(app: App, p: Owner, itemId: string): void {
  const detail = getItemDetail(app, p, itemId);
  assert.equal(detail.readMinutes, readMinutes(toText(detail.contentHtml)), `${detail.title}: reading time of the text shown`);
}

/** A readable copy of an item's page, made the way the worker's answer makes one. */
function saveReadableCopy(app: App, p: Owner, itemId: string, text: string, quality: "full" | "partial" = "full"): void {
  const url = app.db.get<{ url: string }>("SELECT url FROM items WHERE id = ?", itemId)!.url;
  app.db.tx(() => assert.equal(queueCapture(app, { accountId: p.accountId, itemId, url }), true));
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", itemId)!;
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "The page", text, html: `<p>${text}</p>`, finalUrl: url, bytes: text.length }));
  assert.equal(app.db.get<{ quality: string }>("SELECT quality FROM captures WHERE id = ?", cap.id)!.quality, quality);
}
const prose = (words: number) => Array.from({ length: words }, (_, i) => ["tide", "mud", "river", "estuary", "silt", "marsh"][i % 6]).join(" ");

test("an edit gives an unkept item the reading time of its new text, and a kept item keeps that of the text the reader still shows", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const loose = entry("feed/1", { title: "Loose", contentHtml: "<p>Five short words here.</p>" });
  const pinned = entry("feed/1", { title: "Pinned", contentHtml: "<p>As first kept.</p>" });
  applySyncBatch(app, p.engineUserId, batch([loose, pinned]));
  const [looseId, pinnedId] = [itemOf(app, loose.url!), itemOf(app, pinned.url!)];
  keepItem(app, p, pinnedId, createBasket(app, p, { name: "Reading", captureMode: "metadata" }).id);
  assert.equal(applySyncBatch(app, p.engineUserId, batch([{ ...loose, contentHtml: longText(700) }, { ...pinned, contentHtml: longText(700) }])).updated, 2);

  const looseDetail = getItemDetail(app, p, looseId);
  assert.equal(looseDetail.readMinutes, 4, "700 words are four minutes");
  assertReadingTimeIsOfShownText(app, p, looseId);
  const pinnedDetail = getItemDetail(app, p, pinnedId);
  assert.match(pinnedDetail.contentHtml!, /As first kept/, "the reader still shows the version that was kept");
  assert.equal(pinnedDetail.readMinutes, 1, "so the reading time is that version's, though the latest text is longer");
  assert.match(pinnedDetail.latestHtml!, /w699/);
  assertReadingTimeIsOfShownText(app, p, pinnedId);

  // Nothing is shown from a version nobody keeps: a second edit still gives the kept item the time of the text it shows.
  applySyncBatch(app, p.engineUserId, batch([{ ...pinned, contentHtml: longText(2000, "z") }]));
  assertReadingTimeIsOfShownText(app, p, pinnedId);
  assert.equal(getItemDetail(app, p, pinnedId).readMinutes, 1);
  assert.deepEqual([reconcile(app, p.accountId).difference, reconcile(app, p.accountId).trackedDifference], [0, 0]);
});

test("an edit leaves the reading time a readable copy gave the item, because the copy is what the reader shows", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Copied", summaryHtml: "<p>A short summary.</p>", contentHtml: null });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  saveReadableCopy(app, p, id, prose(2300));
  assert.equal(getItemDetail(app, p, id).readMinutes, 10, "the copy is the article");
  assert.equal(applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(300) }])).updated, 1);
  assert.equal(getItemDetail(app, p, id).readMinutes, 10);
  assertReadingTimeIsOfShownText(app, p, id);
});

test("an archive import gives an item with a complete readable copy the reading time of that copy, and one with only part of the page keeps the feed's", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Copied", summaryHtml: "<p>A short summary.</p>", contentHtml: null });
  const partial = entry("feed/1", { title: "Part of a page", contentHtml: longText(1000) });
  applySyncBatch(a.app, pa.engineUserId, batch([e, partial]));
  saveReadableCopy(a.app, pa, itemOf(a.app, e.url!), prose(2300));
  saveReadableCopy(a.app, pa, itemOf(a.app, partial.url!), prose(30), "partial");
  assert.equal(getItemDetail(a.app, pa, itemOf(a.app, partial.url!)).readMinutes, 5, "a copy of only part of the page is not the article");
  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  assert.equal(applyImport(b.app, pb, stageImport(b.app, pb, JSON.parse(parts.join(""))).token).created.captures, 2);
  const imported = itemOf(b.app, e.url!);
  assert.equal(getItemDetail(b.app, pb, imported).readMinutes, 10);
  assertReadingTimeIsOfShownText(b.app, pb, imported);
  assert.equal(getItemDetail(b.app, pb, itemOf(b.app, partial.url!)).readMinutes, 5, "nor does importing it make a part of a page the article");
});

const browserPage = (words: number) => `<article><p>${prose(words)}</p></article>`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the reading time follows the newest complete copy, a browser capture included, and an import keeps it", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Copied twice", contentHtml: longText(700) });
  applySyncBatch(a.app, pa.engineUserId, batch([e]));
  const id = itemOf(a.app, e.url!);
  assert.equal(getItemDetail(a.app, pa, id).readMinutes, 4);
  saveReadableCopy(a.app, pa, id, prose(2300));
  assert.equal(getItemDetail(a.app, pa, id).readMinutes, 10, "the server's copy is the article");
  await pause();
  keepWithBrowserCapture(a.app, pa, { url: e.url!, basketId: createBasket(a.app, pa, { name: "Reading", captureMode: "metadata" }).id, html: browserPage(700) });
  assert.equal(getItemDetail(a.app, pa, id).readMinutes, 4, "the person's newer capture is what the reader shows now");
  assertReadingTimeIsOfShownText(a.app, pa, id);

  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  assert.equal(applyImport(b.app, pb, stageImport(b.app, pb, JSON.parse(parts.join(""))).token).created.items, 1);
  assert.equal(getItemDetail(b.app, pb, itemOf(b.app, e.url!)).readMinutes, 4);
  assertReadingTimeIsOfShownText(b.app, pb, itemOf(b.app, e.url!));
});

test("a page saved from the browser gives the item the reading time of that text", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Short in the feed", contentHtml: longText(20) });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  assert.equal(getItemDetail(app, p, id).readMinutes, 1);
  keepWithBrowserCapture(app, p, { url: e.url!, basketId: createBasket(app, p, { name: "Reading", captureMode: "metadata" }).id, html: browserPage(700) });
  assert.equal(getItemDetail(app, p, id).readMinutes, 4);
  assertReadingTimeIsOfShownText(app, p, id);
});

test("taking an item out of the baskets that kept its versions gives it the reading time of the text shown next", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const first = createBasket(app, p, { name: "First", captureMode: "metadata" }).id;
  const second = createBasket(app, p, { name: "Second", captureMode: "metadata" }).id;
  const kept = (title: string) => {
    const e = entry("feed/1", { title, contentHtml: longText(20) });
    applySyncBatch(app, p.engineUserId, batch([e]));
    const id = itemOf(app, e.url!);
    keepItem(app, p, id, first);
    applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(700) }]));
    keepItem(app, p, id, second);
    applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(1400) }]));
    assert.equal(getItemDetail(app, p, id).readMinutes, 1, "the reader shows the version the first basket kept");
    assertReadingTimeIsOfShownText(app, p, id);
    return id;
  };
  const byUnkeeping = kept("Unkept twice");
  unkeepItem(app, p, byUnkeeping, first);
  assert.equal(getItemDetail(app, p, byUnkeeping).readMinutes, 4, "now the second basket's version");
  assertReadingTimeIsOfShownText(app, p, byUnkeeping);
  unkeepItem(app, p, byUnkeeping, second);
  assert.equal(getItemDetail(app, p, byUnkeeping).readMinutes, 7, "now the latest text");
  assertReadingTimeIsOfShownText(app, p, byUnkeeping);

  const byDeleting = kept("Basket deleted");
  deleteBasket(app, p, first, basketDeletePreview(app, p, first).confirmToken);
  assert.equal(getItemDetail(app, p, byDeleting).readMinutes, 4);
  assertReadingTimeIsOfShownText(app, p, byDeleting);
  assert.deepEqual([reconcile(app, p.accountId).difference, reconcile(app, p.accountId).trackedDifference], [0, 0]);
});

test("an import keeps the reading time of the version a basket kept, when an edit has since replaced it", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Kept short, grown long", contentHtml: longText(20) });
  applySyncBatch(a.app, pa.engineUserId, batch([e]));
  keepItem(a.app, pa, itemOf(a.app, e.url!), createBasket(a.app, pa, { name: "Reading", captureMode: "metadata" }).id);
  applySyncBatch(a.app, pa.engineUserId, batch([{ ...e, contentHtml: longText(1400) }]));
  assert.equal(getItemDetail(a.app, pa, itemOf(a.app, e.url!)).readMinutes, 1);
  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  applyImport(b.app, pb, stageImport(b.app, pb, JSON.parse(parts.join(""))).token);
  const imported = getItemDetail(b.app, pb, itemOf(b.app, e.url!));
  assert.equal(imported.changedSinceKept, true);
  assert.equal(imported.readMinutes, 1, "the kept version is what the reader shows");
  assertReadingTimeIsOfShownText(b.app, pb, imported.id);
});

test("a finished copy with nothing to show is not what the reader shows, so it gives no reading time", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Empty copy", contentHtml: longText(700) });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, text, html, quality, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'done', ?, NULL, 'full', ?, ?)", newId("cap"), p.accountId, id, prose(2300), nowIso(), nowIso());
  assert.equal(applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(1500) }])).updated, 1);
  assert.equal(getItemDetail(app, p, id).readMinutes, 7, "the feed's text is what is shown");
  assertReadingTimeIsOfShownText(app, p, id);
});

test("a readable copy with no plain text gives the reading time of its markup, before and after a move", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Markup only", contentHtml: longText(20) });
  const emptyText = entry("feed/1", { title: "Empty text", contentHtml: longText(20) });
  applySyncBatch(a.app, pa.engineUserId, batch([e, emptyText]));
  const [id, emptyId] = [itemOf(a.app, e.url!), itemOf(a.app, emptyText.url!)];
  const copy = (itemId: string, text: string | null) => a.app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, text, html, quality, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'done', ?, ?, 'full', ?, ?)",
    newId("cap"), pa.accountId, itemId, text, `<p>${prose(900)}</p>`, nowIso(), nowIso());
  copy(id, null);
  copy(emptyId, "");
  // An edit sets the reading time again from what the reader shows.
  applySyncBatch(a.app, pa.engineUserId, batch([{ ...e, contentHtml: longText(25) }, { ...emptyText, contentHtml: longText(25) }]));
  assert.deepEqual([getItemDetail(a.app, pa, id).readMinutes, getItemDetail(a.app, pa, emptyId).readMinutes], [4, 4], "900 words in the markup, whatever the plain text says");
  assertReadingTimeIsOfShownText(a.app, pa, id);
  assertReadingTimeIsOfShownText(a.app, pa, emptyId);

  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  applyImport(b.app, pb, stageImport(b.app, pb, JSON.parse(parts.join(""))).token);
  const imported = itemOf(b.app, e.url!);
  assert.equal(b.app.db.get<{ text: string | null }>("SELECT text FROM captures WHERE item_id = ?", imported)!.text, null, "a copy with no plain text still has none");
  assert.equal(getItemDetail(b.app, pb, imported).readMinutes, 4);
  assertReadingTimeIsOfShownText(b.app, pb, imported);
  assert.equal(b.app.db.get<{ text: string | null }>("SELECT text FROM captures WHERE item_id = ?", itemOf(b.app, emptyText.url!))!.text, "", "nor does an empty one gain any");
});

test("an archive import keeps a finished copy with no markup without it, so it does not hide the feed's text", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  makeSource(a.app, pa, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Nothing to show", contentHtml: longText(300) });
  applySyncBatch(a.app, pa.engineUserId, batch([e]));
  a.app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, text, html, quality, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'done', ?, NULL, 'full', ?, ?)",
    newId("cap"), pa.accountId, itemOf(a.app, e.url!), prose(900), nowIso(), nowIso());
  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  applyImport(b.app, pb, stageImport(b.app, pb, JSON.parse(parts.join(""))).token);
  const imported = itemOf(b.app, e.url!);
  assert.equal(b.app.db.get<{ html: string | null }>("SELECT html FROM captures WHERE item_id = ?", imported)!.html, null);
  assert.match(getItemDetail(b.app, pb, imported).contentHtml!, /w299/, "the feed's text is what the reader shows");
  assert.equal(getItemDetail(b.app, pb, imported).readMinutes, 2);
  assertReadingTimeIsOfShownText(b.app, pb, imported);
});

test("a finished copy with no markup is passed over for the newest one that has some", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Two copies", contentHtml: longText(300) });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  saveReadableCopy(app, p, id, prose(2300));
  assert.equal(getItemDetail(app, p, id).readMinutes, 10);
  app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, text, html, created_at, completed_at) VALUES (?, ?, ?, 'browser', 'done', ?, NULL, ?, ?)",
    newId("cap"), p.accountId, id, prose(30), "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  const detail = getItemDetail(app, p, id);
  assert.match(detail.contentHtml!, /tide mud river/, "the older copy is what the reader shows");
  assert.equal(detail.contentRef!.kind, "capture");
  assert.equal(applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(310) }])).updated, 1);
  assert.equal(getItemDetail(app, p, id).readMinutes, 10, "so the reading time is the older copy's, not the feed's");
  assertReadingTimeIsOfShownText(app, p, id);
});

test("checking a readable copy made before copies were checked gives the reading time of what is shown when it is only part of the page", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Old copy", contentHtml: longText(1000) });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, text, html, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'done', ?, ?, ?, ?)", newId("cap"), p.accountId, id, prose(30), `<p>${prose(30)}</p>`, nowIso(), nowIso());
  app.db.run("UPDATE items SET read_minutes = 1 WHERE id = ?", id);
  assert.equal(getItemDetail(app, p, id).readMinutes, 1, "an unchecked copy is shown, and set the reading time");
  assert.equal(stepCaptureCheck(app), true);
  assert.equal(getItemDetail(app, p, id).readMinutes, 5, "found to be only part of the page, it gives way to the feed's text");
  assertReadingTimeIsOfShownText(app, p, id);
});

test("an edit that does not fit the storage allowance is deferred and leaves the item as it was", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allowanceBytes: 4000 });
  makeSource(app, p, "Tide Letters", "feed/1");
  const e = entry("feed/1", { title: "Small", summaryHtml: "<p>Small.</p>" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = itemOf(app, e.url!);
  const result = applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: longText(2000) }]));
  assert.equal(result.updated, 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions WHERE item_id = ?", id)!.n, 1);
  assert.equal(assertStoreConsistent(app, p.accountId), 1);
});

/** The tables that still hold a row about an item, whatever the table, found from the schema so a new one cannot be missed. News deliveries remember that a copy was removed, and the ledger keeps its released objects. */
function rowsAbout(app: App, itemId: string): string[] {
  const tables = app.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('news_deliveries', 'stored_objects')").map((r) => r.name);
  return tables.filter((name) => app.db.all<{ name: string }>(`PRAGMA table_info(${name})`).some((c) => c.name === "item_id")
    && app.db.get(`SELECT 1 FROM ${name} WHERE item_id = ?`, itemId) !== undefined);
}
