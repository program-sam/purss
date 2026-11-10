import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { BROWSER_CAPTURE_MAX_CHARS } from "@purss/domain";
import { MAX_CAPTURE_CHARS, readableOf } from "./capture.ts";

const paragraph = "The estuary keeps a record of storms in thin layers of silt, one for every flood tide that reached the marsh. ";
const page = (body: string, title = "Storm layers") =>
  parseHTML(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`).document as unknown as Document;

test("the readable part of the page, without the page around it, and the page itself is left alone", () => {
  const doc = page(`<nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <article><h1>Storm layers</h1>${`<p>${paragraph.repeat(3)}</p>`.repeat(4)}<p><a href="/next">Read on</a></p></article>
    <footer>Copyright</footer>`);
  const before = doc.documentElement.outerHTML;
  const r = readableOf(doc);
  assert.ok(r.ok);
  assert.equal(r.title, "Storm layers");
  assert.match(r.html, /record of storms in thin layers/);
  assert.ok(!r.html.includes("Copyright"), "page furniture is left out");
  assert.equal(doc.documentElement.outerHTML, before, "the open page isn't changed");
});

test("nothing readable, or too much, is reported instead of sent", () => {
  assert.deepEqual(readableOf(page("")), { ok: false, reason: "empty" });
  const huge = page(`<article>${`<p>${paragraph.repeat(200)}</p>`.repeat(120)}</article>`);
  assert.deepEqual(readableOf(huge), { ok: false, reason: "too_large" });
});

test("the extension's limit is the PURSS's", () => {
  assert.equal(MAX_CAPTURE_CHARS, BROWSER_CAPTURE_MAX_CHARS);
});
