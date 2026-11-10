import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, parseTextSize, rootFontSize } from "./text-size.ts";

test("only the offered sizes are accepted from storage; anything else is the normal size", () => {
  assert.deepEqual([...TEXT_SIZES], [100, 115, 130, 150]);
  assert.equal(parseTextSize("130"), 130);
  assert.equal(parseTextSize("150"), 150);
  assert.equal(parseTextSize("90"), DEFAULT_TEXT_SIZE);
  assert.equal(parseTextSize("huge"), DEFAULT_TEXT_SIZE);
  assert.equal(parseTextSize(null), DEFAULT_TEXT_SIZE);
});

test("the root font size is a percentage of the browser's own, and nothing at the normal size", () => {
  assert.equal(rootFontSize(100), "");
  assert.equal(rootFontSize(115), "115%");
  assert.equal(rootFontSize(150), "150%");
});
