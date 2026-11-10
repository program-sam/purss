import test from "node:test";
import assert from "node:assert/strict";
import { savedSummary } from "./summary.ts";

const now = Date.parse("2026-11-04T12:00:00.000Z");

test("the saved line says how many items, and when they were last saved", () => {
  assert.equal(savedSummary(0, null, false, now), "Nothing is saved on this device yet. Items you mark To read, or keep with their text, are saved here.");
  assert.equal(savedSummary(0, null, true, now), "Saving your reading list…");
  assert.equal(savedSummary(1, "2026-11-04T11:55:00.000Z", false, now, "en-GB"), "1 item saved, last updated 5 min ago.");
  assert.equal(savedSummary(48, "2026-11-04T11:59:40.000Z", false, now, "en-GB"), "48 items saved, last updated now.");
  assert.equal(savedSummary(48, "2026-11-04T09:00:00.000Z", true, now), "48 items saved, updating…");
  assert.equal(savedSummary(3, null, false, now), "3 items saved.");
});
