import test from "node:test";
import assert from "node:assert/strict";
import { VISIT_PING_MIN_MS, shouldPing } from "./visit.ts";

test("the visit call goes out from a visible page, and then not more often than every few minutes", () => {
  assert.equal(shouldPing(null, 1000, true), true, "the first interaction");
  assert.equal(shouldPing(null, 1000, false), false, "a hidden tab is not the person being here");
  assert.equal(shouldPing(1000, 1000 + 60_000, true), false, "a minute later");
  assert.equal(shouldPing(1000, 1000 + VISIT_PING_MIN_MS, true), true, "after the wait");
  assert.equal(shouldPing(1000, 1000 + VISIT_PING_MIN_MS, false), false);
});
