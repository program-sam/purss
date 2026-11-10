import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem, listItems } from "./items.ts";
import { applyUndo, bulk, changeState, clearFreshAll, keepWithUndo } from "./state.ts";
import { basketDeletePreview, createBasket, deleteBasket } from "./collections.ts";
import { keepLink } from "./links.ts";
import { setPreferences } from "./preferences.ts";
import { expireFreshMarkers } from "./returning.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1"), entry("feed/1")]));
  const items = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  return { app, p, src, items, cleanup };
}
const rev = (app: ReturnType<typeof setup>["app"], p: ReturnType<typeof setup>["p"], id: string) => getItem(app, p, id).revision;

test("a change that only sets or clears the New marker, or records opening, does not move the item's revision", (t) => {
  const { app, p, src, items, cleanup } = setup();
  t.after(cleanup);
  const [a, b, c] = items;
  const before = items.map((i) => i.revision);

  changeState(app, p, a!.id, { fresh: false, expectedRevision: a!.revision });
  assert.equal(rev(app, p, a!.id), before[0], "single change of the marker");
  assert.equal(getItem(app, p, a!.id).fresh, false);

  const opened = changeState(app, p, b!.id, { opened: true, expectedRevision: b!.revision });
  assert.equal(opened.item.revision, before[1], "opening clears New and records the time, nothing guarded by the revision");
  assert.equal(opened.item.fresh, false);
  assert.equal(opened.item.opened, true);

  const done = bulk(app, p, [c!.id], { type: "clearFresh" });
  assert.equal(done.changed, 1);
  assert.equal(rev(app, p, c!.id), before[2], "bulk clear");

  // Undo restores the marker without moving it either.
  applyUndo(app, p, done.undoToken);
  assert.equal(getItem(app, p, c!.id).fresh, true);
  assert.equal(rev(app, p, c!.id), before[2], "Undo of a cleared marker");
  const allDone = clearFreshAll(app, p, `source:${src}`);
  assert.equal(allDone.changed, 1, "only c is New (a and b were cleared above)");
  assert.deepEqual(items.map((i) => rev(app, p, i.id)), before, "clear all");
  applyUndo(app, p, allDone.undoToken!);
  assert.deepEqual(items.map((i) => rev(app, p, i.id)), before, "Undo of clear all");
});

test("a workflow change still moves the revision once, and a stale writer is still refused", (t) => {
  const { app, p, items, cleanup } = setup();
  t.after(cleanup);
  const [a] = items;
  // Finishing clears New in the same change: one move, not two.
  const out = changeState(app, p, a!.id, { workflow: "finished", expectedRevision: a!.revision });
  assert.equal(out.item.revision, a!.revision + 1);
  assert.equal(out.item.fresh, false);
  // A change made against the revision before that is refused.
  assert.throws(() => changeState(app, p, a!.id, { workflow: "toread", expectedRevision: a!.revision }), (err: unknown) => err instanceof HttpError && err.status === 409);
  // Reading progress is guarded too.
  const read = changeState(app, p, a!.id, { progress: 0.4, expectedRevision: out.item.revision });
  assert.equal(read.item.revision, out.item.revision + 1);
  // Bulk workflow changes move it once per item.
  const [, b] = items;
  assert.equal(bulk(app, p, [b!.id], { type: "workflow", workflow: "ignored" }).changed, 1);
  assert.equal(rev(app, p, b!.id), b!.revision + 1);
});

test("a change queued before the marker was cleared, whose answer was lost, still applies to the cleared item", (t) => {
  const { app, p, items, cleanup } = setup();
  t.after(cleanup);
  const [a] = items;
  // The clear committed; the answer never arrived, so it is sent again and finds nothing to do.
  assert.equal(bulk(app, p, [a!.id], { type: "clearFresh" }).changed, 1);
  assert.equal(bulk(app, p, [a!.id], { type: "clearFresh" }).changed, 0);
  // The workflow change, made on the revision from before the clear, goes through.
  const out = changeState(app, p, a!.id, { workflow: "toread", expectedRevision: a!.revision });
  assert.equal(out.item.workflow, "toread");
  // A workflow write made elsewhere is still caught: the same stale change is now refused.
  assert.throws(() => changeState(app, p, a!.id, { workflow: "finished", expectedRevision: a!.revision }), (err: unknown) => err instanceof HttpError && err.status === 409);
});

test("the state version moves on every change to an item's state, by every writer, and never reads the clock", async (t) => {
  const { app, p, src, items, cleanup } = setup();
  t.after(cleanup);
  const [a, b, c] = items;
  // A clock far ahead of every write: an ordering built on timestamps would take each new change for the older one.
  app.db.run("UPDATE item_state SET updated_at = '2999-01-01T00:00:00.000Z'");
  const ver = (id: string) => getItem(app, p, id).stateVersion;
  const rv = (id: string) => getItem(app, p, id).revision;
  const grows = (id: string, what: string, act: () => unknown, by = 1) => {
    const before = ver(id);
    act();
    assert.equal(ver(id), before + by, what);
  };
  assert.deepEqual(items.map((i) => i.stateVersion), [0, 0, 0], "an item nothing has changed is at version 0");

  // Single changes, and the Undo of each.
  grows(a!.id, "clearing the marker", () => changeState(app, p, a!.id, { fresh: false, expectedRevision: rv(a!.id) }));
  let token = "";
  grows(b!.id, "opening (the marker and the opened time in one write)", () => { token = changeState(app, p, b!.id, { opened: true, expectedRevision: rv(b!.id) }).undoToken; });
  // Opening again, with the marker already gone and the time already recorded, changes nothing.
  const settled = ver(b!.id);
  changeState(app, p, b!.id, { opened: true, expectedRevision: rv(b!.id) });
  changeState(app, p, b!.id, { opened: true, expectedRevision: rv(b!.id) });
  assert.equal(ver(b!.id), settled, "a repeated opening is not a change");
  // But once the marker is back (the Undo of the first opening), opening clears it again, and that is a change.
  grows(b!.id, "Undo of opening (the marker comes back)", () => applyUndo(app, p, token));
  grows(b!.id, "opening again clears the marker that came back", () => changeState(app, p, b!.id, { opened: true, expectedRevision: rv(b!.id) }));
  assert.equal(getItem(app, p, b!.id).fresh, false);
  grows(a!.id, "workflow", () => { token = changeState(app, p, a!.id, { workflow: "toread", expectedRevision: rv(a!.id) }).undoToken; });
  grows(a!.id, "Undo of a workflow change", () => applyUndo(app, p, token));
  grows(a!.id, "reading progress", () => { token = changeState(app, p, a!.id, { progress: 0.5, expectedRevision: rv(a!.id) }).undoToken; });
  grows(a!.id, "Undo of reading progress", () => applyUndo(app, p, token));
  assert.equal(ver(a!.id), 5);

  // Several items at once. Finishing a New item changes the workflow and clears the marker in one write; its Undo is two steps.
  grows(c!.id, "bulk workflow", () => { token = bulk(app, p, [c!.id], { type: "workflow", workflow: "finished" }).undoToken; });
  grows(c!.id, "Undo of a bulk workflow change (the workflow and the marker, one write each)", () => applyUndo(app, p, token), 2);
  grows(c!.id, "bulk clear", () => { token = bulk(app, p, [c!.id], { type: "clearFresh" }).undoToken; });
  grows(c!.id, "Undo of a bulk clear", () => applyUndo(app, p, token));
  grows(c!.id, "clear all", () => { token = clearFreshAll(app, p, `source:${src}`).undoToken!; });
  grows(c!.id, "Undo of clear all", () => applyUndo(app, p, token));

  // The marker running out is a change too.
  app.db.run("UPDATE items SET discovered_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", c!.id);
  setPreferences(app, p.workspaceId, { freshDays: 30 });
  grows(c!.id, "the marker expiring", () => assert.equal(expireFreshMarkers(app, p.workspaceId), 1));

  // Which baskets hold an item is part of its copy (basketIds), so keeping moves the version too. The revision stays, and so does
  // updated_at: Home orders the items in progress by it, and keeping an item is not reading it.
  const FAR = "2999-01-01T00:00:00.000Z";
  app.db.run("UPDATE item_state SET updated_at = ?", FAR);
  const revisions = [a, b, c].map((i) => rv(i!.id));
  const growsAll = (ids: string[], what: string, act: () => unknown) => {
    const before = ids.map(ver);
    act();
    assert.deepEqual(ids.map(ver), before.map((v) => v + 1), what);
  };
  const baskets = (id: string) => getItem(app, p, id).basketIds;
  const later = createBasket(app, p, { name: "Later", captureMode: "metadata" }).id;
  const reading = createBasket(app, p, { name: "Reading", captureMode: "metadata" }).id;

  grows(a!.id, "keep", () => { token = keepWithUndo(app, p, a!.id, later, true).undoToken; });
  assert.deepEqual(baskets(a!.id), [later]);
  grows(a!.id, "Undo of a keep", () => applyUndo(app, p, token));
  assert.deepEqual(baskets(a!.id), []);
  grows(a!.id, "keep again", () => keepWithUndo(app, p, a!.id, later, true));
  grows(a!.id, "un-keep", () => { token = keepWithUndo(app, p, a!.id, later, false).undoToken; });
  assert.deepEqual(baskets(a!.id), []);
  grows(a!.id, "Undo of an un-keep", () => applyUndo(app, p, token));
  assert.deepEqual(baskets(a!.id), [later]);

  growsAll([a!.id, b!.id, c!.id], "bulk keep", () => { token = bulk(app, p, [a!.id, b!.id, c!.id], { type: "keep", basketId: reading }).undoToken; });
  growsAll([a!.id, b!.id, c!.id], "Undo of a bulk keep", () => applyUndo(app, p, token));
  bulk(app, p, [a!.id, b!.id], { type: "keep", basketId: reading });
  growsAll([a!.id, b!.id], "bulk un-keep", () => bulk(app, p, [a!.id, b!.id], { type: "unkeep", basketId: reading }));
  assert.deepEqual(baskets(b!.id), []);

  const hand = await keepLink(app, p, { url: "https://example.org/essay", basketId: later }, async () => null);
  assert.deepEqual(getItem(app, p, hand.itemId).basketIds, [later]);
  assert.equal(ver(hand.itemId), 1, "a link kept by hand is created and kept in one go: its copy already holds the basket");

  // Nothing to keep or un-keep, nothing moves.
  const stable = [a!.id, b!.id].map(ver);
  assert.equal(bulk(app, p, [a!.id], { type: "keep", basketId: later }).changed, 0, "already kept");
  assert.equal(bulk(app, p, [b!.id], { type: "unkeep", basketId: later }).changed, 0, "not kept");
  assert.deepEqual([a!.id, b!.id].map(ver), stable);

  // Deleting a basket takes its items out of it.
  const members = [a!.id, hand.itemId];
  growsAll(members, "deleting a basket", () => deleteBasket(app, p, later, basketDeletePreview(app, p, later).confirmToken));
  assert.deepEqual(members.map(baskets), [[], []]);

  assert.deepEqual([a, b, c].map((i) => rv(i!.id)), revisions, "keeping and un-keeping never move the revision");
  assert.equal(app.db.all("SELECT 1 FROM item_state WHERE item_id IN (?, ?, ?) AND updated_at <> ?", a!.id, b!.id, c!.id, FAR).length, 0, "nor the time Home orders by");

  // Nothing changed, nothing moves.
  const before = [a, b, c].map((i) => ver(i!.id));
  assert.equal(bulk(app, p, [a!.id, b!.id, c!.id], { type: "clearFresh" }).changed, 0);
  changeState(app, p, a!.id, { expectedRevision: rv(a!.id) });
  assert.deepEqual([a, b, c].map((i) => ver(i!.id)), before, "a request that changes nothing leaves the version alone");
});
