import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedLine, sentLine } from "./messages.ts";

test("late results are said once, plainly", () => {
  assert.equal(sentLine(1), "Sent a change that was waiting.");
  assert.equal(sentLine(4), "Sent 4 changes that were waiting.");
  const one = { reason: "conflict", message: "Not changed: this item was changed on another device." } as const;
  assert.equal(droppedLine([one]), "Not changed: this item was changed on another device.");
  assert.equal(droppedLine([one, one, one]), "Not changed: 3 items were changed on another device.");
  assert.equal(droppedLine([one, { reason: "rejected", message: "Not changed. That item wasn't found." }]), "Not changed: 2 changes couldn't be applied.");
});
