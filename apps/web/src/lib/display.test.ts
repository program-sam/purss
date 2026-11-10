import test from "node:test";
import assert from "node:assert/strict";
import { parseDisplayMode } from "./display.ts";

test("the display mode is standard unless this device chose e-ink, whatever is stored", () => {
  assert.equal(parseDisplayMode(null), "standard");
  assert.equal(parseDisplayMode("eink"), "eink");
  for (const raw of ["", "EINK", "dark", "{\"mode\":\"eink\"}", "standard"]) assert.equal(parseDisplayMode(raw), "standard", raw);
});
