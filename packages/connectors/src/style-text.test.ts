import assert from "node:assert/strict";
import { test } from "node:test";
import { captureReadableWith } from "./readable.ts";
import { looksLikeCss, sanitizeArticleHtml } from "./sanitize.ts";
import { htmlToPlainText, htmlToText } from "./text.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

test("text taken from markup never includes the code of <style> and <script> elements", () => {
  const html = "<p>before</p><style>.iframe-container-carte-cgt{position: relative}</style><p>after</p><script>var a = 1</script>";
  assert.equal(htmlToPlainText(html), "before\n\nafter");
  assert.equal(htmlToText(html), "before after");
});

test("text that is only style rules is dropped from a captured article; code and prose are kept", () => {
  const css = ".iframe-container-carte-cgt{position: relative; padding-bottom: 56%} .iframe-container-carte-cgt iframe{position:absolute}";
  assert.ok(looksLikeCss(css));
  assert.ok(looksLikeCss("@media (max-width: 600px) { .a { display: none } }"));
  assert.ok(!looksLikeCss("Set the width {to: 5} for it"));
  assert.ok(!looksLikeCss("Plain sentence about CSS rules."));
  assert.ok(!looksLikeCss("{}"));
  const out = sanitizeArticleHtml(`<p>Intro</p><div>${css}</div><p>Outro</p><pre><code>.a { color: red }</code></pre>`, "https://x.example/");
  assert.ok(out.ok);
  assert.equal(out.html, "<p>Intro</p><p>Outro</p><pre><code>.a { color: red }</code></pre>");
});

test("a captured page with inline <style> inside its body containers has no style text in the capture", async () => {
  const para = (n: number) => `<p>${`Paragraph ${n} of the article, long enough to count as the main text of the page. `.repeat(6)}</p>`;
  const server = await startServer((_req, res) =>
    send(res, 200, "text/html", `<html><head><title>Strike day</title><style>body{margin:0}</style></head><body>
      <article class="post"><style>.iframe-container-carte-cgt{position: relative;padding-bottom:56%;height:0}</style>
        ${para(1)}<div class="embed"><style>.embed iframe{position:absolute;top:0}</style><iframe src="https://maps.example/x"></iframe></div>
        ${para(2)}<p>&lt;style&gt;.carte-cgt{position: relative}&lt;/style&gt;</p><p>.carte-cgt iframe{position:absolute;width:100%}</p>${para(3)}
      </article></body></html>`),
  );
  try {
    const r = await captureReadableWith(`${server.url}/`, { fetch: { testAllowAddress: allowLoopback } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.doesNotMatch(r.text, /position|padding-bottom|iframe\{|carte-cgt|margin:0/);
    assert.doesNotMatch(r.html, /position|padding-bottom|carte-cgt|<style/);
    assert.match(r.text, /Paragraph 1 of the article/);
    assert.match(r.text, /Paragraph 3 of the article/);
  } finally {
    await server.close();
  }
});
