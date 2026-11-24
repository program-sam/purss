import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUE_STATES, STATE_FILTERS, WORKFLOW_STATES, deviceStateFilterKeeps, isQueued, stateFilterKeeps } from "./workflow.ts";

const cells = WORKFLOW_STATES.flatMap((w) => [false, true].map((isNew) => [w, isNew] as const));
const kept = (keeps: typeof stateFilterKeeps, filter: (typeof STATE_FILTERS)[number]) => cells.filter(([w, isNew]) => keeps(filter, w, isNew)).map(([w, isNew]) => `${w}${isNew ? "+new" : ""}`);

test("a state filter keeps the items its name says, whatever New marker they carry", () => {
  assert.deepEqual(kept(stateFilterKeeps, "all"), ["undecided", "undecided+new", "toread", "toread+new", "inprogress", "inprogress+new", "finished", "finished+new"]);
  assert.equal(kept(stateFilterKeeps, "all_with_ignored").length, 10);
  assert.deepEqual(kept(stateFilterKeeps, "new"), ["undecided+new", "toread+new", "inprogress+new", "finished+new", "ignored+new"], "the marker, whatever the workflow state: Undo can put it back on an Ignored item");
  for (const w of WORKFLOW_STATES) assert.deepEqual(kept(stateFilterKeeps, w), [w, `${w}+new`], w);
});

test("a device that has just ignored an item no longer lists it as New, and judges every other filter as the server stores it", () => {
  assert.deepEqual(kept(deviceStateFilterKeeps, "new"), ["undecided+new", "toread+new", "inprogress+new", "finished+new"]);
  for (const filter of STATE_FILTERS.filter((f) => f !== "new")) assert.deepEqual(kept(deviceStateFilterKeeps, filter), kept(stateFilterKeeps, filter), filter);
});

test("the queue is what is put aside and what is started", () => {
  assert.deepEqual(WORKFLOW_STATES.filter(isQueued), [...QUEUE_STATES]);
  assert.deepEqual(QUEUE_STATES, ["toread", "inprogress"]);
});
