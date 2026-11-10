import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeSummary } from "./teaser.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("a short text, or one cut off like an excerpt, is a summary; a whole article and nothing at all are not", () => {
  assert.equal(looksLikeSummary("<p>A few lines about the story.</p>"), true);
  assert.equal(looksLikeSummary(`<p>${words(300)} Read more…</p>`), true);
  assert.equal(looksLikeSummary(`<p>${words(300)} […]</p>`), true);
  assert.equal(looksLikeSummary(`<p>${words(300)} The post Tides appeared first on Harbour Notes.</p>`), true);
  assert.equal(looksLikeSummary(`<p>${words(300)}</p>`), false);
  assert.equal(looksLikeSummary(null), false);
  assert.equal(looksLikeSummary("<img src=\"https://example.org/a.png\">"), false, "a picture and no words is not a summary of anything");
});
