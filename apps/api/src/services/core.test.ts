import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch, recordSyncSuccess } from "./sync.ts";
import { listItems, getItemDetail, insertItem, searchSnippets } from "./items.ts";
import { applyUndo, bulk, changeState, keepItem, keepWithUndo, unkeepItem } from "./state.ts";
import { admitObject, categories, reconcile, summary, usedBytes, diskOverride } from "./storage.ts";
import { createBasket, createCollection, deleteItems, deletePreview } from "./collections.ts";
import { completeCapture, failCapture } from "./captures.ts";
import { HttpError } from "../http.ts";

function setup(allocationBytes: number | null = null) {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app, { allocationBytes });
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  return { app, p, src, cleanup };
}

test("sync batch imports items once and replays idempotently", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const b = batch([entry("feed/1"), entry("feed/1"), entry("feed/999")]);
  const r1 = applySyncBatch(app, p.engineUserId, b);
  assert.equal(r1.accepted, 2);
  assert.equal(r1.unknownStreams, 1);
  const r2 = applySyncBatch(app, p.engineUserId, b);
  assert.equal(r2.accepted, 2, "replay returns the original result");
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).items.length, 2);
  // A different batch carrying the same entries does not duplicate them.
  const again = applySyncBatch(app, p.engineUserId, batch(b.entries));
  assert.equal(again.accepted, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 2);
  const cp = app.db.get<{ engine_identity: string; last_success_at: string }>("SELECT engine_identity, last_success_at FROM sync_checkpoints WHERE engine_user_id = ?", p.engineUserId)!;
  assert.equal(cp.engine_identity, "engine-A");
  assert.ok(cp.last_success_at);
});

test("upstream edit creates a new version and never alters a kept snapshot", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Original title" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  const basket = createBasket(app, p, { name: "Thesis", captureMode: "metadata" });
  keepItem(app, p, item.id, basket.id);
  const pinned = app.db.get<{ version_id: string }>("SELECT version_id FROM basket_items WHERE item_id = ?", item.id)!.version_id;
  applySyncBatch(app, p.engineUserId, batch([{ ...e, title: "Corrected title", summaryHtml: "<p>new</p>" }]));
  assert.equal(listItems(app, p, { scope: "all" }).items.find((i) => i.id === item.id)!.title, "Corrected title", "lists show the current title");
  assert.equal(getItemDetail(app, p, item.id).title, "Original title", "the panel shows the kept copy");
  const kept = app.db.get<{ title: string }>("SELECT title FROM item_versions WHERE id = ?", pinned)!;
  assert.equal(kept.title, "Original title", "pinned version untouched");
  assert.equal(reconcile(app, p.accountId).difference, 0);
  // Unkept items: the superseded version is replaced, not retained.
  const e2 = entry("feed/1");
  applySyncBatch(app, p.engineUserId, batch([e2]));
  const before = usedBytes(app, p.accountId);
  applySyncBatch(app, p.engineUserId, batch([{ ...e2, summaryHtml: "<p>x</p>" }]));
  assert.ok(usedBytes(app, p.accountId) < before);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.url = ?", e2.url!)!.n, 1);
});

test("multi-basket keeps never double count, and categories sum to the total", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
  const [a, b] = listItems(app, p, { scope: "all" }).items;
  const b1 = createBasket(app, p, { name: "One", captureMode: "metadata" });
  const b2 = createBasket(app, p, { name: "Two", captureMode: "metadata" });
  const feedOnly = categories(app, p.accountId).feed;
  keepItem(app, p, a!.id, b1.id);
  const afterFirst = categories(app, p.accountId);
  keepItem(app, p, a!.id, b2.id);
  const afterSecond = categories(app, p.accountId);
  assert.equal(afterSecond.kept, afterFirst.kept, "second basket adds no content bytes");
  assert.ok(afterFirst.feed < feedOnly, "bytes moved from feed to kept");
  const s = summary(app, p.accountId);
  assert.equal(s.usedBytes, s.categories.kept + s.categories.feed + s.categories.other);
  unkeepItem(app, p, a!.id, b1.id);
  assert.equal(categories(app, p.accountId).kept, afterSecond.kept, "still pinned by the other basket");
  unkeepItem(app, p, a!.id, b2.id);
  assert.ok(getItemDetail(app, p, a!.id), "unkeep never deletes the item");
  assert.ok(b);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("full quota pauses imports without advancing the checkpoint; reading, keeping and deleting still work", (t) => {
  const { app, p, cleanup } = setup(5_000);
  t.after(cleanup);
  const big = (n: number) => entry("feed/1", { summaryHtml: `<p>${"word ".repeat(n)}</p>` });
  applySyncBatch(app, p.engineUserId, batch([big(300)]));
  assert.equal(listItems(app, p, { scope: "all" }).total, 1);
  assert.throws(() => applySyncBatch(app, p.engineUserId, { ...batch([big(1200)]), checkpoint: { continuation: "page-2", newestCrawlUsec: "1" } }),
    (err: unknown) => err instanceof HttpError && err.status === 507);
  const cp = app.db.get<{ continuation: string | null }>("SELECT continuation FROM sync_checkpoints WHERE engine_user_id = ?", p.engineUserId)!;
  assert.equal(cp.continuation, null, "checkpoint not advanced");
  assert.equal(summary(app, p.accountId).growthPaused, true);
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  // Control writes still succeed within the bounded headroom.
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  keepItem(app, p, item.id, basket.id);
  changeState(app, p, item.id, { workflow: "finished", expectedRevision: item.revision });
  // Deleting is never blocked by quota.
  const preview = deletePreview(app, p, [item.id]);
  assert.equal(preview.keptItems.length, 1);
  assert.ok(preview.releasesBytes > 0);
  deleteItems(app, p, preview.confirmToken);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("disk reserve blocks growth even with quota remaining", (t) => {
  const { app, p, cleanup } = setup(null);
  t.after(() => { diskOverride.freeBytes = null; cleanup(); });
  diskOverride.freeBytes = 10; // config reserve is 0 in tests; bytes needed exceed free
  assert.throws(() => applySyncBatch(app, p.engineUserId, batch([entry("feed/1")])), (err: unknown) => err instanceof HttpError && err.code === "disk_reserve");
  diskOverride.freeBytes = null;
  assert.equal(applySyncBatch(app, p.engineUserId, batch([entry("feed/1")])).accepted, 1);
});

test("deleted items are tombstoned and not re-imported", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1");
  applySyncBatch(app, p.engineUserId, batch([e]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  deleteItems(app, p, deletePreview(app, p, [item.id]).confirmToken);
  assert.equal(applySyncBatch(app, p.engineUserId, batch([e])).accepted, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 0);
});

test("replacement engine entries go to reconciliation instead of duplicating", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1");
  applySyncBatch(app, p.engineUserId, batch([e], undefined, "engine-A"));
  const r = applySyncBatch(app, p.engineUserId, batch([{ ...e, externalId: "different-id" }], undefined, "engine-B"));
  assert.equal(r.queuedForReview, 1);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 1);
  const q = app.db.get<{ candidate_item_id: string }>("SELECT candidate_item_id FROM reconciliation_queue")!;
  assert.ok(q.candidate_item_id, "suggests the existing item by source + original GUID");
});

test("workflow revisions prevent silent overwrites; undo restores", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  const first = changeState(app, p, item.id, { workflow: "toread", expectedRevision: item.revision });
  assert.throws(() => changeState(app, p, item.id, { workflow: "finished", expectedRevision: item.revision }), (err: unknown) => err instanceof HttpError && err.status === 409);
  applyUndo(app, p, first.undoToken);
  const back = listItems(app, p, { scope: "all" }).items[0]!;
  assert.equal(back.workflow, "new");
  assert.equal(back.fresh, true, "freshness independent of workflow");
  // Finishing mirrors read state to the engine through the outbox.
  changeState(app, p, item.id, { workflow: "finished", expectedRevision: back.revision });
  assert.ok(app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.mark_read'"));
  // Ignored items drop out of the default view but stay recoverable.
  const cur = listItems(app, p, { scope: "all", filter: "all" }).items[0]!;
  changeState(app, p, item.id, { workflow: "ignored", expectedRevision: cur.revision });
  assert.equal(listItems(app, p, { scope: "all" }).total, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "ignored" }).total, 1);
});

test("the open filter is New and To read: it leaves out finished, ignored and in-progress items, in lists and on Home", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1"), entry("feed/1"), entry("feed/1"), entry("feed/1")]));
  const ids = listItems(app, p, { scope: "all" }).items.map((i) => i.id);
  bulk(app, p, [ids[0]!], { type: "workflow", workflow: "finished" });
  bulk(app, p, [ids[1]!], { type: "workflow", workflow: "ignored" });
  bulk(app, p, [ids[2]!], { type: "workflow", workflow: "toread" });
  bulk(app, p, [ids[3]!], { type: "workflow", workflow: "inprogress" });
  const open = new Set([ids[2], ids[4]]);
  const listed = listItems(app, p, { scope: "all", filter: "open" });
  assert.deepEqual(new Set(listed.items.map((i) => i.id)), open);
  assert.equal(listed.total, 2);
  assert.equal(listItems(app, p, { scope: "all", filter: "open", q: "post" }).items.every((i) => open.has(i.id)), true);
  const home = listItems(app, p, { scope: "home", filter: "open", mix: "home", limit: 10 });
  assert.deepEqual(home.items.map((i) => i.id), [ids[4], ids[2]], "New first, then To read");
  assert.equal(listItems(app, p, { scope: "all", filter: "active" }).total, 4, "active still shows finished");
});

test("bulk actions and keep produce one undo token", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1"), entry("feed/1")]));
  const ids = listItems(app, p, { scope: "all" }).items.map((i) => i.id);
  const basket = createBasket(app, p, { name: "B", captureMode: "metadata" });
  const kept = bulk(app, p, ids, { type: "keep", basketId: basket.id });
  assert.equal(kept.changed, 3);
  applyUndo(app, p, kept.undoToken);
  assert.equal(listItems(app, p, { scope: `basket:${basket.id}` }).total, 0);
  const cleared = bulk(app, p, ids, { type: "clearFresh" });
  assert.equal(cleared.changed, 3);
  assert.equal(listItems(app, p, { scope: "all", filter: "fresh" }).total, 0);
  const single = keepWithUndo(app, p, ids[0]!, basket.id, true);
  applyUndo(app, p, single.undoToken);
  assert.deepEqual(listItems(app, p, { scope: "all" }).items.find((i) => i.id === ids[0])!.basketIds, []);
});

test("text baskets reserve and settle a readable capture; failure releases it", (t) => {
  const { app, p, cleanup } = setup(10_000_000);
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
  const [a, b] = listItems(app, p, { scope: "all" }).items;
  const basket = createBasket(app, p, { name: "Text", captureMode: "text" });
  const r = keepItem(app, p, a!.id, basket.id);
  assert.equal(r.captureQueued, true);
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", a!.id)!;
  assert.ok(summary(app, p.accountId).reservedBytes > 0);
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text: "Readable text with unique zygomorphic word", html: "<p>Readable <script>x</script>text</p>", finalUrl: "https://example.org/a", bytes: 10 }));
  assert.equal(summary(app, p.accountId).reservedBytes, 0);
  const detail = getItemDetail(app, p, a!.id);
  assert.ok(detail.captures.some((c) => c.level === "fulltext"));
  assert.ok(!detail.contentHtml!.includes("<script"), "captured HTML sanitized");
  assert.equal(listItems(app, p, { scope: "all", q: "zygomorphic" }).total, 1, "captured text is searchable");
  const found = listItems(app, p, { scope: "all", q: "zygomorphic" }).items.map((i) => i.id);
  assert.match(searchSnippets(app, found, "zygomorphic")[found[0]!] ?? "", /\u0001zygomorphic\u0002/, "the snippet marks the match in the captured text");
  assert.deepEqual(searchSnippets(app, [b!.id], "zygomorphic"), {}, "an item that doesn't match gets no snippet");
  keepItem(app, p, b!.id, basket.id);
  const cap2 = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", b!.id)!;
  app.db.tx(() => failCapture(app, cap2.id, "nope"));
  assert.equal(summary(app, p.accountId).reservedBytes, 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("scopes, search and cursor pagination", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const other = makeSource(app, p, "Kiln & Coil", "feed/2", { kind: "youtube" });
  applySyncBatch(app, p.engineUserId, batch([...Array.from({ length: 7 }, () => entry("feed/1")), entry("feed/2", { title: "Throwing a lidded jar", url: "https://www.youtube.com/watch?v=abc" })]));
  const col = createCollection(app, p, { name: "Making", emoji: null, mode: "sources", sourceIds: [other], query: null, view: "cards" });
  const inCol = listItems(app, p, { scope: `collection:${col.id}` });
  assert.equal(inCol.total, 1);
  assert.equal(inCol.items[0]!.kind, "video");
  const q = createCollection(app, p, { name: "Q", emoji: null, mode: "query", sourceIds: [], query: { all: [{ field: "source", value: [src] }, { field: "text", value: "tidal" }] }, view: "list" });
  assert.equal(listItems(app, p, { scope: `collection:${q.id}` }).total, 7);
  // A filter can refer to a source collection; the item's detail names the collections its source is in.
  const viaCollection = createCollection(app, p, { name: "Via", emoji: null, mode: "query", sourceIds: [], query: { field: "collection", value: [col.id] }, view: "list" });
  assert.equal(listItems(app, p, { scope: `collection:${viaCollection.id}` }).total, 1);
  assert.equal(listItems(app, p, { scope: `collection:${col.id}` }).total, 1);
  assert.deepEqual(getItemDetail(app, p, inCol.items[0]!.id).collections.map((c) => c.name), ["Making"]);
  assert.deepEqual(getItemDetail(app, p, listItems(app, p, { scope: `source:${src}`, limit: 1 }).items[0]!.id).collections, []);
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = listItems(app, p, { scope: "all", limit: 3, cursor });
    page.items.forEach((i) => seen.add(i.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 8, "every item exactly once across pages");
  assert.equal(listItems(app, p, { scope: "all", q: "lidded jar" }).total, 1);
});

test("PURSSes are isolated", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  assert.equal(listItems(app, other, { scope: "all", filter: "all" }).total, 0);
  assert.throws(() => getItemDetail(app, other, item.id), (e: unknown) => e instanceof HttpError && e.status === 404);
  const basket = createBasket(app, other, { name: "Mine", captureMode: "metadata" });
  assert.throws(() => keepItem(app, other, item.id, basket.id), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(listItems(app, other, { scope: `source:${item.sourceId}` }).total, 0);
  // The other account's engine user cannot import into the first PURSS's sources.
  assert.equal(applySyncBatch(app, other.engineUserId, batch([entry("feed/1")])).unknownStreams, 1);
});

test("a replacement engine is adopted after its queue is reviewed", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1");
  applySyncBatch(app, p.engineUserId, batch([e], undefined, "engine-A"));
  applySyncBatch(app, p.engineUserId, batch([{ ...e, externalId: "b-1" }], undefined, "engine-B"));
  assert.equal(applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { externalId: "b-2" })], undefined, "engine-B")).queuedForReview, 1, "still reviewing");
  app.db.run("UPDATE reconciliation_queue SET status = 'dismissed'");
  const after = applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { externalId: "b-3" })], undefined, "engine-B"));
  assert.equal(after.accepted, 1, "adopted: new entries import normally");
  assert.equal(app.db.get<{ engine_identity: string }>("SELECT engine_identity FROM sync_checkpoints")!.engine_identity, "engine-B");
});

test("re-following an imported feed attaches mappings instead of duplicating", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1");
  // An imported item: same source and link, but no engine mapping.
  app.db.tx(() => insertItem(app, { accountId: p.accountId, workspaceId: p.workspaceId, sourceId: src, kind: "article", title: e.title, url: e.url, author: null,
    summaryHtml: null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null, publishedAt: e.publishedAt, discoveredAt: e.crawledAt, enclosures: [], fresh: false, reason: "import" }));
  const r = applySyncBatch(app, p.engineUserId, batch([{ ...e, originalGuid: null }]));
  assert.equal(r.accepted, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 1);
  assert.ok(app.db.get("SELECT 1 FROM external_ids WHERE external_id = ?", e.externalId));
});

test("paused sources collect nothing new until resumed", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  app.db.run("UPDATE sources SET paused = 1 WHERE id = ?", src);
  const r = applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  assert.equal(r.skippedPaused, 1);
  assert.equal(listItems(app, p, { scope: "all", filter: "all" }).total, 0);
  app.db.run("UPDATE sources SET paused = 0 WHERE id = ?", src);
  assert.equal(applySyncBatch(app, p.engineUserId, batch([entry("feed/1")])).accepted, 1);
});

test("a long post that cites a DOI is an article; a DOI link or short abstract is a paper", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const long = `<p>${"Some essay text. ".repeat(300)} See https://doi.org/10.1145/3290605.3300234 for details.</p>`;
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { title: "Essay", summaryHtml: null, contentHtml: long }),
    entry("feed/1", { title: "Abstract", summaryHtml: null, contentHtml: "<p>We study tides. doi:10.1038/s41586-026-01234-5</p>" }),
    entry("feed/1", { title: "Linked", url: "https://doi.org/10.1000/xyz123", contentHtml: null }),
  ]));
  const kinds = Object.fromEntries(listItems(app, p, { scope: "all" }).items.map((i) => [i.title, i.kind]));
  assert.deepEqual(kinds, { Essay: "article", Abstract: "paper", Linked: "paper" });
});

test("collection and basket names are unique per PURSS, ignoring case", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  createBasket(app, p, { name: "Read later", captureMode: "text" });
  assert.throws(() => createBasket(app, p, { name: " read LATER ", captureMode: "text" }), (e: unknown) => e instanceof HttpError && e.code === "duplicate_name");
  createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  assert.throws(() => createCollection(app, p, { name: "reading", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" }), (e: unknown) => e instanceof HttpError && e.code === "duplicate_name");
  const other = makeOwner(app, { admin: false });
  assert.ok(createBasket(app, other, { name: "Read later", captureMode: "text" }), "other PURSSes are independent");
});

test("a sync run with nothing new still clears the delay warning and is not re-run at once", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  app.db.run("INSERT INTO sync_checkpoints (engine_user_id, last_error, last_attempt_at) VALUES (?, 'The engine could not be reached.', '2026-01-01T00:00:00.000Z')", p.engineUserId);
  recordSyncSuccess(app, p.engineUserId);
  const cp = app.db.get<{ last_error: string | null; last_attempt_at: string }>("SELECT last_error, last_attempt_at FROM sync_checkpoints WHERE engine_user_id = ?", p.engineUserId)!;
  assert.equal(cp.last_error, null);
  assert.ok(Date.now() - Date.parse(cp.last_attempt_at) < 5000);
});

test("discovery previews (which may hold a secret link) never reach the database", async (t) => {
  const { app, cleanup } = setup();
  t.after(cleanup);
  const { holdCandidate, peekCandidate } = await import("./discovery-cache.ts");
  holdCandidate("dsc_test", "wsp_a", { feedUrl: "https://example.org/feed?token=s3cret", siteUrl: null, title: "x", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: "secret" });
  assert.equal(peekCandidate("dsc_test", "wsp_other"), null, "other PURSSes can't use the token");
  assert.equal(peekCandidate("dsc_test", "wsp_a")!.feedUrl, "https://example.org/feed?token=s3cret");
  assert.ok(!app.db.get("SELECT 1 FROM sqlite_master WHERE name = 'discovery_results'"));
});

// ---------- regressions from the implementation review ----------

test("a failed COMMIT rolls back and leaves the connection usable", (t) => {
  const { app, cleanup } = setup();
  t.after(cleanup);
  app.db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
  assert.throws(() => app.db.tx(() => { app.db.run("INSERT INTO child (pid) VALUES (42)"); }), /FOREIGN KEY/);
  assert.equal(app.db.raw.isTransaction, false, "no transaction left open");
  app.db.tx(() => { app.db.run("INSERT INTO parent (id) VALUES (1)"); });
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM parent")!.n, 1, "later transactions commit");
});

test("unfollowing before the engine finished subscribing unsubscribes there too", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { onSubscribed } = await import("./sources.ts");
  const id = makeSource(app, p, "Racy", "feed/ignored");
  app.db.run("UPDATE sources SET engine_stream_id = NULL, followed = 0 WHERE id = ?", id);
  onSubscribed(app, id, "feed/77");
  assert.equal(app.db.get<{ s: string | null }>("SELECT engine_stream_id s FROM sources WHERE id = ?", id)!.s, null);
  const job = app.db.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.unsubscribe'")!;
  assert.equal(JSON.parse(job.payload).streamId, "feed/77");
  app.db.run("UPDATE sources SET engine_stream_id = 'feed/77' WHERE id = ?", id);
  assert.equal(applySyncBatch(app, p.engineUserId, batch([entry("feed/77")])).accepted, 0, "unfollowed sources import nothing");
});

test("an edited item shows the kept copy; dropping the last pin releases the old version", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Kept title", contentHtml: "<p>KEPT BODY</p>" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  const basket = createBasket(app, p, { name: "Pins", captureMode: "metadata" });
  keepItem(app, p, item.id, basket.id);
  applySyncBatch(app, p.engineUserId, batch([{ ...e, title: "Edited", contentHtml: "<p>EDITED BODY</p>" }]));
  const d = getItemDetail(app, p, item.id);
  assert.equal(d.changedSinceKept, true);
  assert.equal(d.title, "Kept title", "the kept copy's title, not the edited one");
  assert.match(d.contentHtml!, /KEPT BODY/);
  assert.match(d.latestHtml!, /EDITED BODY/);
  const before = usedBytes(app, p.accountId);
  unkeepItem(app, p, item.id, basket.id);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM item_versions WHERE item_id = ?", item.id)!.n, 1, "only the current version remains");
  assert.ok(usedBytes(app, p.accountId) < before - 100, "the superseded version's bytes are released");
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("private sources never put item titles in notifications", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Patron feed", "feed/9", { isPrivate: true });
  app.db.run("INSERT INTO preferences (workspace_id, value, updated_at) VALUES (?, ?, ?)", p.workspaceId, JSON.stringify({ notifications: { mode: "browser", previews: true, quietStart: null, quietEnd: null } }), "x");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/9", { title: "Secret patron-only episode" })]));
  const n = app.db.get<{ title: string; body: string | null }>("SELECT title, body FROM notifications")!;
  assert.equal(n.body, null);
  assert.ok(!n.title.includes("Secret"));
});

test("an expired reservation is not subtracted twice when its capture settles late", (t) => {
  const { app, p, cleanup } = setup(3_000_000);
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  const basket = createBasket(app, p, { name: "Text", captureMode: "text" });
  keepItem(app, p, item.id, basket.id);
  app.db.run("UPDATE reservations SET expires_at = '2000-01-01T00:00:00.000Z'");
  app.db.tx(() => admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: "filler", bytes: 1_200_000, reason: "test", control: true }));
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures")!;
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text: "x".repeat(2_500_000), html: "<p>x</p>", finalUrl: "https://example.org/", bytes: 1 }));
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures")!.status, "failed", "over the allocation, so the copy is refused");
  assert.ok(usedBytes(app, p.accountId) <= 3_000_000);
});

test("a job whose lease keeps expiring stops after its attempts", async (t) => {
  const { app, cleanup } = setup();
  t.after(cleanup);
  const { enqueue, expireLeases } = await import("./jobs.ts");
  const id = enqueue(app, "engine.sync", { engineUserId: "eng_x" }, { maxAttempts: 2 });
  app.db.run("UPDATE jobs SET status = 'leased', attempts = 2, lease_id = 'l', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id);
  expireLeases(app);
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", id)!.status, "failed");
});

test("replacement-engine entries are queued once and duplicate ids don't break patches", async (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1");
  applySyncBatch(app, p.engineUserId, batch([e], undefined, "engine-A"));
  const moved = { ...e, externalId: "b-1" };
  applySyncBatch(app, p.engineUserId, batch([moved], undefined, "engine-B"));
  applySyncBatch(app, p.engineUserId, batch([moved], undefined, "engine-B"));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM reconciliation_queue")!.n, 1);
  const { patchCollection } = await import("./collections.ts");
  const col = createCollection(app, p, { name: "C", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  assert.deepEqual(patchCollection(app, p, col.id, { sourceIds: [src, src] }).sourceIds, [src]);
});

test("unfollowed sources' unkept items leave lists and search; kept ones stay; optional deletion", async (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const { unfollowSource } = await import("./sources.ts");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Kept zebra" }), entry("feed/1", { title: "Unkept zebra" })]));
  const items = listItems(app, p, { scope: "all" }).items;
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  keepItem(app, p, items.find((i) => i.title === "Kept zebra")!.id, basket.id);
  unfollowSource(app, p, src);
  assert.deepEqual(listItems(app, p, { scope: "all", q: "zebra" }).items.map((i) => i.title), ["Kept zebra"]);
  assert.equal(listItems(app, p, { scope: `basket:${basket.id}` }).total, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM items")!.n, 2, "hidden, not deleted");

  const other = makeSource(app, p, "Other", "feed/2");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/2"), entry("feed/2")]));
  const keptId = listItems(app, p, { scope: `source:${other}` }).items[0]!.id;
  keepItem(app, p, keptId, basket.id);
  const out = unfollowSource(app, p, other, { deleteUnkept: true });
  assert.deepEqual(out, { keptItems: 1, deletedItems: 1 });
  assert.ok(getItemDetail(app, p, keptId), "kept item survives");
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("a source set to notify still notifies when the PURSS setting is off; others stay silent", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const loud = makeSource(app, p, "Loud", "feed/5");
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", loud);
  app.db.run("INSERT INTO preferences (workspace_id, value, updated_at) VALUES (?, ?, ?)", p.workspaceId, JSON.stringify({ notifications: { mode: "off" } }), "x");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/5")]));
  const rows = app.db.all<{ source_id: string }>("SELECT source_id FROM notifications");
  assert.deepEqual(rows.map((r) => r.source_id), [loud]);
  assert.ok(src);
});

test("recovery-code step-up never uses up another account's code; claiming removes the setup-code file", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const { claim, ensureClaimCode, issueRecoveryCodes, useRecoveryCode } = await import("../auth/accounts.ts");
  const { existsSync } = await import("node:fs");
  const code = ensureClaimCode(app)!;
  assert.ok(existsSync(`${app.config.secretsDir}/setup-code`));
  const owner = claim(app, code, null);
  assert.ok(!existsSync(`${app.config.secretsDir}/setup-code`), "the code file goes with the claim");
  const other = makeOwner(app, { admin: false });
  const otherCodes = issueRecoveryCodes(app, other.accountId);
  assert.equal(useRecoveryCode(app, otherCodes[0]!, owner.accountId), null);
  assert.equal(useRecoveryCode(app, otherCodes[0]!), other.accountId, "the code still works for its owner");
});
