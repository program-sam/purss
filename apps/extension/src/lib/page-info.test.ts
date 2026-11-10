import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { collectPageInfo } from "./page-info.ts";

const doc = (head: string, body = "") => parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document;

test("feeds advertised with rel=alternate, resolved, de-duplicated, in page order", () => {
  const d = doc(`
    <link rel="alternate" type="application/rss+xml" title="  Quiet   Harbour " href="/feed/">
    <link rel="alternate" type="application/atom+xml; charset=utf-8" title="Comments" href="https://quiet.example/comments/feed.atom">
    <link rel="ALTERNATE home" type="Application/Feed+JSON" href="feed.json">
    <link rel="alternate" type="application/rss+xml" href="/feed/">
    <link rel="alternate" type="text/html" hreflang="de" href="/de/">
    <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed">
    <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
    <link rel="alternate" type="application/rss+xml" href="ftp://quiet.example/feed">
    <link rel="alternate" type="application/rss+xml">`);
  assert.deepEqual(collectPageInfo(d, "https://quiet.example/2026/11/post?utm=x#top"), {
    feeds: [
      { url: "https://quiet.example/feed/", title: "Quiet Harbour" },
      { url: "https://quiet.example/comments/feed.atom", title: "Comments" },
      { url: "https://quiet.example/2026/11/feed.json", title: null },
    ],
    youtube: null,
  });
});

test("a <base href> changes how relative feed links resolve; at most eight are kept", () => {
  const many = Array.from({ length: 12 }, (_, i) => `<link rel="alternate" type="application/rss+xml" href="f${i}.xml">`).join("");
  const info = collectPageInfo(doc(`<base href="https://cdn.example/site/">${many}`), "https://quiet.example/a/b");
  assert.equal(info.feeds.length, 8);
  assert.equal(info.feeds[0]!.url, "https://cdn.example/site/f0.xml");
});

test("a page without feeds offers none", () => {
  assert.deepEqual(collectPageInfo(doc("<title>x</title>"), "https://plain.example/"), { feeds: [], youtube: null });
  assert.deepEqual(collectPageInfo(doc(""), "not a url"), { feeds: [], youtube: null });
});

test("YouTube: channel pages from the address, ignoring a head that may describe the previous page", () => {
  const stale = `<link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCstalestalestalestale1"><meta property="og:title" content="Tide Tables">`;
  assert.deepEqual(collectPageInfo(doc(stale), "https://www.youtube.com/@tidetables/videos"), { feeds: [], youtube: { url: "https://www.youtube.com/@tidetables", name: "Tide Tables", exact: true } });
  assert.equal(collectPageInfo(doc(""), "https://m.youtube.com/channel/UCabcdefghijklmnopqrstuv").youtube?.url, "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
  assert.equal(collectPageInfo(doc(""), "https://youtube.com/c/SomeName").youtube?.url, "https://www.youtube.com/c/SomeName");
  assert.equal(collectPageInfo(doc(""), "https://www.youtube.com/feed/subscriptions").youtube, null, "not a channel or a video");
});

test("YouTube: a video names its channel only when the microdata is about this video", () => {
  const micro = (id: string) => `<span itemprop="author" itemscope><link itemprop="url" href="http://www.youtube.com/@tidetables"><link itemprop="name" content="Tide Tables"></span><meta itemprop="identifier" content="${id}">`;
  assert.deepEqual(collectPageInfo(doc("", micro("abcDEF12345")), "https://www.youtube.com/watch?v=abcDEF12345&t=30").youtube,
    { url: "https://www.youtube.com/@tidetables", name: "Tide Tables", exact: true });
  assert.deepEqual(collectPageInfo(doc("", micro("someOtherVid")), "https://www.youtube.com/watch?v=abcDEF12345").youtube,
    { url: "https://www.youtube.com/watch?v=abcDEF12345", name: null, exact: false }, "stale microdata: hand over the video itself");
  assert.equal(collectPageInfo(doc(""), "https://www.youtube.com/shorts/abcDEF12345").youtube?.url, "https://www.youtube.com/watch?v=abcDEF12345");
  const foreign = `<span itemprop="author"><link itemprop="url" href="https://evil.example/@x"></span><meta itemprop="identifier" content="abcDEF12345">`;
  assert.equal(collectPageInfo(doc("", foreign), "https://www.youtube.com/watch?v=abcDEF12345").youtube?.exact, false, "only a YouTube channel address");
});
