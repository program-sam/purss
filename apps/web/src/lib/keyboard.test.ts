import test from "node:test";
import assert from "node:assert/strict";
import { keyboardLikely } from "./keyboard.ts";

test("a keyboard is likely with a mouse or trackpad and not on a touch screen alone", () => {
  assert.equal(keyboardLikely((q) => q === "(pointer: fine)"), true, "a laptop or desktop");
  assert.equal(keyboardLikely((q) => q === "(pointer: coarse)"), false, "a phone or tablet");
  assert.equal(keyboardLikely(() => false), false, "unknown counts as no keyboard");
});
