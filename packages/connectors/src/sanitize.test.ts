import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeArticleHtml } from "./sanitize.ts";
import { parseHtmlTree } from "./text.ts";
import type { XNode } from "./text.ts";

const BASE = "https://news.example/story/1";

const ALLOWED_TAGS = new Set(["a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul"]);
const ALLOWED_ATTRS = new Set(["href", "title", "rel", "src", "alt", "width", "height", "colspan", "rowspan", "datetime", "cite", "start"]);

function clean(html: string): string {
  const r = sanitizeArticleHtml(html, BASE);
  assert.ok(r.ok, JSON.stringify(r));
  return r.html;
}

/** Structural audit: whatever the input, the output tree contains only allowlisted elements and attributes. */
function audit(html: string): void {
  const root = parseHtmlTree(html);
  const stack: XNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "tag") {
      assert.ok(ALLOWED_TAGS.has((node.name ?? "").toLowerCase()), `unexpected element <${node.name}> in: ${html}`);
      for (const [k, v] of Object.entries(node.attribs ?? {})) {
        assert.ok(ALLOWED_ATTRS.has(k.toLowerCase()), `unexpected attribute ${k} in: ${html}`);
        if (k === "href" || k === "src" || k === "cite") assert.match(v, /^(?:https?:|mailto:)/i, `unsafe url ${v}`);
      }
    }
    assert.ok(node.type !== "script" && node.type !== "style", "no script or style nodes");
    for (const c of node.children ?? []) stack.push(c);
  }
}

const ATTACKS: string[] = [
  `<script>alert(1)</script><p>after</p>`,
  `<SCRIPT SRC=//evil.example/x.js></SCRIPT>`,
  `<img src=x onerror=alert(1)>`,
  `<img/src/onerror=alert(1)>`,
  `<IMG SRC="jav&#x09;ascript:alert(1)">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href=" javascript:alert(1)">x</a>`,
  `<a href="&#106;avascript:alert(1)">x</a>`,
  `<a href="java\tscript:alert(1)">x</a>`,
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`,
  `<iframe src="https://evil.example"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<object data="x.swf"></object><embed src="x.swf">`,
  `<svg onload=alert(1)><script>alert(2)</script><a xlink:href="javascript:alert(3)"><text>x</text></a></svg>`,
  `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `<form action="javascript:alert(1)"><input name=a value=b><button>go</button></form>`,
  `<style>@import url(javascript:alert(1)); body{display:none}</style><p>x</p>`,
  `<div style="background:url(javascript:alert(1));position:fixed">x</div>`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<base href="javascript:alert(1)//"><a href="x">x</a>`,
  `<link rel="stylesheet" href="https://evil.example/x.css">`,
  `<body onload=alert(1)><p>x</p></body>`,
  `<details open ontoggle=alert(1)>x</details>`,
  `<video src=x onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `<scr<script>ipt>alert(1)</scr</script>ipt>`,
  `<a href="https://ok.example" onclick="alert(1)" onmouseover="alert(2)" style="x:y" target="_blank" data-x="1">ok</a>`,
  `<img src="https://ok.example/a.png" srcset="javascript:alert(1) 1x" onerror="alert(1)" loading="lazy" style="x:y">`,
  `<div id="x" class="y" contenteditable onfocus=alert(1) tabindex=0>x</div>`,
  `<!--[if gte IE 4]><script>alert(1)</script><![endif]--><p>c</p>`,
  `<![CDATA[<script>alert(1)</script>]]>`,
  `<p>text<template><script>alert(1)</script></template></p>`,
  `<a href="//evil.example/path">protocol relative</a>`,
  `<img src="//evil.example/p.png">`,
  `<button onclick=alert(1)>b</button><select><option onclick=alert(1)>o</option></select><textarea><script>alert(1)</script></textarea>`,
  `<table><tr><td onclick=alert(1) background="javascript:alert(1)">x</td></tr></table>`,
  `<p>\u0000<scr\u0000ipt>alert(1)</scr\u0000ipt></p>`,
  `<isindex action="javascript:alert(1)" type=image src=1>`,
  `<a href="mailto:a@b.c?subject=x">mail</a><a href="tel:+123">tel</a><a href="ftp://x.example/f">ftp</a><a href="file:///etc/passwd">file</a>`,
];

test("hostile HTML never survives as anything outside the allowlist", () => {
  for (const attack of ATTACKS) {
    const out = clean(attack);
    audit(out);
    assert.doesNotMatch(out, /javascript:|vbscript:|data:|onerror|onload|onclick|ontoggle|onfocus|onmouseover|<script|<iframe|<object|<embed|<svg|<math|<style|<form|<input|<button|<meta|<base|<link|style=|srcset|ftp:|file:|tel:/i, `${attack} => ${out}`);
  }
});

test("ordinary article markup is kept, links are made absolute and get safe rel values", () => {
  const out = clean(`<div><h2>Title</h2><p>Hello <strong>bold</strong> <em>em</em> <a href="/next?page=2" title="Next">next</a> and <a href="https://other.example/x" target="_blank">other</a>.</p><figure><img src="/img/a.jpg" alt="An image" width="640" height="480"><figcaption>Cap</figcaption></figure><ul><li>one</li><li>two</li></ul><blockquote>quote</blockquote><pre><code>let x = 1 &lt; 2;</code></pre><table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table></div>`);
  audit(out);
  assert.match(out, /<a href="https:\/\/news\.example\/next\?page=2" title="Next" rel="noopener noreferrer nofollow">next<\/a>/);
  assert.match(out, /<a href="https:\/\/other\.example\/x" rel="noopener noreferrer nofollow">other<\/a>/);
  assert.match(out, /<img src="https:\/\/news\.example\/img\/a\.jpg" alt="An image" width="640" height="480"/);
  assert.match(out, /<figcaption>Cap<\/figcaption>/);
  assert.match(out, /<th colspan="2">h<\/th>/);
  assert.match(out, /let x = 1 &lt; 2;/);
  assert.doesNotMatch(out, /target=/);
});

test("images without a usable source and empty anchors are dropped", () => {
  const out = clean(`<p>x</p><img src="javascript:alert(1)" alt="a"><img alt="none"><a href="javascript:alert(1)"></a><a href="ok"></a>`);
  assert.doesNotMatch(out, /<img|<a /);
});

test("pathologically nested or oversized input is refused instead of stalling", () => {
  const started = Date.now();
  const deep = sanitizeArticleHtml(`${"<div>".repeat(100_000)}x`, BASE);
  assert.ok(!deep.ok);
  assert.equal(deep.reason, "toocomplex");
  const big = sanitizeArticleHtml("a".repeat(5 * 1024 * 1024), BASE);
  assert.ok(!big.ok);
  assert.equal(big.reason, "toolarge");
  assert.ok(Date.now() - started < 3000);
});
