import test from "node:test";
import assert from "node:assert/strict";
import { showsSavedCopy } from "./status.ts";

test("saved-copy notice shows when the browser is offline or an answer came from a saved copy", () => {
  assert.equal(showsSavedCopy({ browserOnline: true, copySavedAt: null }), false);
  assert.equal(showsSavedCopy({ browserOnline: false, copySavedAt: null }), true);
  assert.equal(showsSavedCopy({ browserOnline: true, copySavedAt: "2026-11-04T10:00:00.000Z" }), true);
});
