import test from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { leavesOn } from "./leave.ts";
import { matchesFilter } from "./items.ts";

const base: ItemDTO = {
  id: "itm_x", number: 1, sourceId: "src_x", sourceTitle: "S", keptByHand: false, kind: "article", title: "T", url: "https://example.com/a", author: null, excerpt: null, imageUrl: null,
  durationSeconds: null, readMinutes: 4, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", listedAt: "2026-11-03T08:00:00Z", workflow: "undecided", revision: 0, workflowRevision: 0, playbackWorkflowSessionId: null, stateVersion: 4, isNew: true,
  progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null,
};
const causes = (item: ItemDTO, filter: Parameters<typeof matchesFilter>[1], inBasket = false) => leavesOn(item, (i) => matchesFilter(i, filter), inBasket).split(" ").filter(Boolean);

test("a list of everything but ignored loses an item only when it is ignored", () => {
  assert.deepEqual(causes(base, "all"), ["ignored"]);
});

test("Home's lists (Undecided items) lose an item put aside, started, finished or ignored", () => {
  assert.deepEqual(causes(base, "undecided"), ["toread", "inprogress", "finished", "ignored"]);
});

test("a list of new items loses one whose state changes, as PURSS clears its marker then", () => {
  assert.deepEqual(causes(base, "new"), ["toread", "inprogress", "finished", "ignored"]);
  assert.deepEqual(causes({ ...base, isNew: false }, "new"), ["toread", "inprogress", "finished", "ignored"], "an item without the marker matches no state");
});

test("a state's own list loses an item moved to any other state", () => {
  assert.deepEqual(causes({ ...base, workflow: "toread" }, "toread"), ["undecided", "inprogress", "finished", "ignored"]);
});

test("the ignored list loses an item when it is restored; a list of everything never loses one", () => {
  assert.deepEqual(causes({ ...base, workflow: "ignored" }, "ignored"), ["undecided", "toread", "inprogress", "finished", "restore"]);
  assert.deepEqual(causes({ ...base, workflow: "ignored" }, "all_with_ignored"), []);
});

test("a basket's list loses an item when it is taken out of the basket", () => {
  assert.deepEqual(causes(base, "all_with_ignored", true), ["unkeep"]);
});
