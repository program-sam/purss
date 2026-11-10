import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { manifestIcons, ogImage, pageIcons, resolveSourceIcon } from "./icons.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeResponse } from "./testing.ts";

const png = (size: number, r = 200) => sharp({ create: { width: size, height: size, channels: 4, background: { r, g: 90, b: 30, alpha: 1 } } }).png().toBuffer();
const rss = (image: string | null, link = "https://news.example/") =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>${link}</link>${image ? `<image><url>${image}</url><title>T</title><link>${link}</link></image>` : ""}<item><title>a</title><link>${link}a</link></item></channel></rss>`;

/** A stub web: url → response. Unknown addresses answer 404. Records every request. */
function web(pages: Record<string, () => Promise<SafeFetchResult> | SafeFetchResult>) {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const page = pages[url];
    return page ? page() : fakeResponse(url, "not found", "text/html", 404);
  };
  return { fetch, requested };
}
const image = (url: string, size: number) => async () => fakeResponse(url, await png(size), "image/png");
const html = (url: string, body: string, status = 200) => () => fakeResponse(url, `<!doctype html><html><head>${body}</head><body><p>x</p></body></html>`, "text/html", status);

test("a podcast uses its feed artwork and never asks its hosting platform for an icon", async () => {
  const w = web({
    "https://host.fm/show.rss": () => fakeResponse("https://host.fm/show.rss", rss("https://cdn.host.fm/art.png", "https://host.fm/shows/show"), "application/rss+xml"),
    "https://cdn.host.fm/art.png": image("https://cdn.host.fm/art.png", 1400),
  });
  const r = await resolveSourceIcon({ kind: "podcast", feedUrl: "https://host.fm/show.rss", siteUrl: "https://host.fm/shows/show" }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.equal(r.icon.from, "https://cdn.host.fm/art.png");
  assert.equal(r.icon.width, 128);

  const noArt = web({ "https://host.fm/show.rss": () => fakeResponse("https://host.fm/show.rss", rss(null, "https://host.fm/shows/show"), "application/rss+xml") });
  const r2 = await resolveSourceIcon({ kind: "podcast", feedUrl: "https://host.fm/show.rss", siteUrl: "https://host.fm/shows/show" }, { fetch: noArt.fetch });
  assert.equal(r2.ok, false);
  assert.deepEqual(noArt.requested, ["https://host.fm/show.rss"], "the platform's pages and favicon are not the show's");
});

test("a website's large advertised icon beats a small feed image and the favicon", async () => {
  const w = web({
    "https://news.example/feed": () => fakeResponse("https://news.example/feed", rss("https://news.example/small.png"), "application/rss+xml"),
    "https://news.example/small.png": image("https://news.example/small.png", 32),
    "https://news.example/": html("https://news.example/", '<link rel="icon" href="/fav-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png">'),
    "https://news.example/touch.png": image("https://news.example/touch.png", 180),
  });
  const r = await resolveSourceIcon({ kind: "feed", feedUrl: "https://news.example/feed", siteUrl: "https://news.example/" }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.equal(r.icon.from, "https://news.example/touch.png");
  assert.ok(!w.requested.includes("https://news.example/fav-16.png"), "the good icon came first");
  assert.ok(!w.requested.includes("https://news.example/favicon.ico"));
});

test("when nothing better exists the small icon found earlier is kept", async () => {
  const w = web({
    "https://news.example/feed": () => fakeResponse("https://news.example/feed", rss("https://news.example/small.png"), "application/rss+xml"),
    "https://news.example/small.png": image("https://news.example/small.png", 32),
  });
  const r = await resolveSourceIcon({ kind: "feed", feedUrl: "https://news.example/feed", siteUrl: "https://news.example/" }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.equal(r.icon.width, 32);
});

test("a dead site link falls back to the site's home page, then the feed host's home page", async () => {
  const w = web({
    "https://feeds.journal.example/current": html("https://feeds.journal.example/current", "", 404),
    "https://www.journal.example/": html("https://www.journal.example/", '<link rel="manifest" href="/site.webmanifest">'),
    "https://www.journal.example/site.webmanifest": () => fakeResponse("https://www.journal.example/site.webmanifest", JSON.stringify({ icons: [{ src: "/m-512.png", sizes: "512x512", purpose: "maskable" }, { src: "/m-192.png", sizes: "192x192" }] }), "application/manifest+json"),
    "https://www.journal.example/m-192.png": image("https://www.journal.example/m-192.png", 192),
  });
  const r = await resolveSourceIcon({ kind: "feed", feedUrl: "https://www.journal.example/journal.rss", siteUrl: "https://feeds.journal.example/current" }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.equal(r.icon.from, "https://www.journal.example/m-192.png");
  assert.ok(!w.requested.includes("https://www.journal.example/m-512.png"), "maskable icons are skipped");
});

test("a site that refuses the page is not asked again for its home page", async () => {
  const w = web({ "https://walled.example/journal/x": html("https://walled.example/journal/x", "", 403) });
  const r = await resolveSourceIcon({ kind: "feed", feedUrl: null, siteUrl: "https://walled.example/journal/x" }, { fetch: w.fetch });
  assert.equal(r.ok, false);
  assert.deepEqual(w.requested, ["https://walled.example/journal/x"]);
});

test("a private source fetches only its site, never a feed", async () => {
  const w = web({
    "https://private.example/": html("https://private.example/", ""),
    "https://private.example/favicon.ico": image("https://private.example/favicon.ico", 48),
  });
  const r = await resolveSourceIcon({ kind: "private", feedUrl: null, siteUrl: "https://private.example/" }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.deepEqual(w.requested, ["https://private.example/", "https://private.example/favicon.ico"]);
});

test("a YouTube channel gets its avatar from the channel page and never YouTube's own favicon", async () => {
  const channel = "https://www.youtube.com/channel/UCPfzKwIMxH2qFG894ZkBdbg";
  const w = web({
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCPfzKwIMxH2qFG894ZkBdbg": () => fakeResponse("https://www.youtube.com/feeds/videos.xml?channel_id=UCPfzKwIMxH2qFG894ZkBdbg", `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>C</title><link rel="alternate" href="${channel}"/></feed>`, "application/atom+xml"),
    [channel]: () => fakeResponse(channel, `<html><head><meta property="og:image" content="https://yt3.example/avatar=s900-c-k"></head></html>`, "text/html"),
    "https://yt3.example/avatar=s900-c-k": image("https://yt3.example/avatar=s900-c-k", 900),
  });
  const r = await resolveSourceIcon({ kind: "youtube", feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCPfzKwIMxH2qFG894ZkBdbg", siteUrl: channel }, { fetch: w.fetch });
  assert.ok(r.ok);
  assert.equal(r.icon.from, "https://yt3.example/avatar=s900-c-k");

  const consent = web({ [channel]: () => fakeResponse("https://consent.youtube.com/m?continue=x", "<html></html>", "text/html") });
  const r2 = await resolveSourceIcon({ kind: "youtube", feedUrl: null, siteUrl: channel }, { fetch: consent.fetch });
  assert.equal(r2.ok, false);
  assert.ok(!consent.requested.some((u) => u.includes("favicon")));

  const playlist = web({});
  await resolveSourceIcon({ kind: "youtube", feedUrl: null, siteUrl: "https://www.youtube.com/playlist?list=PL1" }, { fetch: playlist.fetch });
  assert.deepEqual(playlist.requested, [], "a playlist page has no channel avatar to find");
});

test("a lookup never makes more than its request budget", async () => {
  const icons = Array.from({ length: 30 }, (_, i) => `<link rel="icon" href="/i${i}.png" sizes="${64 + i}x${64 + i}">`).join("");
  const w = web({ "https://many.example/": html("https://many.example/", icons) });
  await resolveSourceIcon({ kind: "feed", feedUrl: "https://many.example/feed", siteUrl: "https://many.example/" }, { fetch: w.fetch });
  assert.ok(w.requested.length <= 14, `made ${w.requested.length} requests`);
});

test("page parsing: sizes rank icons, SVG and non-http links are ignored, <base> is honoured", () => {
  const { icons, manifest } = pageIcons(`<html><head><base href="https://cdn.example/assets/">
    <link rel="icon" type="image/svg+xml" href="logo.svg"><link rel="icon" href="javascript:alert(1)">
    <link rel="shortcut icon" href="fav.ico"><link rel="icon" sizes="192x192" href="i192.png"><link rel="apple-touch-icon" href="touch.png">
    <link rel="manifest" href="/m.json"></head><body><link rel="icon" href="late.png"></body></html>`, "https://site.example/");
  assert.deepEqual(icons.map((i) => i.url), ["https://cdn.example/assets/i192.png", "https://cdn.example/assets/touch.png", "https://cdn.example/assets/fav.ico"]);
  assert.equal(manifest, "https://cdn.example/m.json");
  assert.deepEqual(manifestIcons("not json", "https://x.example/m.json"), []);
  assert.equal(ogImage(`<meta content="https://a.example/y" property="og:image">`, "https://p.example/"), "https://a.example/y", "either attribute order");
  assert.equal(ogImage(`<meta property="og:image" content="https://a.example/x?a=1&amp;b=2">`, "https://p.example/"), "https://a.example/x?a=1&b=2");
});
