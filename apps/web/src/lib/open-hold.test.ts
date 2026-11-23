import test from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { createOpenHold, withOpenItem } from "./open-hold.ts";
import { matchesFilter } from "./items.ts";

const item = (id: string, over: Partial<ItemDTO> = {}): ItemDTO => ({ id, isNew: false, workflow: "undecided", ...over }) as ItemDTO;
const ids = (list: ItemDTO[]) => list.map((i) => i.id);
const tick = () => new Promise((r) => setTimeout(r, 1));
const isNew = (i: ItemDTO) => matchesFilter(i, "new");

test("only an item that was New when opened is held, and opening another moves or ends the hold", () => {
  const h = createOpenHold();
  h.open(item("a", { isNew: true }));
  assert.equal(h.get(), "a");
  h.open(item("b", { isNew: false }));
  assert.equal(h.get(), null);
  h.open(item("c", { isNew: true }));
  assert.equal(h.get(), "c");
});

test("closing the panel ends the hold a moment later; a replayed effect that stays keeps it", async () => {
  const h = createOpenHold();
  let calls = 0;
  h.subscribe(() => { calls += 1; });
  h.open(item("a", { isNew: true }));
  h.release();
  h.stay();
  await tick();
  assert.equal(h.get(), "a", "a StrictMode replay does not end the hold");
  h.release();
  await tick();
  assert.equal(h.get(), null, "a real close does");
  assert.equal(calls, 2);
});

test("the held item keeps its place in New, marked New, after opening took the marker away", () => {
  const list = [item("x", { isNew: true }), item("a"), item("y", { isNew: true })];
  const shown = withOpenItem(list, isNew, "a");
  assert.deepEqual(ids(shown), ["x", "a", "y"]);
  assert.equal(shown[1]!.isNew, true);
  assert.deepEqual(ids(withOpenItem(list, isNew, null)), ["x", "y"], "once closed it leaves");
});

test("only being seen is put off: an open item that is ignored still leaves", () => {
  const list = [item("a", { workflow: "ignored" }), item("y", { isNew: true })];
  assert.deepEqual(ids(withOpenItem(list, isNew, "a")), ["y"]);
  assert.deepEqual(ids(withOpenItem(list, (i) => matchesFilter(i, "all"), "a")), ["y"]);
});

test("a reloaded list without the held item gets it back where it showed before", () => {
  const before = [item("x", { isNew: true }), item("a", { isNew: true }), item("y", { isNew: true })];
  const reloaded = [item("x", { isNew: true }), item("y", { isNew: true })];
  const shown = withOpenItem(reloaded, isNew, "a", item("a"), before);
  assert.deepEqual(ids(shown), ["x", "a", "y"]);
  assert.equal(shown[1]!.isNew, true);
  assert.deepEqual(ids(withOpenItem(reloaded, isNew, "a", item("a"), [])), ["x", "y"], "an item the list never showed is not added");
});
