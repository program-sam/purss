import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPictures } from "./pictures.ts";
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

const GIF_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);

/** A WordPress gallery as a lazy-loading plugin leaves it: a placeholder in src, the address in data-src and data-srcset, a noscript fallback, a link to the full file. */
const GALLERY = (n: number, host = "") => `<div id="gallery-1" class="gallery galleryid-1 gallery-columns-3">${Array.from({ length: n }, (_, i) =>
  `<dl class="gallery-item"><dt class="gallery-icon landscape"><a href="${host}/uploads/Still0${i + 1}.png" title="Alpha"><img data-lazyloaded="1" src="${GIF_PLACEHOLDER}" width="300" height="225" data-src="${host}/uploads/Still0${i + 1}-300x225.png" class="attachment-medium" alt="" data-srcset="${host}/uploads/Still0${i + 1}-300x225.png 300w, ${host}/uploads/Still0${i + 1}.png 640w" data-sizes="(max-width: 300px) 100vw, 300px"><noscript><img width="300" height="225" src="${host}/uploads/Still0${i + 1}-300x225.png" alt="" srcset="${host}/uploads/Still0${i + 1}-300x225.png 300w"></noscript></a></dt><dd class="wp-caption-text gallery-caption">Alpha model ${i + 1}</dd></dl>`).join("")}<br style="clear: both"></div>`;

test("a gallery whose pictures load with a script keeps its pictures and captions in the readable copy, and the picture job still fetches only what the address rules allow", async () => {
  const server = await startServer((req, res) => {
    if (req.url?.startsWith("/uploads/")) return send(res, 200, "image/png", PNG_BYTES);
    send(res, 200, "text/html; charset=utf-8", ARTICLE(`<h4>Pictures</h4><p><strong>Alpha Model</strong></p>${GALLERY(3)}<p>${PARA.repeat(2)}</p>
      <img src="${GIF_PLACEHOLDER}" data-src="http://169.254.169.254/latest/meta-data/x.png" alt="Elsewhere">`));
  });
  try {
    const r = await captureReadableWith(`${server.url}/posts/slave-zero`, { fetch: { testAllowAddress: allowLoopback } });
    assert.ok(r.ok, JSON.stringify(r));
    for (const n of [1, 2, 3]) {
      assert.match(r.html, new RegExp(`<img src="${server.url.replace(/\./g, "\\.")}/uploads/Still0${n}\\.png"`), `gallery picture ${n} is kept, as the full-size file its thumbnail links to`);
      assert.match(r.text, new RegExp(`Alpha model ${n}`), "its caption is kept");
    }
    assert.doesNotMatch(r.html, /data:image|data-src|noscript|-300x225/, "no placeholder, lazy attribute or thumbnail is left");
    const pictures = [...r.html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(pictures.includes("http://169.254.169.254/latest/meta-data/x.png"), "a lazy address is promoted as it is; refusing private addresses is the fetcher's job");
    // What the picture job does with them: the gallery is fetched, the private address is refused before any request.
    const got = await fetchPictures(pictures, { maxBytes: 100_000, fetch: { testAllowAddress: (ip) => allowLoopback(ip) } });
    assert.deepEqual(got.map((p) => p.url).sort(), pictures.filter((u) => u.startsWith(server.url) && u.includes("/uploads/")).sort());
    assert.ok(server.requests.every((q) => !q.url?.includes("meta-data")));
  } finally {
    await server.close();
  }
});
