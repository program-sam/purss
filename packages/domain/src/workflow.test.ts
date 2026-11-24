import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUE_STATES, STATE_FILTERS, WORKFLOW_STATES, isQueued, stateFilterKeeps } from "./workflow.ts";

test("a state filter keeps the items its name says, whatever New marker they carry", () => {
  const kept = (filter: (typeof STATE_FILTERS)[number]) => WORKFLOW_STATES.flatMap((w) => [false, true].map((isNew) => [w, isNew] as const)).filter(([w, isNew]) => stateFilterKeeps(filter, w, isNew)).map(([w, isNew]) => `${w}${isNew ? "+new" : ""}`);
  assert.deepEqual(kept("all"), ["undecided", "undecided+new", "toread", "toread+new", "inprogress", "inprogress+new", "finished", "finished+new"]);
  assert.equal(kept("all_with_ignored").length, 10);
  assert.deepEqual(kept("new"), ["undecided+new", "toread+new", "inprogress+new", "finished+new"], "an Ignored item is never New, even before a device has heard the server clear the marker");
  for (const w of WORKFLOW_STATES) assert.deepEqual(kept(w), [w, `${w}+new`], w);
});

test("the queue is what is put aside and what is started", () => {
  assert.deepEqual(WORKFLOW_STATES.filter(isQueued), [...QUEUE_STATES]);
  assert.deepEqual(QUEUE_STATES, ["toread", "inprogress"]);
});
