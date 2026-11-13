import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_LEVELS, checkQuery } from "./query.ts";

test("a filter's value lists hold each value once and no more than there are values", () => {
  const out = checkQuery({ any: [{ field: "capture", value: ["fulltext", "fulltext", "feed"] }, { field: "kind", value: ["video", "video"] }] });
  assert.ok(out.ok);
  assert.deepEqual(out.query, { any: [{ field: "capture", value: ["fulltext", "feed"] }, { field: "kind", value: ["video"] }] }, "repeats add nothing to what matches");
  const seven = checkQuery({ field: "kind", value: Array(7).fill("video") });
  assert.ok(seven.ok && "field" in seven.query && seven.query.field === "kind" && seven.query.value.length === 1, "a few repeats are folded into one");
  const thirty = checkQuery({ field: "capture", value: Array(30).fill("fulltext") });
  assert.ok(thirty.ok && "field" in thirty.query && thirty.query.field === "capture" && thirty.query.value.length === 1, "thirty copies of one level are one level");
  assert.equal(checkQuery({ field: "source", value: Array.from({ length: 51 }, (_, i) => `src_${String(i).padStart(26, "0")}`) }).ok, false, "more different values than allowed are refused");
  assert.equal(checkQuery({ field: "capture", value: [...CAPTURE_LEVELS] }).ok, true, "every level once is fine");
});
