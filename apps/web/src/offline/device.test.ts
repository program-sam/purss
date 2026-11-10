import test from "node:test";
import assert from "node:assert/strict";
import { parseChoice, resolveEnabled } from "./device.ts";

test("offline reading follows how the app runs until the person chooses", () => {
  assert.equal(resolveEnabled(null, true, true), true, "installed: on");
  assert.equal(resolveEnabled(null, false, true), false, "browser tab: off");
  assert.equal(resolveEnabled("off", true, true), false, "an explicit off wins in an installed app");
  assert.equal(resolveEnabled("on", false, true), true, "an explicit on wins in a tab");
});

test("it can never be on where the browser can't keep copies", () => {
  assert.equal(resolveEnabled("on", true, false), false);
  assert.equal(resolveEnabled(null, true, false), false);
});

test("a damaged saved choice means no choice yet", () => {
  assert.equal(parseChoice(null), null);
  assert.equal(parseChoice("maybe"), null);
  assert.equal(parseChoice("on"), "on");
  assert.equal(parseChoice("off"), "off");
});
