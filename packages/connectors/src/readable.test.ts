import assert from "node:assert/strict";
import { test } from "node:test";
import { captureReadable, captureReadableWith } from "./readable.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

const PARA = "The committee spent the autumn reviewing how small gardens cope with heavy rain, and found that mulch, soil structure and patience matter more than any gadget. ";
const ARTICLE = (extra = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Why mulch matters | Garden Notes</title>
<meta property="og:title" content="Why mulch matters">
<script>window.track = function(){ document.cookie = 'x' }</script><style>body{display:none}</style></head>
<body onload="steal()">
<header><nav><a href="/">Home</a><a href="/about">About</a><a href="/subscribe">Subscribe</a></nav></header>
<main><article><h1>Why mulch matters</h1><p class="byline">By Maya Lindqvist</p>
<p>${PARA.repeat(3)}</p>
<p>${PARA.repeat(2)} <a href="/related/compost" onclick="evil()">Related reading</a> and <a href="javascript:alert(1)">bad link</a>.</p>
<figure><img src="/img/mulch.jpg" alt="Mulch" onerror="evil()"><figcaption>Fresh mulch</figcaption></figure>
<p>${PARA.repeat(3)}</p><iframe src="https://evil.example/frame"></iframe>
<script>document.write('<img src=x onerror=alert(1)>')</script>
${extra}
</article></main>
<aside class="sidebar"><h3>Popular</h3><ul><li><a href="/x1">One</a></li><li><a href="/x2">Two</a></li></ul></aside>
<footer>© Garden Notes. All rights reserved. <a href="/privacy">Privacy</a></footer></body></html>`;

test("extracts the article, drops chrome, sanitises, and reports sizes and the final URL", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/start") return send(res, 302, "text/plain", "", { location: "/posts/mulch" });
    send(res, 200, "text/html; charset=utf-8", ARTICLE());
  });
  try {
    const r = await captureReadableWith(`${server.url}/start`, { fetch: { testAllowAddress: allowLoopback } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.finalUrl, `${server.url}/posts/mulch`);
    assert.match(r.title ?? "", /Why mulch matters/);
    assert.match(r.text, /small gardens cope with heavy rain/);
    assert.doesNotMatch(r.text, /Subscribe|Popular|All rights reserved/);
    assert.ok(r.text.includes("\n\n"), "paragraph breaks are kept in text");
    assert.doesNotMatch(r.html, /<script|onclick|onerror|onload|javascript:|<iframe|<style|steal|document\.write/i);
    assert.match(r.html, new RegExp(`<a href="${server.url.replace(/\./g, "\\.")}/related/compost"[^>]*rel="noopener noreferrer nofollow"`));
    assert.match(r.html, new RegExp(`<img src="${server.url.replace(/\./g, "\\.")}/img/mulch\\.jpg"`));
    assert.equal(r.bytes, Buffer.byteLength(r.html) + Buffer.byteLength(r.text));
    assert.ok(r.bytes > 500 && r.bytes < 50_000);
  } finally {
    await server.close();
  }
});

test("the production entry point has the documented signature and refuses private addresses", async () => {
  const server = await startServer((_req, res) => send(res, 200, "text/html", ARTICLE()));
  try {
    const r = await captureReadable(`${server.url}/a`);
    assert.ok(!r.ok);
    assert.equal(r.reason, "blocked");
    assert.match(r.message, /private|internal/i);
    const aborted = await captureReadable("https://example.com/", { signal: AbortSignal.abort() });
    assert.ok(!aborted.ok);
    assert.equal(aborted.reason, "aborted");
    assert.equal(server.requests.length, 0, "nothing was requested from the private address");
  } finally {
    await server.close();
  }
});

test("failures come back as reasons with plain messages", async () => {
  const server = await startServer((req, res) => {
    switch (req.url) {
      case "/missing":
        return send(res, 404, "text/html", "<h1>gone</h1>");
      case "/pdf":
        return send(res, 200, "application/pdf", Buffer.from("%PDF-1.7\n\u0000\u0000binary"));
      case "/feed":
        return send(res, 200, "application/rss+xml", "<?xml version='1.0'?><rss><channel><title>t</title></channel></rss>");
      case "/thin":
        return send(res, 200, "text/html", "<html><body><p>Too little here.</p></body></html>");
      case "/spa":
        return send(res, 200, "text/html", `<html><body><div id="root"></div><script>${"x".repeat(5000)}</script></body></html>`);
      case "/huge":
        return send(res, 200, "text/html", `<html><body>${"<p>filler text for a very big page</p>".repeat(120_000)}</body></html>`);
      case "/deep":
        return send(res, 200, "text/html", `<html><body>${"<div>".repeat(50_000)}deep</body></html>`);
      case "/hang":
        return;
    }
    send(res, 500, "text/plain", "oops");
  });
  const get = (path: string, extra: { signal?: AbortSignal } = {}) => captureReadableWith(`${server.url}${path}`, { signal: extra.signal, fetch: { testAllowAddress: allowLoopback, timeoutMs: 1500, phaseTimeoutsMs: { firstByteMs: 300 } } });
  try {
    for (const [path, reason] of [["/missing", "unreachable"], ["/pdf", "unsupported"], ["/feed", "unsupported"], ["/thin", "noarticle"], ["/spa", "noarticle"], ["/huge", "toolarge"], ["/deep", "invalid"], ["/hang", "timeout"], ["/err", "unreachable"]] as const) {
      const started = Date.now();
      const r = await get(path);
      assert.ok(!r.ok, path);
      assert.equal(r.reason, reason, `${path}: ${JSON.stringify(r)}`);
      assert.ok(r.message.length > 15, path);
      assert.ok(Date.now() - started < 5000, `${path} took ${Date.now() - started}ms`);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const aborted = await get("/hang", { signal: controller.signal });
    assert.ok(!aborted.ok);
    assert.equal(aborted.reason, "aborted");
  } finally {
    await server.close();
  }
});

test("a page built from hostile markup yields only inert text", async () => {
  const evil = `<p>${PARA.repeat(6)}</p><svg onload="alert(1)"><script>alert(2)</script></svg><form action="https://evil.example"><input name="pw"></form><object data="x.swf"></object><p style="position:fixed;top:0">${PARA.repeat(2)}</p>`;
  const server = await startServer((_req, res) => send(res, 200, "text/html", `<html><body><article><h1>Hostile</h1>${evil}</article></body></html>`));
  try {
    const r = await captureReadableWith(`${server.url}/`, { fetch: { testAllowAddress: allowLoopback } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.doesNotMatch(r.html, /<svg|<script|<form|<input|<object|style=|onload|alert/i);
  } finally {
    await server.close();
  }
});
