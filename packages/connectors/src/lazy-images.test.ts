import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { bestFromSrcset, promoteLazyImages } from "./lazy-images.ts";

const PAGE = "https://blog.example/2026/10/slave-zero/";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function run(html: string): { document: Document; count: number; srcs: (string | null)[]; body: string } {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const count = promoteLazyImages(document as unknown as Document, PAGE);
  return { document: document as unknown as Document, count, srcs: [...document.querySelectorAll("img")].map((i) => i.getAttribute("src")), body: document.body.innerHTML };
}

test("a placeholder src gets the image's real address: data-src first, then the best srcset candidate, then the noscript fallback", () => {
  const a = run(`<img src="${GIF}" data-src="/a/one.jpg">`);
  assert.deepEqual(a.srcs, ["https://blog.example/a/one.jpg"]);
  const b = run(`<img src="${GIF}" data-srcset="https://cdn.example/s-300.jpg 300w, https://cdn.example/s-900.jpg 900w, https://cdn.example/s-3000.jpg 3000w">`);
  assert.deepEqual(b.srcs, ["https://cdn.example/s-900.jpg"], "the widest candidate up to a sensible size, not a print original");
  const c = run(`<img src="${GIF}" class="lazy"><noscript><img src="/a/three.jpg" alt="Three"></noscript>`);
  assert.deepEqual(c.srcs, ["https://blog.example/a/three.jpg"]);
  assert.doesNotMatch(c.body, /noscript/, "the fallback is used up, so it is not put in the image's place later");
  const d = run(`<p>Before</p><noscript><img src="https://cdn.example/only.jpg" width="640" height="480"></noscript><p>After</p>`);
  assert.deepEqual(d.srcs, ["https://cdn.example/only.jpg"], "an image that exists only in a noscript is an image of the page");
  assert.equal(run(`<img src="/blank.gif" data-lazy-src="https://cdn.example/x.jpg">`).srcs[0], "https://cdn.example/x.jpg", "a placeholder file name counts as a placeholder");
});

test("a real src is never replaced, and only http(s) addresses without credentials are promoted", () => {
  assert.deepEqual(run(`<img src="/real.jpg" data-src="/other.jpg">`).srcs, ["/real.jpg"]);
  for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "file:///etc/passwd", "ftp://x.example/a.jpg", "https://user:pw@x.example/a.jpg", "https://x.example/" + "a".repeat(3000)]) {
    const r = run(`<img src="${GIF}" data-src="${bad}">`);
    assert.ok(!/^(javascript|file|ftp):|user:pw/.test(r.srcs[0] ?? "") && (r.srcs[0] ?? "").length < 2100, `not promoted: ${bad.slice(0, 40)}`);
  }
  // A private address is a perfectly good web address to promote: the picture job's fetcher is what refuses it.
  assert.deepEqual(run(`<img src="${GIF}" data-src="http://169.254.169.254/latest/meta-data/a.png">`).srcs, ["http://169.254.169.254/latest/meta-data/a.png"]);
});

test("a thumbnail that links to its picture file is replaced by the file, without the thumbnail's size; a larger picture keeps its own address", () => {
  const thumb = run(`<a href="/wp-content/uploads/2026/10/Still01.png"><img src="${GIF}" width="300" height="225" data-src="/wp-content/uploads/2026/10/Still01-300x225.png"></a>`);
  assert.deepEqual(thumb.srcs, ["https://blog.example/wp-content/uploads/2026/10/Still01.png"]);
  assert.doesNotMatch(thumb.body, /width=|height=/);
  const big = run(`<a href="/p/big.jpg"><img src="${GIF}" width="1200" height="800" data-src="/p/big-1200.jpg"></a>`);
  assert.deepEqual(big.srcs, ["https://blog.example/p/big-1200.jpg"]);
  const page = run(`<a href="/about/"><img src="${GIF}" width="150" height="150" data-src="/p/me-150x150.jpg"></a>`);
  assert.deepEqual(page.srcs, ["https://blog.example/p/me-150x150.jpg"], "a link to a page is not a picture file");
});

test("a gallery of lazy pictures is put in a figure, so that Readability keeps it with its captions", () => {
  const items = [1, 2, 3].map((n) => `<dl class="gallery-item"><dt><a href="/u/s${n}.png"><img src="${GIF}" width="300" height="225" data-src="/u/s${n}-300x225.png"></a></dt><dd>Alpha ${n}</dd></dl>`).join("");
  const r = run(`<p>Intro</p><div class="gallery">${items}</div><p>Outro</p>`);
  assert.match(r.body, /<figure><div class="gallery">/);
  assert.equal(r.document.querySelectorAll("figure img").length, 3);
  assert.equal(r.document.querySelectorAll("figure").length, 1, "one figure around the whole gallery");
  // Already inside a figure, or a single picture: nothing is wrapped.
  assert.equal(run(`<figure><div><img src="${GIF}" data-src="/a.jpg"><img src="${GIF}" data-src="/b.jpg"></div></figure>`).document.querySelectorAll("figure").length, 1);
  assert.equal(run(`<div><img src="${GIF}" data-src="/a.jpg"></div>`).document.querySelectorAll("figure").length, 0);
  // A box with paragraphs in it is the article, not a gallery.
  assert.equal(run(`<div><p>Words</p><img src="${GIF}" data-src="/a.jpg"><img src="${GIF}" data-src="/b.jpg"></div>`).document.querySelectorAll("figure").length, 0);
});

test("srcset candidates: widths and densities are ranked, commas inside addresses survive, junk gives nothing", () => {
  assert.equal(bestFromSrcset("/a-1.jpg 1x, /a-2.jpg 2x", PAGE), "https://blog.example/a-2.jpg", "2x ranks as 1600 against a 800 px column and is the widest allowed");
  assert.equal(bestFromSrcset("https://img.example/r?w=300,h=200 300w, https://img.example/r?w=600,h=400 600w", PAGE), "https://img.example/r?w=600,h=400");
  assert.equal(bestFromSrcset("javascript:alert(1) 300w", PAGE), null);
  assert.equal(bestFromSrcset("", PAGE), null);
  assert.equal(bestFromSrcset(null, PAGE), null);
  assert.equal(bestFromSrcset("https://cdn.example/only-big.jpg 4000w, https://cdn.example/bigger.jpg 5000w", PAGE), "https://cdn.example/only-big.jpg", "when all are large, the smallest");
});
