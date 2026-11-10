import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem, listItems } from "./items.ts";
import { applyUndo, bulk, changeState, keepWithUndo } from "./state.ts";
import { createBasket } from "./collections.ts";

function setup(entries = 1) {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app, { allocationBytes: null });
  makeSource(app, p, "Sediment Letters", "feed/1");
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: entries }, () => entry("feed/1"))));
  const ids = listItems(app, p, { scope: "all" }).items.map((i) => i.id);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  return { app, p, ids, basket, cleanup };
}

test("opening, reading progress and workflow changes clear the New marker; Undo restores it", (t) => {
  const { app, p, ids, cleanup } = setup(3);
  t.after(cleanup);
  const [a, b, c] = ids as [string, string, string];
  for (const id of ids) assert.equal(getItem(app, p, id).fresh, true);

  changeState(app, p, a, { opened: true, expectedRevision: getItem(app, p, a).revision });
  assert.equal(getItem(app, p, a).fresh, false, "opened");

  changeState(app, p, b, { progress: 0.3, expectedRevision: getItem(app, p, b).revision });
  assert.equal(getItem(app, p, b).fresh, false, "read partway");

  const marked = changeState(app, p, c, { workflow: "toread", expectedRevision: getItem(app, p, c).revision });
  assert.equal(getItem(app, p, c).fresh, false, "marked To read");
  assert.equal(getItem(app, p, c).workflow, "toread");
  applyUndo(app, p, marked.undoToken);
  assert.equal(getItem(app, p, c).fresh, true, "Undo restores the marker");
  assert.equal(getItem(app, p, c).workflow, "new");
});

test("keeping and bulk workflow changes clear the New marker; Undo restores it", (t) => {
  const { app, p, ids, basket, cleanup } = setup(3);
  t.after(cleanup);
  const [a, b, c] = ids as [string, string, string];

  const kept = keepWithUndo(app, p, a, basket.id, true);
  assert.equal(kept.item.fresh, false, "kept");
  applyUndo(app, p, kept.undoToken);
  assert.equal(getItem(app, p, a).fresh, true);
  assert.deepEqual(getItem(app, p, a).basketIds, []);

  const many = bulk(app, p, [b, c], { type: "workflow", workflow: "finished" });
  assert.equal(getItem(app, p, b).fresh, false);
  assert.equal(getItem(app, p, c).fresh, false);
  applyUndo(app, p, many.undoToken);
  assert.equal(getItem(app, p, b).fresh, true);
  assert.equal(getItem(app, p, c).workflow, "new");

  // A no-op (already in that state or basket) is not an interaction and leaves the marker alone.
  bulk(app, p, [b], { type: "workflow", workflow: "new" });
  bulk(app, p, [b], { type: "unkeep", basketId: basket.id });
  assert.equal(getItem(app, p, b).fresh, true);
  const keptMany = bulk(app, p, [b], { type: "keep", basketId: basket.id });
  assert.equal(getItem(app, p, b).fresh, false);
  applyUndo(app, p, keptMany.undoToken);
  assert.equal(getItem(app, p, b).fresh, true);
  assert.deepEqual(getItem(app, p, b).basketIds, []);
});
