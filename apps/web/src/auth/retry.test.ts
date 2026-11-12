import test from "node:test";
import assert from "node:assert/strict";
import { tryAgainAfter } from "./retry.ts";

test("a retry later today names only the time", () => {
  assert.match(tryAgainAfter(600, new Date(2026, 10, 12, 10, 0)), /^Try again after 10:10$/);
});

test("a retry on another day says tomorrow, or gives the date", () => {
  const now = new Date(2026, 10, 12, 23, 0);
  assert.match(tryAgainAfter(2 * 3600, now), /^Try again after 01:00 tomorrow$/);
  assert.equal(tryAgainAfter(3 * 86_400, now), `Try again after 23:00 on ${new Date(2026, 10, 15).toLocaleDateString()}`);
});
