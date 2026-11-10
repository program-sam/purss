import test from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { leavesOn } from "./leave.ts";
import { matchesFilter } from "./items.ts";

const base: ItemDTO = {
  id: "itm_x", sourceId: "src_x", sourceTitle: "S", kind: "article", title: "T", url: "https://example.com/a", author: null, excerpt: null, imageUrl: null,
  durationSeconds: null, readMinutes: 4, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 0, stateVersion: 4, fresh: true,
  progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null,
};
const causes = (item: ItemDTO, filter: Parameters<typeof matchesFilter>[1], inBasket = false) => leavesOn(item, (i) => matchesFilter(i, filter), inBasket).split(" ").filter(Boolean);

test("a list of everything but ignored loses an item only when it is ignored", () => {
  assert.deepEqual(causes(base, "active"), ["ignored"]);
});

test("Home's open lists (New and To read) lose items that are started, finished or ignored", () => {
  assert.deepEqual(causes(base, "open"), ["inprogress", "finished", "ignored"]);
});

test("a list of new items loses one whose state changes, as PURSS clears its marker then", () => {
  assert.deepEqual(causes(base, "fresh"), ["toread", "inprogress", "finished", "ignored"]);
  assert.deepEqual(causes({ ...base, fresh: false }, "fresh"), ["toread", "inprogress", "finished", "ignored"], "an item without the marker matches no state");
});

test("a state's own list loses an item moved to any other state", () => {
  assert.deepEqual(causes({ ...base, workflow: "toread" }, "toread"), ["new", "inprogress", "finished", "ignored"]);
});

test("the ignored list loses an item when it is restored; a list of everything never loses one", () => {
  assert.deepEqual(causes({ ...base, workflow: "ignored" }, "ignored"), ["new", "toread", "inprogress", "finished", "restore"]);
  assert.deepEqual(causes({ ...base, workflow: "ignored" }, "all"), []);
});

test("a basket's list loses an item when it is taken out of the basket", () => {
  assert.deepEqual(causes(base, "all", true), ["unkeep"]);
});
