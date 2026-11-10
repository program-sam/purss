import { test } from "node:test";
import assert from "node:assert/strict";
import { coverPieces, describe, indexSegments, locate, normalizeText, rawOffsetOf, segmentAt, toNormalized, toRaw } from "./anchor.ts";

test("the reader's text collapses white space and puts one space at block boundaries", () => {
  const segs = ["  Mud  moves\n", null, "with ", null, null, "every", " tide. "];
  const index = indexSegments(segs);
  assert.equal(index.text, "Mud moves with every tide.");
  assert.equal(normalizeText("  Mud \n moves "), "Mud moves");
  // Every character maps back to its place in the raw text.
  const raw = segs.map((s) => s ?? "").join("");
  for (let i = 0; i < index.text.length; i++) {
    if (index.text[i] !== " ") assert.equal(raw[index.raw[i]!], index.text[i]);
  }
  assert.equal(indexSegments([]).text, "");
  assert.equal(indexSegments([null, "   "]).text, "");
});

test("a selection in the raw text becomes a trimmed passage, and back again", () => {
  const segs = ["The estuary ", "keeps a record", null, "of storms."];
  const index = indexSegments(segs);
  // Select from inside "estuary " (the trailing space) to the end of "record".
  const start = rawOffsetOf(index, 0, 11);
  const end = rawOffsetOf(index, 1, 14);
  const pos = toNormalized(index, start, end)!;
  assert.equal(index.text.slice(pos.start, pos.end), "keeps a record", "white space at the edges is left out");
  const back = toRaw(index, pos);
  assert.deepEqual(segmentAt(index, back.start), { seg: 1, offset: 0 });
  assert.deepEqual(segmentAt(index, back.end, "end"), { seg: 1, offset: 14 });
  assert.deepEqual(segmentAt(index, back.end), { seg: 3, offset: 0 }, "as a start point, the same offset opens the next text");
  assert.equal(toNormalized(index, rawOffsetOf(index, 0, 3), rawOffsetOf(index, 0, 4)), null, "only white space selected");
});

test("a passage is found at its hint, by its context among repeats, or not at all", () => {
  const text = "The tide rose. The tide fell. Then the tide rose again.";
  const second = text.indexOf("tide fell");
  const sel = describe(text, { start: second, end: second + 4 });
  assert.equal(sel.quote.exact, "tide");
  assert.deepEqual(locate(text, sel.quote, sel.position), sel.position, "same text: at the hint");

  // The text gained a sentence at the start: the hint is wrong, the context finds the same "tide".
  const edited = "A note first. " + text;
  const found = locate(edited, sel.quote, sel.position)!;
  assert.equal(edited.slice(found.start - 4, found.end + 5), "The tide fell");

  // Without a hint the context alone decides.
  const third = describe(text, { start: text.lastIndexOf("tide"), end: text.lastIndexOf("tide") + 4 });
  const again = locate(edited, third.quote, null)!;
  assert.equal(edited.slice(again.start - 4, again.end), "the tide");
  assert.equal(edited.slice(again.end, again.end + 5), " rose");

  // Gone from the text: detached, never guessed.
  assert.equal(locate("Completely different text.", sel.quote, sel.position), null);
  // White space differences in an imported quote don't matter.
  assert.deepEqual(locate(text, { exact: "tide \n fell", prefix: "", suffix: "" }, null), { start: second, end: second + 9 });
  assert.equal(locate(text, { exact: "   ", prefix: "", suffix: "" }, null), null);
});

test("overlapping highlights split text nodes into shared pieces", () => {
  const segs = ["Mud moves ", "with every tide."];
  const index = indexSegments(segs);
  const pos = (s: string) => { const i = index.text.indexOf(s); return { start: i, end: i + s.length }; };
  const pieces = coverPieces(index, segs, [{ id: "a", pos: pos("moves with") }, { id: "b", pos: pos("with every") }]);
  assert.deepEqual(pieces.get(0), [{ start: 4, end: 10, ids: ["a"] }], "the space inside the passage is part of it");
  assert.deepEqual(pieces.get(1), [{ start: 0, end: 4, ids: ["a", "b"] }, { start: 4, end: 10, ids: ["b"] }]);
  assert.equal(coverPieces(index, segs, []).size, 0);
});
