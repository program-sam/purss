import test from "node:test";
import assert from "node:assert/strict";
import { ANNOTATIONS_PER_ITEM, newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { seedLibrary } from "../features-testing.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem, getItemDetail, listItems } from "./items.ts";
import { createBasket, createCollection, deleteItems, deletePreview } from "./collections.ts";
import { keepItem } from "./state.ts";
import { categories, reconcile, usedBytes } from "./storage.ts";
import { unfollowSource } from "./sources.ts";
import { previewShare, saveShare } from "./shares.ts";
import { deleteAnnotation, listAnnotations, putAnnotation } from "./annotations.ts";

type Owner = Principal & { engineUserId: string };

function setup(allocationBytes: number | null = null) {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app, { allocationBytes });
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { title: "Tidal flats", contentHtml: "<p>Mud moves with every tide. The estuary keeps a record of storms.</p>" }),
    entry("feed/1", { title: "Second post" }),
  ]));
  const ids = app.db.all<{ id: string }>("SELECT id FROM items ORDER BY seq").map((r) => r.id);
  return { app, p, src, itemId: ids[0]!, otherItemId: ids[1]!, cleanup };
}

const t0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();

function highlight(exact: string, minutes: number, body: string | null = null, target: { kind: "capture" | "version"; id: string } | null = null) {
  return { kind: "highlight" as const, quote: { exact, prefix: "", suffix: "" }, position: { start: 0, end: exact.length }, target, body, updatedAt: at(minutes) };
}
const note = (body: string, minutes: number) => ({ kind: "note" as const, body, updatedAt: at(minutes) });
const live = (app: App, p: Principal, itemId: string) => listAnnotations(app, p, itemId).annotations;

test("a highlight and a note are created with the client's ids, listed, and replaying the same write changes nothing", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const h = newId("ann");
  const n = newId("ann");
  const r1 = putAnnotation(app, p, itemId, h, highlight("Mud moves with every tide.", 0, "Key claim"));
  assert.equal(r1.applied, true);
  assert.deepEqual(r1.annotation?.quote, { exact: "Mud moves with every tide.", prefix: "", suffix: "" });
  assert.equal(r1.annotation?.body, "Key claim");
  assert.equal(r1.annotation?.createdAt, at(0), "made-at time is the client's (offline) time");
  putAnnotation(app, p, itemId, n, note("Compare with the delta paper.", 1));
  assert.deepEqual(live(app, p, itemId).map((a) => [a.id, a.kind]), [[h, "highlight"], [n, "note"]]);

  const replay = putAnnotation(app, p, itemId, h, highlight("Mud moves with every tide.", 0, "Key claim"));
  assert.equal(replay.applied, false, "an identical replay is not a newer write");
  assert.equal(replay.annotation?.body, "Key claim");
  assert.equal(live(app, p, itemId).length, 2);
  const changed = getItem(app, p, itemId).annotatedAt!;
  assert.ok(changed > at(1) && Date.parse(changed) <= Date.now(), "the item says when the server last accepted a change to its annotations");
  assert.equal(getItem(app, p, itemId).revision, 0, "annotating is not a workflow change");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_log")!.n, 0);
});

test("last write wins per annotation: an older write is ignored and returns what is stored; a newer one replaces it", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const id = newId("ann");
  putAnnotation(app, p, itemId, id, highlight("The estuary keeps a record of storms.", 5, "phone edit"));
  const older = putAnnotation(app, p, itemId, id, highlight("The estuary keeps a record of storms.", 3, "laptop edit, made earlier offline"));
  assert.equal(older.applied, false);
  assert.equal(older.annotation?.body, "phone edit");
  const newer = putAnnotation(app, p, itemId, id, highlight("The estuary keeps a record of storms.", 7, "laptop edit, later"));
  assert.equal(newer.applied, true);
  assert.equal(live(app, p, itemId)[0]!.body, "laptop edit, later");
  assert.equal(live(app, p, itemId)[0]!.createdAt, at(5), "creation time stays");
  // A clock running ahead can't claim the future: its time is capped at the server's now.
  const ahead = putAnnotation(app, p, itemId, id, highlight("The estuary keeps a record of storms.", 60 * 24 * 3650, "from a fast clock"));
  assert.ok(Date.parse(ahead.annotation!.updatedAt) <= Date.now());
  // Both writes are capped at the server's now; wait for the next millisecond so this one is newer.
  for (const start = Date.now(); Date.now() === start;) { /* next millisecond */ }
  assert.throws(() => putAnnotation(app, p, itemId, id, note("now a note", 60 * 24 * 3650 + 1)), (e: HttpError) => e.status === 400, "kind can't change");
});

test("removal leaves a text-free tombstone; late older writes don't bring it back, a newer one does; removal is idempotent", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const id = newId("ann");
  putAnnotation(app, p, itemId, id, highlight("Mud moves with every tide.", 0, "secret thought"));
  const used = usedBytes(app, p.accountId);
  const del = deleteAnnotation(app, p, itemId, id, at(2));
  assert.deepEqual(del, { annotation: null, applied: true });
  assert.ok(usedBytes(app, p.accountId) < used, "its storage record is released");
  const row = app.db.get<Record<string, unknown>>("SELECT * FROM annotations WHERE id = ?", id)!;
  assert.ok(row.deleted_at);
  for (const col of ["quote_exact", "quote_prefix", "quote_suffix", "body", "pos_start", "target_id"]) assert.equal(row[col], null, `${col} cleared`);
  assert.equal(live(app, p, itemId).length, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "all", q: "secret thought" }).total, 0, "removed text is not searchable");

  assert.equal(putAnnotation(app, p, itemId, id, highlight("Mud moves with every tide.", 1, "older edit")).applied, false, "an edit made before the removal stays removed");
  assert.equal(live(app, p, itemId).length, 0);
  assert.deepEqual(deleteAnnotation(app, p, itemId, id, at(3)), { annotation: null, applied: true }, "removing again is fine");
  assert.deepEqual(deleteAnnotation(app, p, itemId, newId("ann"), at(3)), { annotation: null, applied: true }, "removing one never received is fine");

  const back = putAnnotation(app, p, itemId, id, highlight("Mud moves with every tide.", 4, "restored from another device"));
  assert.equal(back.applied, true, "a later write wins over the removal");
  assert.equal(back.annotation?.createdAt, at(4));
  assert.equal(listItems(app, p, { scope: "all", filter: "all", q: "restored" }).total, 1);
  assert.equal(reconcile(app, p.accountId).difference, 0);

});

test("a device whose clock is far behind can still make new annotations, and no write older than a removal brings it back, however long ago", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  // A clock a year or decades behind: the annotation is new to the server, so nothing it could undo exists.
  for (const behind of [400 * day, Date.now() - Date.parse("1970-01-02T00:00:00Z")]) {
    const fresh = putAnnotation(app, p, itemId, newId("ann"), { ...note("written on a phone with a wrong clock", 0), updatedAt: iso(Date.now() - behind) });
    assert.equal(fresh.applied, true);
  }
  // The tombstone of a removal is kept, so a write made before the removal stays ignored years later.
  const id = newId("ann");
  putAnnotation(app, p, itemId, id, { ...highlight("Mud moves with every tide.", 0, "first"), updatedAt: iso(Date.now() - 10 * day) });
  deleteAnnotation(app, p, itemId, id, iso(Date.now() - 5 * day));
  app.db.run("UPDATE annotations SET received_at = ? WHERE id = ?", iso(Date.now() - 3 * 365 * day), id);
  assert.equal(putAnnotation(app, p, itemId, id, { ...highlight("Mud moves with every tide.", 0, "late edit"), updatedAt: iso(Date.now() - 7 * day) }).applied, false);
  assert.ok(app.db.get("SELECT 1 FROM annotations WHERE id = ? AND deleted_at IS NOT NULL", id), "the tombstone is still there");
  assert.equal(live(app, p, itemId).filter((a) => a.id === id).length, 0);
});

test("the item's annotatedAt moves with every write the server accepts, in server time, whatever the device's clock", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const a = newId("ann");
  const b = newId("ann");
  putAnnotation(app, p, itemId, a, highlight("Mud moves with every tide.", 60));
  const first = getItem(app, p, itemId).annotatedAt!;
  assert.ok(first);
  // A second annotation written with an older device time, then a removal with an older device time.
  const waitTick = () => { for (const start = Date.now(); Date.now() === start;) { /* next millisecond */ } };
  waitTick();
  putAnnotation(app, p, itemId, b, note("from a device with a slow clock", 1));
  const second = getItem(app, p, itemId).annotatedAt!;
  assert.ok(second > first, `${second} after ${first}`);
  waitTick();
  deleteAnnotation(app, p, itemId, b, at(2));
  const third = getItem(app, p, itemId).annotatedAt!;
  assert.ok(third > second, "a removal moves it too");
  // An ignored (older) write doesn't.
  putAnnotation(app, p, itemId, a, highlight("Mud moves with every tide.", 30));
  assert.equal(getItem(app, p, itemId).annotatedAt, third);
});

test("another PURSS can't read, write or remove annotations on this item, or take over an annotation id", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  makeSource(app, other, "Their source", "feed/9");
  applySyncBatch(app, other.engineUserId, batch([entry("feed/9", { title: "Their item" })]));
  const theirItem = app.db.get<{ id: string }>("SELECT id FROM items WHERE workspace_id = ?", other.workspaceId)!.id;
  const id = newId("ann");
  putAnnotation(app, p, itemId, id, highlight("Mud moves with every tide.", 0, "mine"));
  const notFound = (e: HttpError) => e.status === 404;
  assert.throws(() => listAnnotations(app, other, itemId), notFound);
  assert.throws(() => putAnnotation(app, other, itemId, newId("ann"), note("intruder", 1)), notFound);
  assert.throws(() => deleteAnnotation(app, other, itemId, id, at(9)), notFound);
  assert.throws(() => putAnnotation(app, other, theirItem, id, note("same id, own item", 9)), notFound, "an id in use elsewhere is never overwritten or moved");
  assert.throws(() => deleteAnnotation(app, other, theirItem, id, at(9)), notFound);
  assert.throws(() => putAnnotation(app, p, theirItem, newId("ann"), note("on their item", 1)), notFound);
  assert.equal(live(app, p, itemId)[0]!.body, "mine");
  assert.equal(listItems(app, other, { scope: "all", filter: "all", q: "mine" }).total, 0, "search never crosses PURSSes");
  // A target naming another item's (or another PURSS's) text is stored as unknown, not trusted.
  const theirVersion = app.db.get<{ id: string }>("SELECT current_version_id AS id FROM items WHERE id = ?", theirItem)!.id;
  const a = putAnnotation(app, p, itemId, newId("ann"), highlight("Mud moves", 2, null, { kind: "version", id: theirVersion }));
  assert.equal(a.annotation?.target, null);
  const ownVersion = app.db.get<{ id: string }>("SELECT current_version_id AS id FROM items WHERE id = ?", itemId)!.id;
  const b = putAnnotation(app, p, itemId, newId("ann"), highlight("Mud moves", 3, null, { kind: "version", id: ownVersion }));
  assert.deepEqual(b.annotation?.target, { kind: "version", id: ownVersion });
});

test("search finds items by comment, note and highlighted passage, in lists, search and filter collections", (t) => {
  const { app, p, itemId, otherItemId, cleanup } = setup();
  t.after(cleanup);
  putAnnotation(app, p, itemId, newId("ann"), highlight("The estuary keeps a record of storms.", 0, "Relevant to chapter three"));
  putAnnotation(app, p, otherItemId, newId("ann"), note("Ask Priya about bioturbation", 0));
  const find = (q: string) => listItems(app, p, { scope: "all", filter: "all", q }).items.map((i) => i.id);
  assert.deepEqual(find("chapter three"), [itemId]);
  assert.deepEqual(find("bioturbation"), [otherItemId]);
  assert.deepEqual(find("Priya"), [otherItemId]);
  const col = createCollection(app, p, { name: "Notes on Priya", emoji: null, mode: "query", sourceIds: [], query: { field: "text", value: "priya" }, view: "list" });
  assert.deepEqual(listItems(app, p, { scope: `collection:${col.id}`, filter: "all" }).items.map((i) => i.id), [otherItemId]);
});

test("each live annotation is one small Other record; edits re-measure it and the ledger stays exact, even over quota", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  const cats0 = categories(app, p.accountId);
  const id = newId("ann");
  putAnnotation(app, p, itemId, id, note("short", 0));
  const cats1 = categories(app, p.accountId);
  assert.ok(cats1.other > cats0.other);
  assert.equal(cats1.kept, cats0.kept, "an annotation is not kept content");
  assert.equal(cats1.feed, cats0.feed);
  putAnnotation(app, p, itemId, id, note("a much longer note than before, with more words in it", 1));
  assert.ok(categories(app, p.accountId).other > cats1.other);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE ref_id = ? AND released_at IS NULL", `annotation:${id}`)!.n, 1);
  assert.equal(reconcile(app, p.accountId).difference, 0);
  // A full quota still lets the person write a note (bounded headroom, like workflow changes).
  app.db.run("UPDATE storage_accounts SET allocation_bytes = ? WHERE account_id = ?", usedBytes(app, p.accountId), p.accountId);
  assert.equal(putAnnotation(app, p, itemId, newId("ann"), note("written while full", 2)).applied, true);
});

test("an item holds a bounded number of annotations", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  for (let i = 0; i < ANNOTATIONS_PER_ITEM; i++) {
    app.db.run(`INSERT INTO annotations (id, account_id, workspace_id, item_id, kind, body, created_at, updated_at) VALUES (?, ?, ?, ?, 'note', 'n', ?, ?)`,
      newId("ann"), p.accountId, p.workspaceId, itemId, at(0), at(0));
  }
  assert.throws(() => putAnnotation(app, p, itemId, newId("ann"), note("one too many", 1)), (e: HttpError) => e.code === "too_many");
});

test("the reader says which stored text it shows: the capture, the kept copy or the current version", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app) as Owner;
  const lib = seedLibrary(app, p);
  const captured = getItemDetail(app, p, lib.pinnedOld.itemId);
  assert.deepEqual(captured.contentRef, { kind: "capture", id: lib.captureId });
  assert.equal(captured.changedSinceKept, true);
  const current = app.db.get<{ id: string }>("SELECT current_version_id AS id FROM items WHERE id = ?", lib.pinnedOld.itemId)!.id;
  assert.deepEqual(captured.latestRef, { kind: "version", id: current });
  // Without the capture, the kept copy is shown and named.
  app.db.run("UPDATE captures SET status = 'failed' WHERE id = ?", lib.captureId);
  assert.deepEqual(getItemDetail(app, p, lib.pinnedOld.itemId).contentRef, { kind: "version", id: lib.pinnedOld.versionId });
  const plain = getItemDetail(app, p, lib.itemIds[2]);
  const plainVersion = app.db.get<{ id: string }>("SELECT current_version_id AS id FROM items WHERE id = ?", lib.itemIds[2])!.id;
  assert.deepEqual(plain.contentRef, { kind: "version", id: plainVersion });
  assert.equal(plain.latestRef, null);
});

test("unfollowing never deletes an annotated item; a confirmed delete names it and takes its annotations", (t) => {
  const { app, p, src, itemId, otherItemId, cleanup } = setup();
  t.after(cleanup);
  app.db.run("UPDATE items SET published_at = '2020-01-01T00:00:00.000Z'");
  app.db.run("UPDATE item_state SET workflow = 'finished'");
  const annId = newId("ann");
  putAnnotation(app, p, itemId, annId, note("my thoughts on tides", 0));
  putAnnotation(app, p, otherItemId, newId("ann"), note("annotated in between", 0));

  // Unfollowing with "delete what you haven't kept" leaves annotated items, and they stay visible and findable.
  const out = unfollowSource(app, p, src, { deleteUnkept: true });
  assert.equal(out.deletedItems, 0);
  assert.deepEqual(listItems(app, p, { scope: "all", filter: "all" }).items.map((i) => i.id).sort(), [itemId, otherItemId].sort());
  assert.deepEqual(listItems(app, p, { scope: "all", filter: "all", q: "tides" }).items.map((i) => i.id), [itemId]);

  // An explicit permanent delete warns about the person's writing and removes it with the item.
  const dp = deletePreview(app, p, [itemId]);
  assert.deepEqual(dp.annotatedItems, [{ id: itemId, title: "Tidal flats", annotations: 1 }]);
  deleteItems(app, p, dp.confirmToken);
  assert.equal(app.db.get("SELECT 1 FROM annotations WHERE id = ?", annId), undefined);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE ref_id = ? AND released_at IS NULL", `annotation:${annId}`)!.n, 0);
  assert.equal(listItems(app, p, { scope: "all", filter: "all", q: "tides" }).total, 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("annotating doesn't keep, and keeping doesn't annotate; shared pages never carry annotations", (t) => {
  const { app, p, itemId, cleanup } = setup();
  t.after(cleanup);
  putAnnotation(app, p, itemId, newId("ann"), highlight("Mud moves with every tide.", 0, "PRIVATE-COMMENT-1234"));
  assert.deepEqual(getItem(app, p, itemId).basketIds, []);
  const basket = createBasket(app, p, { name: "Thesis", captureMode: "metadata" });
  keepItem(app, p, itemId, basket.id);
  assert.equal(live(app, p, itemId).length, 1);
  const share = saveShare(app, p, "basket", basket.id, { curatorName: "Me", description: null, listed: false });
  const page = previewShare(app, p, share.id);
  assert.ok(page.html.includes("Tidal") || page.itemCount === 1, "the kept item is on the page");
  assert.ok(!JSON.stringify(page).includes("PRIVATE-COMMENT-1234"));
});
