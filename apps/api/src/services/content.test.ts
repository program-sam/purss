import assert from "node:assert/strict";
import { test } from "node:test";
import { displayExcerpt, displayTitle, findDoi, sanitize, toText, unwrapCdata } from "./content.ts";

test("toText keeps words apart across block boundaries and line breaks", () => {
  assert.equal(toText("<p>doi:10.1038/x-1</p><p>Parkinson's disease</p>"), "doi:10.1038/x-1 Parkinson's disease");
  assert.equal(toText("one<br>two<br/>three"), "one two three");
  assert.equal(toText("<ul><li>a</li><li>b</li></ul><h2>c</h2>d"), "a b c d");
});

test("toText leaves inline markup joined and decodes entities", () => {
  assert.equal(toText("<p>Read <em>Nature</em>&nbsp;now &amp; <b>later</b></p>"), "Read Nature now & later");
  assert.equal(toText("<pre>x</pre><progress>y</progress>"), "x y");
});

test("displayTitle drops inline markup written into a title, and nothing else", () => {
  assert.equal(displayTitle("Why are we conscious? <i>Nature</i> investigates"), "Why are we conscious? Nature investigates");
  assert.equal(displayTitle("H<sub>2</sub>O and <span class=\"x\">CO2</span>"), "H2O and CO2");
  assert.equal(displayTitle("a < b and b > c"), "a < b and b > c");
  assert.equal(displayTitle("<script>x</script> stays as text"), "<script>x</script> stays as text");
  assert.equal(displayTitle("<i></i>"), "<i></i>");
});

test("displayExcerpt drops a journal's leading citation, glued on or not, and keeps everything else", () => {
  assert.equal(displayExcerpt("Nature, Published online: 28 October 2026; doi:10.1038/s41586-026-11181-4Dietary state can reprogram disease."), "Dietary state can reprogram disease.");
  assert.equal(displayExcerpt("Nature, Published online: 28 October 2026; doi:10.1038/s41586-026-11214-yAn experimental concept"), "An experimental concept");
  assert.equal(displayExcerpt("Nature, Published online: 04 November 2026; doi:10.1038/d41586-026-03544-8 It might seem counterproductive"), "It might seem counterproductive");
  assert.equal(displayExcerpt("Nature, Published online: 04 November 2026; doi:10.1038/d41586-026-03544-8"), "Nature, Published online: 04 November 2026; doi:10.1038/d41586-026-03544-8");
  assert.equal(displayExcerpt("A post that cites doi:10.1038/x-1 in passing."), "A post that cites doi:10.1038/x-1 in passing.");
  assert.equal(displayExcerpt(null), null);
});

test("displayExcerpt drops a publisher's leading reading time", () => {
  assert.equal(displayExcerpt("3 min read Preparations for Next Moonwalk Simulations Underway"), "Preparations for Next Moonwalk Simulations Underway");
  assert.equal(displayExcerpt("We read 3 min read stories"), "We read 3 min read stories");
  assert.equal(displayExcerpt("4 min read"), "4 min read");
});

test("deeply nested markup keeps only its text instead of stalling the server", () => {
  const started = Date.now();
  for (const deep of [`${"<div>".repeat(60_000)}kept words`, `${"<div></x>".repeat(60_000)}kept words`, `${"<li><span>".repeat(60_000)}kept words`]) {
    const html = sanitize(deep) ?? "";
    assert.doesNotMatch(html, /<div|<span|<li/);
    assert.match(html, /kept words/);
    assert.equal(toText(deep), "kept words");
  }
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("markup inside an iframe is dropped, not parsed again as a page", () => {
  assert.equal(sanitize(`<p>a</p><iframe src="https://video.example/x">${"<div>".repeat(60_000)}fallback</iframe><p>b</p>`), "<p>a</p><p>b</p>");
  assert.equal(toText("<p>a</p><iframe><b>fallback</b></iframe>"), "a");
});

test("huge flat markup beyond the work budget keeps its text, escaped, and drops scripts", () => {
  const flat = `<p>${"<b>x</b>".repeat(100_000)}</p><script>alert(1)</script><p>&lt;script&gt;alert(2)&lt;/script&gt;</p>`;
  const html = sanitize(flat) ?? "";
  assert.equal(html, `<p>${"x".repeat(100_000)}</p><p>&lt;script&gt;alert(2)&lt;/script&gt;</p>`);
  assert.equal(toText(flat), `${"x".repeat(100_000)} <script>alert(2)</script>`);
});

test("a summary wrapped in CDATA twice shows its text, not the wrapper", () => {
  // The wrapper arrives as plain text, as an escaped entity, with its closing marker missing, or around escaped markup.
  assert.equal(sanitize("<![CDATA[<p>Hallo <b>Welt</b></p>]]>"), "<p>Hallo <b>Welt</b></p>");
  assert.equal(sanitize("<![CDATA[<p>Hallo</p>"), "<p>Hallo</p>");
  assert.equal(sanitize("&lt;![CDATA[&lt;p&gt;Hallo &amp;amp; Welt&lt;/p&gt;]]&gt;"), "<p>Hallo &amp; Welt</p>");
  assert.equal(sanitize(" <![CDATA[ <p>Blomstedt <a href=\"https://ndr.example/a\">gestorben</a></p> ]]> ")?.includes("CDATA"), false);
  assert.equal(toText("<![CDATA[<p>Hallo</p><p>Welt</p>]]>"), "Hallo Welt");
  assert.equal(toText("&lt;![CDATA[&lt;p&gt;Hallo&lt;/p&gt;]]&gt;"), "Hallo");
  // Ordinary text, including text that talks about the syntax, is left alone.
  assert.equal(unwrapCdata("a]]>b and <p>x</p>"), "a]]>b and <p>x</p>");
  assert.equal(sanitize("<p>Plain</p>"), "<p>Plain</p>");
});

test("style rules that arrive as text are dropped from feed content; code samples are kept", () => {
  assert.equal(sanitize("<p>Intro</p><div>.iframe-container-carte-cgt{position: relative; padding-bottom: 56%}</div><p>Outro</p>"), "<p>Intro</p><div></div><p>Outro</p>");
  assert.equal(sanitize("<pre><code>.a { color: red }</code></pre>"), "<pre><code>.a { color: red }</code></pre>");
  assert.equal(sanitize("<p>Use .a { color: red } for red.</p>"), "<p>Use .a { color: red } for red.</p>");
});

test("a DOI loses the tracking query or anchor of the link it was found in", () => {
  assert.equal(findDoi("https://onlinelibrary.wiley.com/doi/10.1111/sed.70161?af=R"), "10.1111/sed.70161");
  assert.equal(findDoi("https://doi.org/10.1038/s41586-026-11181-4?utm_source=feed&utm_medium=rss"), "10.1038/s41586-026-11181-4");
  assert.equal(findDoi("see https://doi.org/10.1000/xyz123#section-2)."), "10.1000/xyz123");
  assert.equal(findDoi(null, "doi:10.1038/x-1."), "10.1038/x-1");
  assert.equal(findDoi("https://example.org/no-doi?af=R"), null);
});
