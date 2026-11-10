import { test } from "node:test";
import assert from "node:assert/strict";
import { breakpointFor } from "./hooks.ts";

test("breakpoints follow the A3 design widths exactly", () => {
  assert.equal(breakpointFor(2560), "xl");
  assert.equal(breakpointFor(1680), "xl");
  assert.equal(breakpointFor(1679), "lg");
  assert.equal(breakpointFor(1280), "lg");
  assert.equal(breakpointFor(1279), "md");
  assert.equal(breakpointFor(1024), "md");
  assert.equal(breakpointFor(1023), "sm");
  assert.equal(breakpointFor(768), "sm");
  assert.equal(breakpointFor(767), "xs");
  assert.equal(breakpointFor(390), "xs");
});
