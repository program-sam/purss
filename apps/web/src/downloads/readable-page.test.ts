import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { cleanArticleHtml, decodePage, readablePage } from "./readable-page.ts";

const parser = new DOMParser() as unknown as globalThis.DOMParser;
const URL_ = "https://pub.example/2026/story.html";

test("cleaning keeps text and structure, and drops anything that could run, embed or style", () => {
  const html = cleanArticleHtml([
    `<p onclick="steal()" style="color:red" class="x">Hello <b>there</b> <a href="javascript:alert(1)">bad</a> <a href="/about" onmouseover="x()">about</a></p>`,
    `<script>alert(1)</script><style>p{}</style><iframe src="https://evil.example"></iframe><form><input value="x"></form>`,
    `<svg><a href="https://evil.example">svg</a></svg><img src="http://pub.example/a.png"><img src="pic.jpg" alt="A pic" onerror="x()">`,
    `<custom-el><span>kept text</span></custom-el><a href="mailto:ed@pub.example">mail</a><a href="data:text/html,x">data</a>`,
  ].join(""), URL_, parser);
  assert.doesNotMatch(html, /script|style=|onclick|onmouseover|onerror|iframe|<form|<input|<svg|javascript:|data:|class=|custom-el|evil/);
  assert.match(html, /<p>Hello <b>there<\/b> <a>bad<\/a> <a href="https:\/\/pub\.example\/about">about<\/a><\/p>/, "links are absolute against the page, never this app");
  assert.match(html, /<img[^>]* src="https:\/\/pub\.example\/2026\/pic\.jpg"/);
  assert.match(html, /<img[^>]* alt="A pic"/);
  assert.doesNotMatch(html, /http:\/\/pub\.example\/a\.png/, "pictures only over https");
  assert.match(html, /<span>kept text<\/span>/);
  assert.match(html, /href="mailto:ed@pub\.example"/);
});

test("a page's article is found and cleaned; a page without one says so", async () => {
  const para = (i: number) => `<p>Paragraph ${i} of the story: the tide comes in over the flats twice a day, and the channels fill first while walkers keep to the posts.</p>`;
  const page = `<!doctype html><html><head><title>The flats</title><script>track()</script></head><body><nav><a href="/">Home</a></nav>
    <article><h1>The flats</h1>${Array.from({ length: 8 }, (_, i) => para(i + 1)).join("")}<p><a href="/next">Next</a></p></article><footer>© Pub</footer></body></html>`;
  const out = await readablePage(page, URL_, parser);
  assert.ok(out.ok);
  assert.match(out.html, /Paragraph 8 of the story/);
  assert.doesNotMatch(out.html, /track\(\)|<script/);
  assert.match(out.html, /href="https:\/\/pub\.example\/next"/);
  const empty = await readablePage("<html><body><div id=app></div><script>render()</script></body></html>", URL_, parser);
  assert.deepEqual(empty, { ok: false, message: "No readable article was found on the publisher's page. It may need JavaScript or a login." });
});

test("a page is read in the character set it declares, UTF-8 otherwise", () => {
  const latin1 = new Uint8Array([...new TextEncoder().encode('<meta charset="iso-8859-1"><p>caf'), 0xe9, ...new TextEncoder().encode("</p>")]);
  assert.match(decodePage(latin1), /café/);
  assert.match(decodePage(new TextEncoder().encode("<p>café</p>")), /café/);
  assert.match(decodePage(new TextEncoder().encode('<meta charset="no-such-set"><p>café</p>')), /café/);
});

test("no link or picture points at this app: relative ones resolve against the page, ones naming the app are dropped", async () => {
  const g = globalThis as { location?: { origin: string } };
  g.location = { origin: "https://localhost" };
  try {
    const html = cleanArticleHtml(`<p><a href="https://localhost/w/edit">edit</a> <img src="https://localhost/pic.png"> <a href="/wiki/Mud">mud</a></p>`, URL_, parser);
    assert.doesNotMatch(html, /localhost/);
    assert.match(html, /href="https:\/\/pub\.example\/wiki\/Mud"/);
    const para = `<p>${"The tide comes in twice a day over the flats and the channels fill first. ".repeat(6)}<a href="/w/index.php?action=edit">edit</a></p>`;
    const out = await readablePage(`<html><body><article><h1>Flats</h1>${para.repeat(4)}</article></body></html>`, URL_, parser);
    assert.ok(out.ok);
    assert.match(out.html, /href="https:\/\/pub\.example\/w\/index\.php\?action=edit"/);
    assert.doesNotMatch(out.html, /localhost/);
  } finally { delete g.location; }
});
