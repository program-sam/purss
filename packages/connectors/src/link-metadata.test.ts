import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLinkMetadata, isBotWall, parsePageMetadata } from "./link-metadata.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

test("Open Graph tags give the title, site name and picture; the <title> is the fallback", () => {
  const html = `<html><head><title>Plain title | Site</title>
    <meta property="og:title" content="The Real Title &amp; more"><meta property="og:site_name" content="Example Times">
    <meta property="og:image" content="/img/cover.jpg"><meta name="author" content="Jane Writer"></head><body><h1>x</h1></body></html>`;
  assert.deepEqual(parsePageMetadata(html, "https://example.org/a/b"), {
    title: "The Real Title & more", siteName: "Example Times", author: "Jane Writer", imageUrl: "https://example.org/img/cover.jpg", oembedUrl: null,
  });
  const bare = parsePageMetadata(`<html><head><title>Only a title</title></head></html>`, "https://example.org/");
  assert.equal(bare.title, "Only a title");
  assert.equal(bare.imageUrl, null);
  // A profile address is not an author's name, and a javascript: image is not a picture.
  const odd = parsePageMetadata(`<head><meta property="article:author" content="https://facebook.com/jane"><meta property="og:image" content="javascript:alert(1)"></head>`, "https://example.org/");
  assert.equal(odd.author, null);
  assert.equal(odd.imageUrl, null);
});

test("a page's metadata is read through safeFetch, with oEmbed as the fallback", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/og") return send(res, 200, "text/html", `<html><head><meta property="og:title" content="OG Title"><meta property="og:image" content="${server.origin}/c.png"><meta property="og:site_name" content="Site"></head><body></body></html>`);
    if (req.url === "/oembed-only") return send(res, 200, "text/html", `<html><head><link rel="alternate" type="application/json+oembed" href="/oembed.json"></head><body></body></html>`);
    if (req.url === "/oembed.json") return send(res, 200, "application/json", JSON.stringify({ title: "From oEmbed", author_name: "Someone", provider_name: "Provider", thumbnail_url: "https://cdn.example/t.jpg" }));
    if (req.url === "/nothing") return send(res, 200, "text/html", `<html><body>just text</body></html>`);
    if (req.url === "/file.pdf") return send(res, 200, "application/pdf", "%PDF-1.7\n\u0000\u0000\u0000");
    send(res, 404, "text/plain", "no");
  });
  const o = { testAllowAddress: allowLoopback };
  try {
    assert.deepEqual(await fetchLinkMetadata(`${server.url}/og`, o), { kind: "link", title: "OG Title", siteName: "Site", author: null, imageUrl: `${server.origin}/c.png` });
    assert.deepEqual(await fetchLinkMetadata(`${server.url}/oembed-only`, o), { kind: "link", title: "From oEmbed", siteName: "Provider", author: "Someone", imageUrl: "https://cdn.example/t.jpg" });
    assert.equal(await fetchLinkMetadata(`${server.url}/nothing`, o), null);
    assert.equal(await fetchLinkMetadata(`${server.url}/file.pdf`, o), null);
    assert.equal(await fetchLinkMetadata(`${server.url}/missing`, o), null);
    // Without the in-process allowance the private address is refused, as for every other fetch.
    assert.equal(await fetchLinkMetadata(`${server.url}/og`), null);
  } finally {
    await server.close();
  }
});

test("a YouTube video link asks YouTube's oEmbed for title, channel and thumbnail", async () => {
  const seen: string[] = [];
  const body = JSON.stringify({ title: "A Video", author_name: "A Channel", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
  const fetch = async (url: string) => {
    seen.push(url);
    return { ok: true as const, response: { url, requestedUrl: url, redirects: [], status: 200, headers: {}, mediaType: "application/json", contentType: "application/json", body: Buffer.from(body), bytes: body.length, truncated: false, remoteAddress: null, fetchedAt: "" } };
  };
  const m = await fetchLinkMetadata("https://youtu.be/dQw4w9WgXcQ?si=x", { fetch });
  assert.deepEqual(m, { kind: "video", title: "A Video", siteName: "YouTube", author: "A Channel", imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
  assert.deepEqual(seen, [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}`]);
  assert.equal(await fetchLinkMetadata("https://www.youtube.com/@channel", { fetch }), null, "a channel page is not a video");
});

test("a bot-protection page's title is not taken as the link's title", () => {
  for (const t of ["Radware Page", "Just a moment...", "Attention Required! | Cloudflare", "Access denied", "Checking your browser before accessing"]) assert.equal(isBotWall(t), true, t);
  for (const t of ["Apprenticeships | National Trust", "Accessibility", "Forbidden Planet opens new store", null]) assert.equal(isBotWall(t), false, String(t));
});
