import test from "node:test";
import assert from "node:assert/strict";
import { linkFromShare } from "./link.ts";

test("the link in what was shared, with a title from the subject or the words around it", () => {
  assert.deepEqual(linkFromShare({ title: "", texts: ["https://tidal.example/notes/flats"] }), { url: "https://tidal.example/notes/flats", title: "" });
  assert.deepEqual(linkFromShare({ title: "Tidal flats", texts: ["https://tidal.example/a?b=1#c"] }), { url: "https://tidal.example/a?b=1#c", title: "Tidal flats" });
  assert.deepEqual(linkFromShare({ title: "", texts: ["Read this: https://tidal.example/a."] }), { url: "https://tidal.example/a", title: "Read this:" });
  assert.deepEqual(linkFromShare({ title: "", texts: ["Wiki (https://en.example.org/wiki/Tide_(disambiguation))"] }), { url: "https://en.example.org/wiki/Tide_(disambiguation)", title: "Wiki (" });
  assert.deepEqual(linkFromShare({ title: "", texts: ["(see https://tidal.example/a)"] })?.url, "https://tidal.example/a");
  assert.deepEqual(linkFromShare({ title: "", texts: ["no link here", "then http://plain.example/x"] })?.url, "http://plain.example/x", "the first text with a link");
  assert.equal(linkFromShare({ title: "A note", texts: ["just words"] }), null);
  assert.equal(linkFromShare({ title: "", texts: [] }), null);
  assert.equal(linkFromShare({ title: "", texts: ["javascript:alert(1)", "ftp://x.example"] }), null, "only web addresses");
});
