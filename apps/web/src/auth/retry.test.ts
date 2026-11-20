import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/copy/app";
import { tryAgainAfter } from "./retry.ts";

const t = app.auth.retry;

test("a retry later today names only the time", () => {
  assert.equal(tryAgainAfter(600, new Date(2026, 10, 12, 10, 0)), t.tryAgainAfter("10:10", ""));
});

test("a retry on another day says tomorrow, or gives the date", () => {
  const now = new Date(2026, 10, 12, 23, 0);
  assert.equal(tryAgainAfter(2 * 3600, now), t.tryAgainAfter("01:00", t.tomorrow));
  assert.equal(tryAgainAfter(3 * 86_400, now), t.tryAgainAfter("23:00", t.onDate(new Date(2026, 10, 15).toLocaleDateString())));
});
