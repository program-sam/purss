import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveryCandidate } from "@purss/domain";
import { cadenceText, EPISODES, POSTS } from "./cadence.ts";
import { YOUTUBE_REFUSED } from "./discover.ts";
import { discover } from "./discover.ts";
import type { DiscoveryDraft, FetchFn } from "./discover.ts";
import type { FeedItem } from "./feed.ts";
import { WHOLE_SITE_NOTE } from "./feed-choice.ts";
import { normalizeInput } from "./input.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { allowLoopback, fakeFailure, fakeResponse, send, startServer } from "./testing.ts";
import { channelIdFromHtml, classifyYoutubeUrl, YOUTUBE_SLOW } from "./youtube.ts";

const NOW = () => new Date("2026-11-03T12:00:00Z");

const LONG = "A real paragraph with plenty of words in it that goes on and on. ".repeat(40);

function rssWithDates(title: string, dates: string[], opts: { full?: boolean; link?: string } = {}): string {
  const items = dates
    .map(
      (d, i) =>
        `<item><title>${title} ${i + 1}</title><link>${opts.link ?? "https://blog.example"}/p${i + 1}</link><guid>g${i + 1}</guid><pubDate>${d}</pubDate><description>${opts.full ? `&lt;p&gt;${LONG}&lt;/p&gt;` : "Short teaser…"}</description></item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${opts.link ?? "https://blog.example"}/</link><description>x</description>${items}</channel></rss>`;
}

const WEEKLY = ["Mon, 02 Nov 2026 10:00:00 GMT", "Mon, 26 Oct 2026 10:00:00 GMT", "Mon, 19 Oct 2026 10:00:00 GMT", "Mon, 12 Oct 2026 10:00:00 GMT", "Mon, 05 Oct 2026 10:00:00 GMT"];

type Routes = Record<string, SafeFetchResult | ((url: string) => SafeFetchResult)>;

function stub(routes: Routes): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(url) : route;
  };
  return { fetch, calls };
}

function okDraft(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

test("input normalisation: bare domains, schemes, junk and unsupported strings", () => {
  const cases: [string, string, string | null][] = [
    ["example.com", "https://example.com/", "http://example.com/"],
    ["  Example.COM/Blog  ", "https://example.com/Blog", "http://example.com/Blog"],
    ["http://example.com/feed", "https://example.com/feed", "http://example.com/feed"],
    ["https://example.com/feed", "https://example.com/feed", null],
    ["http://example.com:8080/feed", "http://example.com:8080/feed", null],
    ["https://example.com/feed.", "https://example.com/feed", null],
    ["<https://example.com/a>", "https://example.com/a", null],
    ["(https://example.com/a)", "https://example.com/a", null],
    ["https://en.wikipedia.org/wiki/Feed_(web)", "https://en.wikipedia.org/wiki/Feed_(web)", null],
    ['"https://example.com/a",', "https://example.com/a", null],
    ["feed://example.com/rss", "https://example.com/rss", "http://example.com/rss"],
    ["feed:https://example.com/rss", "https://example.com/rss", null],
    ["//example.com/x", "https://example.com/x", "http://example.com/x"],
    ["example.com:8443/feed", "https://example.com:8443/feed", null],
    ["https://example.com/a#section", "https://example.com/a", null],
  ];
  for (const [input, url, fallback] of cases) {
    const n = normalizeInput(input);
    assert.ok(n.ok, input);
    assert.equal(n.url, url, input);
    assert.equal(n.httpFallback, fallback, input);
  }
  for (const input of ["", "   ", "two words", "javascript:alert(1)", "mailto:a@b.c", "ftp://example.com", "file:///etc/passwd", "@somebody", "data:text/html,x", "x".repeat(2100), "intranet"]) {
    const n = normalizeInput(input);
    assert.ok(!n.ok, input);
    assert.equal(n.reason, "invalid", input);
  }
  for (const input of ["http://user:pw@example.com/feed", "https://token@example.com/"]) {
    const n = normalizeInput(input);
    assert.ok(!n.ok);
    assert.equal(n.reason, "invalid", input);
  }
  for (const input of ["localhost", "http://127.0.0.1/", "192.168.0.1", "http://[::1]/", "x.local"]) {
    const n = normalizeInput(input);
    assert.ok(!n.ok, input);
    assert.equal(n.reason, "blocked", input);
  }
});

test("direct feed: preview with title, cadence, three samples, full content and the contract shape", async () => {
  const { fetch } = stub({
    "https://blog.example/feed.xml": fakeResponse("https://blog.example/feed.xml", rssWithDates("Weekly Blog", WEEKLY, { full: true }), "application/rss+xml"),
  });
  const d = okDraft(await discover("https://blog.example/feed.xml", { fetch, now: NOW }));
  assert.equal(d.candidates.length, 1);
  const c = d.candidates[0]!;
  const shaped: Omit<DiscoveryCandidate, "token"> = c; // compile-time contract check
  assert.equal(shaped.title, "Weekly Blog");
  assert.equal(c.kind, "feed");
  assert.equal(c.origin, "RSS feed");
  assert.equal(c.via, "Posts feed");
  assert.equal(c.feedUrl, "https://blog.example/feed.xml");
  assert.equal(c.siteUrl, "https://blog.example/");
  assert.equal(c.cadence, "about 1 post a week");
  assert.equal(c.samples.length, 3);
  assert.deepEqual(c.samples[0], { title: "Weekly Blog 1", publishedAt: "2026-11-02T10:00:00.000Z" });
  assert.equal(c.summariesOnly, false);
  assert.equal(c.alreadyFollowingSourceId, null);
  assert.equal(c.privateWarning, null);
  assert.ok(!("token" in c));
});

test("summaries-only feeds are flagged", async () => {
  const { fetch } = stub({ "https://blog.example/rss": fakeResponse("https://blog.example/rss", rssWithDates("Teasers", WEEKLY), "application/xml") });
  const c = okDraft(await discover("https://blog.example/rss", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.summariesOnly, true);
});

test("a feed served as text/html is still recognised by its content", async () => {
  const { fetch } = stub({ "https://blog.example/rss": fakeResponse("https://blog.example/rss", rssWithDates("Mislabelled", WEEKLY, { full: true }), "text/html; charset=utf-8") });
  const d = okDraft(await discover("blog.example/rss", { fetch, now: NOW }));
  assert.equal(d.candidates[0]!.title, "Mislabelled");
});

test("website with several alternates: labels, ordering and de-duplication of the same feed in two formats", async () => {
  const atomSame = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Site Blog</title><link href="https://site.example/"/><entry><title>Site Blog 1</title><id>g1</id><link href="https://site.example/p1"/><updated>2026-11-02T10:00:00Z</updated></entry></feed>`;
  const html = `<!doctype html><html><head><title>Site</title>
    <link rel="alternate" type="application/rss+xml" title="Site Blog &raquo; Comments Feed" href="/comments/feed/">
    <link rel="alternate" type="application/rss+xml" title="Site Blog" href="/feed/">
    <link rel="alternate" type="application/atom+xml" title="Site Blog (Atom)" href="/feed/atom/">
    <link rel="alternate" type="application/rss+xml" title="Category: Gardening" href="/category/gardening/feed/">
    <link rel="alternate" type="application/rss+xml" title="The Podcast" href="/podcast.xml">
    <link rel="stylesheet" href="/s.css"></head><body><a href="/feed/">RSS</a></body></html>`;
  const mainFeed = rssWithDates("Site Blog", WEEKLY, { full: true, link: "https://site.example" });
  const { fetch } = stub({
    "https://site.example/": fakeResponse("https://site.example/", html, "text/html"),
    "https://site.example/feed/": fakeResponse("https://site.example/feed/", mainFeed, "application/rss+xml"),
    "https://site.example/feed/atom/": fakeResponse("https://site.example/feed/atom/", mainFeed.replace(/<rss[^>]*>/, "<rss>"), "application/atom+xml"),
    "https://site.example/comments/feed/": fakeResponse("https://site.example/comments/feed/", rssWithDates("Comments on Site Blog", WEEKLY.slice(0, 3), { link: "https://site.example/c" }), "application/rss+xml"),
    "https://site.example/category/gardening/feed/": fakeResponse("https://site.example/category/gardening/feed/", rssWithDates("Site Blog: Gardening", WEEKLY, { link: "https://site.example/g" }), "application/rss+xml"),
    "https://site.example/podcast.xml": fakeResponse(
      "https://site.example/podcast.xml",
      `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>The Podcast</title><itunes:author>x</itunes:author><item><title>Ep1</title><enclosure url="https://a.example/1.mp3" type="audio/mpeg"/><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><itunes:duration>12:00</itunes:duration></item></channel></rss>`,
      "application/rss+xml",
    ),
  });
  const d = okDraft(await discover("site.example", { fetch, now: NOW }));
  assert.deepEqual(
    d.candidates.map((c) => [c.title, c.via, c.kind]),
    [
      ["Site Blog", "Posts feed", "feed"],
      ["The Podcast", "Podcast feed", "podcast"],
      ["Site Blog: Gardening", "Section feed", "feed"],
    ],
    "the comments feed is left out when posts feeds exist",
  );
  assert.equal(d.url, "https://site.example/");
  assert.equal(d.candidates[1]!.origin, "Podcast feed");
  assert.equal(d.candidates[1]!.cadence, "Latest episode 1 day ago");
});

test("an RSS link in the page body is found when the head advertises nothing", async () => {
  const html = `<html><head><title>Journal</title></head><body><nav><a href="/rss/current.xml" title="RSS">Subscribe</a><a href="/about">About</a></nav></body></html>`;
  const { fetch, calls } = stub({
    "https://journal.example/": fakeResponse("https://journal.example/", html, "text/html"),
    "https://journal.example/rss/current.xml": fakeResponse("https://journal.example/rss/current.xml", rssWithDates("Journal of Things", WEEKLY, { link: "https://journal.example" }), "application/rss+xml"),
  });
  const d = okDraft(await discover("https://journal.example/", { fetch, now: NOW }));
  assert.equal(d.candidates[0]!.title, "Journal of Things");
  assert.ok(!calls.some((u) => u.endsWith("/feed")), "no path guessing when a link was found");
});

test("common-path fallback is conservative: same site only, accepts only real feeds", async () => {
  const html = `<html><head><title>Plain</title></head><body>Hello</body></html>`;
  const { fetch, calls } = stub({
    "https://plain.example/": fakeResponse("https://plain.example/", html, "text/html"),
    "https://plain.example/feed": fakeResponse("https://plain.example/feed", "<html><body>Soft 404 page</body></html>", "text/html", 200),
    "https://plain.example/atom.xml": fakeResponse("https://plain.example/atom.xml", rssWithDates("Plain Site", WEEKLY, { link: "https://plain.example" }), "application/xml"),
  });
  const d = okDraft(await discover("plain.example", { fetch, now: NOW }));
  assert.equal(d.candidates.length, 1);
  assert.equal(d.candidates[0]!.feedUrl, "https://plain.example/atom.xml");
  assert.ok(calls.every((u) => u.startsWith("https://plain.example")), "probes stay on the site");
  assert.ok(calls.length <= 8, `at most a handful of requests, saw ${calls.length}`);
});

test("a page with no feed at all answers 'nofeed' with a next step", async () => {
  const { fetch } = stub({ "https://none.example/": fakeResponse("https://none.example/", "<html><body>Just a page</body></html>", "text/html") });
  const d = await discover("none.example", { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "nofeed");
  assert.match(d.message, /couldn't find a feed/i);
});

test("https is tried first and plain http is the fallback; a failed https attempt does not hide a working http site", async () => {
  const feed = fakeResponse("http://old.example/feed", rssWithDates("Old Site", WEEKLY, { link: "http://old.example" }), "application/rss+xml");
  const { fetch, calls } = stub({
    "https://old.example/feed": fakeFailure("unreachable", "refused"),
    "http://old.example/feed": feed,
  });
  const d = okDraft(await discover("http://old.example/feed", { fetch, now: NOW }));
  assert.deepEqual(calls, ["https://old.example/feed", "http://old.example/feed"]);
  assert.equal(d.candidates[0]!.feedUrl, "http://old.example/feed");
  const { fetch: f2, calls: c2 } = stub({
    "https://modern.example/feed": fakeResponse("https://modern.example/feed", rssWithDates("Modern", WEEKLY), "application/rss+xml"),
  });
  const d2 = okDraft(await discover("http://modern.example/feed", { fetch: f2, now: NOW }));
  assert.deepEqual(c2, ["https://modern.example/feed"]);
  assert.equal(d2.candidates[0]!.feedUrl, "https://modern.example/feed");
  // A blocked address is never retried over another scheme.
  const { fetch: f3, calls: c3 } = stub({ "https://bad.example/": fakeFailure("blocked", "no") });
  const d3 = await discover("bad.example", { fetch: f3, now: NOW });
  assert.ok(!d3.ok && d3.reason === "blocked");
  assert.deepEqual(c3, ["https://bad.example/"]);
});

test("credential-like feed URLs raise a private warning; ordinary ones do not", async () => {
  const feed = rssWithDates("Members", WEEKLY, { link: "https://members.example" });
  const secret = "https://members.example/feed?token=9f8e7d6c5b4a39281716";
  const { fetch } = stub({
    [secret]: fakeResponse(secret, feed, "application/rss+xml"),
    "https://members.example/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/feed.xml": fakeResponse("https://members.example/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/feed.xml", feed, "application/rss+xml"),
    "https://members.example/feed?page=2": fakeResponse("https://members.example/feed?page=2", feed, "application/rss+xml"),
  });
  const a = okDraft(await discover(secret, { fetch, now: NOW })).candidates[0]!;
  assert.match(a.privateWarning ?? "", /private access key/);
  const b = okDraft(await discover("https://members.example/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/feed.xml", { fetch, now: NOW })).candidates[0]!;
  assert.match(b.privateWarning ?? "", /private/);
  const c = okDraft(await discover("https://members.example/feed?page=2", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.privateWarning, null);
});

test("failure modes map to the contract reasons with plain messages", async () => {
  const cases: [string, SafeFetchResult, string][] = [
    ["blocked", fakeFailure("blocked", "That address points to a private or internal network, so it can't be followed."), "blocked"],
    ["timeout", fakeFailure("timeout"), "timeout"],
    ["toolarge", fakeFailure("toolarge"), "toolarge"],
    ["unreachable", fakeFailure("unreachable", "We couldn't find that website."), "unreachable"],
    ["invalid", fakeFailure("invalid", "That website sent a response we couldn't read."), "invalid"],
    ["aborted", fakeFailure("aborted"), "timeout"],
    ["404", fakeResponse("https://x.example/", "nope", "text/html", 404), "unreachable"],
    ["403", fakeResponse("https://x.example/", "nope", "text/html", 403), "unreachable"],
    ["401", fakeResponse("https://x.example/", "nope", "text/html", 401), "unsupported"],
    ["429", fakeResponse("https://x.example/", "nope", "text/html", 429), "unreachable"],
    ["500", fakeResponse("https://x.example/", "nope", "text/html", 503), "unreachable"],
    ["pdf", fakeResponse("https://x.example/", Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n\u0000\u0000"), "application/pdf"), "unsupported"],
    ["json", fakeResponse("https://x.example/", '{"hello":"world"}', "application/json"), "unsupported"],
    ["opml", fakeResponse("https://x.example/", '<?xml version="1.0"?><opml version="2.0"><body/></opml>', "text/x-opml"), "unsupported"],
    ["sitemap", fakeResponse("https://x.example/", '<?xml version="1.0"?><urlset xmlns="x"><url/></urlset>', "application/xml"), "unsupported"],
    ["broken feed", fakeResponse("https://x.example/", "<rss version=\"2.0\"><nochannel/></rss>", "application/rss+xml"), "invalid"],
  ];
  for (const [name, result, reason] of cases) {
    const { fetch } = stub({ "https://x.example/": result });
    const d = await discover("https://x.example/", { fetch, now: NOW });
    assert.ok(!d.ok, name);
    assert.equal(d.reason, reason, name);
    assert.ok(d.message.length > 10 && !/undefined|\[object/.test(d.message), `${name}: ${d.message}`);
  }
  const bad = await discover("javascript:alert(1)");
  assert.ok(!bad.ok && bad.reason === "invalid");
});

test("an empty feed is a preview with an honest note, not a failure", async () => {
  const { fetch } = stub({ "https://quiet.example/feed": fakeResponse("https://quiet.example/feed", '<rss version="2.0"><channel><title>Quiet</title><link>https://quiet.example</link></channel></rss>', "application/rss+xml") });
  const c = okDraft(await discover("https://quiet.example/feed", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.samples.length, 0);
  assert.equal(c.cadence, "No posts yet");
});

test("cadence wording from sample dates", () => {
  const mk = (...dates: string[]): FeedItem[] => dates.map((d) => ({ guid: null, url: null, title: "t", author: null, publishedAt: d, summaryHtml: null, contentHtml: null, imageUrl: null, enclosures: [], durationSeconds: null, videoId: null }));
  const now = new Date("2026-11-03T12:00:00Z");
  assert.equal(cadenceText(mk("2026-11-02T00:00:00Z", "2026-10-30T00:00:00Z", "2026-10-26T00:00:00Z", "2026-10-23T00:00:00Z"), POSTS, now), "about 2 posts a week");
  assert.equal(cadenceText(mk("2026-11-03T08:00:00Z", "2026-11-03T04:00:00Z", "2026-11-02T20:00:00Z", "2026-11-02T16:00:00Z", "2026-11-02T12:00:00Z"), POSTS, now), "about 5 posts a day");
  assert.equal(cadenceText(mk("2026-10-20T00:00:00Z", "2026-09-20T00:00:00Z", "2026-08-21T00:00:00Z"), POSTS, now), "about 1 post a month");
  assert.equal(cadenceText(mk("2026-10-20T00:00:00Z", "2026-09-20T00:00:00Z"), POSTS, now), "Latest post 15 days ago");
  assert.equal(cadenceText(mk("2026-10-20T00:00:00Z"), EPISODES, now), "Latest episode 15 days ago");
  assert.match(cadenceText(mk("2023-01-02T00:00:00Z", "2022-12-02T00:00:00Z", "2022-11-02T00:00:00Z"), POSTS, now)!, /^No new posts for about 4 years/);
  assert.equal(cadenceText([], POSTS, now), "No posts yet");
  assert.equal(cadenceText([{ ...mk("2026-10-20T00:00:00Z")[0]!, publishedAt: null }], POSTS, now), null);
  // a burst followed by silence reports the current rhythm, not the burst
  assert.equal(cadenceText(mk("2026-08-01T00:00:00Z", "2026-07-31T00:00:00Z", "2026-07-30T00:00:00Z", "2026-07-29T00:00:00Z"), POSTS, now), "about 1 post a month");
});

// ---------- end to end through the real safeFetch against a local server ----------

test("discover works end to end through safeFetch against a local server", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/") {
      return send(res, 200, "text/html", `<html><head><title>Local</title><link rel="alternate" type="application/rss+xml" title="Local feed" href="/feed.xml"></head><body></body></html>`);
    }
    if (req.url === "/feed.xml") return send(res, 200, "application/rss+xml", rssWithDates("Local Blog", WEEKLY, { full: true, link: server.origin }));
    send(res, 404, "text/plain", "no");
  });
  try {
    const d = okDraft(await discover(`${server.url}/`, { testAllowAddress: allowLoopback, now: NOW }));
    assert.equal(d.candidates[0]!.title, "Local Blog");
    assert.equal(d.candidates[0]!.feedUrl, `${server.url}/feed.xml`);
    // the same URL is refused without the in-process allowance
    const refused = await discover(`${server.url}/`);
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "blocked");
  } finally {
    await server.close();
  }
});

test("redirect from a feed address to loopback is refused during discovery", async () => {
  const server = await startServer((_req, res) => send(res, 302, "text/plain", "", { location: "http://127.0.0.2:1/secret" }));
  try {
    const d = await discover(`${server.url}/feed`, { testAllowAddress: allowLoopback, now: NOW });
    assert.ok(!d.ok);
    assert.equal(d.reason, "blocked");
  } finally {
    await server.close();
  }
});

// ---------- YouTube ----------

const CH = "UCabcdefghijklmnopqrstuv";
const CH2 = "UCzyxwvutsrqponmlkjihgfe";
const YT_ATOM = (channelId: string, name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>${channelId}</yt:channelId><title>${name}</title>
 <link rel="alternate" href="https://www.youtube.com/channel/${channelId}"/>
 <entry><id>yt:video:A</id><yt:videoId>A</yt:videoId><title>Video A</title><link rel="alternate" href="https://www.youtube.com/watch?v=A"/><published>2026-10-30T15:00:00+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/A/hq.jpg"/></media:group></entry>
 <entry><id>yt:video:B</id><yt:videoId>B</yt:videoId><title>Video B</title><link rel="alternate" href="https://www.youtube.com/watch?v=B"/><published>2026-10-23T15:00:00+00:00</published></entry>
 <entry><id>yt:video:C</id><yt:videoId>C</yt:videoId><title>Video C</title><link rel="alternate" href="https://www.youtube.com/watch?v=C"/><published>2026-10-16T15:00:00+00:00</published></entry>
</feed>`;
const YT_PLAYLIST = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><yt:playlistId>PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</yt:playlistId><title>Shed builds</title><link rel="alternate" href="https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/><entry><id>x</id><title>Part 1</title><link rel="alternate" href="https://www.youtube.com/watch?v=A"/><published>2026-10-30T15:00:00+00:00</published></entry></feed>`;
const channelPage = (id: string, extra = "") => `<!DOCTYPE html><html><head><link rel="canonical" href="https://www.youtube.com/channel/${id}"><link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=${id}"><meta itemprop="channelId" content="${id}"><title>Chan</title></head><body>${extra}</body></html>`;

function youtubeStub() {
  return stub({
    [`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`]: fakeResponse(`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`, YT_ATOM(CH, "Shed Channel"), "text/xml; charset=UTF-8"),
    [`https://www.youtube.com/feeds/videos.xml?channel_id=${CH2}`]: fakeResponse(`https://www.youtube.com/feeds/videos.xml?channel_id=${CH2}`, YT_ATOM(CH2, "Other Channel"), "text/xml; charset=UTF-8"),
    "https://www.youtube.com/feeds/videos.xml?playlist_id=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": fakeResponse("https://www.youtube.com/feeds/videos.xml?playlist_id=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", YT_PLAYLIST, "text/xml"),
    "https://www.youtube.com/@shedlife": fakeResponse("https://www.youtube.com/@shedlife", channelPage(CH, `<a href="/channel/${CH2}">recommended</a>"externalId":"${CH2}"`), "text/html"),
    "https://www.youtube.com/@ghost": fakeResponse("https://www.youtube.com/@ghost", "<html><body>404 not found</body></html>", "text/html", 404),
    "https://www.youtube.com/@consent": fakeResponse("https://consent.youtube.com/m?continue=x", `<html><body><form action="https://consent.youtube.com/save">Before you continue</form></body></html>`, "text/html"),
    "https://www.youtube.com/@mystery": fakeResponse("https://www.youtube.com/@mystery", "<html><head><title>x</title></head><body>nothing useful</body></html>", "text/html"),
    "https://www.youtube.com/@both": fakeResponse("https://www.youtube.com/@both", `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${CH}"><meta itemprop="channelId" content="${CH2}"></head></html>`, "text/html"),
    "https://www.youtube.com/c/ShedLife": fakeResponse("https://www.youtube.com/c/ShedLife", channelPage(CH), "text/html"),
    "https://www.youtube.com/user/shedman": fakeResponse("https://www.youtube.com/user/shedman", channelPage(CH), "text/html"),
    [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}`]: fakeResponse("https://www.youtube.com/oembed", JSON.stringify({ title: "Video A", author_name: "Shed Life", author_url: "https://www.youtube.com/@shedlife" }), "application/json"),
    [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=privateVid1")}`]: fakeResponse("https://www.youtube.com/oembed", "Unauthorized", "text/plain", 401),
    "https://www.youtube.com/watch?v=privateVid1": fakeResponse("https://www.youtube.com/watch?v=privateVid1", `<html><head><meta itemprop="channelId" content="${CH2}"></head></html>`, "text/html"),
  });
}

test("YouTube: /channel/UC… resolves directly to the official feed and never claims full history", async () => {
  const { fetch, calls } = youtubeStub();
  for (const input of [`https://www.youtube.com/channel/${CH}`, `youtube.com/channel/${CH}/videos`, `https://m.youtube.com/channel/${CH}?si=abc`]) {
    const d = okDraft(await discover(input, { fetch, now: NOW }));
    assert.equal(d.candidates.length, 1, input);
    const c = d.candidates[0]!;
    assert.equal(c.kind, "youtube");
    assert.equal(c.origin, "YouTube channel feed");
    assert.equal(c.via, "Channel feed");
    assert.equal(c.title, "Shed Channel");
    assert.equal(c.feedUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`);
    assert.equal(c.samples.length, 3);
    assert.equal(c.cadence, "about 1 video a week");
    assert.equal(c.summariesOnly, false);
    assert.equal(c.privateWarning, null, "a channel id is not a credential");
  }
  assert.ok(calls.every((u) => u.includes("feeds/videos.xml")), "no page scraping when the channel id is in the address");
});

test("YouTube: @handle, /c/ and /user/ pages resolve the channel id from the page itself, ignoring recommended channels", async () => {
  const { fetch } = youtubeStub();
  for (const input of ["https://www.youtube.com/@shedlife", "https://www.youtube.com/@shedlife/videos", "youtube.com/@shedlife", "https://www.youtube.com/c/ShedLife", "https://www.youtube.com/user/shedman"]) {
    const d = okDraft(await discover(input, { fetch, now: NOW }));
    assert.equal(d.candidates[0]!.feedUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`, input);
    assert.equal(d.candidates[0]!.via, "Channel feed", input);
  }
});

test("YouTube: unknown handle, consent wall, no channel and ambiguous pages give specific answers", async () => {
  const { fetch } = youtubeStub();
  const ghost = await discover("https://www.youtube.com/@ghost", { fetch });
  assert.ok(!ghost.ok);
  assert.equal(ghost.reason, "nofeed");
  assert.match(ghost.message, /no page for the handle @ghost/i);
  assert.doesNotMatch(ghost.message, /no channel/i, "a 404 for a handle is not proof that the channel does not exist");
  assert.match(ghost.message, /video|channel\/UC/i, "it says what to paste instead");
  const consent = await discover("https://www.youtube.com/@consent", { fetch });
  assert.ok(!consent.ok);
  assert.match(consent.message, /cookie consent/i);
  const mystery = await discover("https://www.youtube.com/@mystery", { fetch });
  assert.ok(!mystery.ok);
  assert.equal(mystery.reason, "unsupported");
  const both = await discover("https://www.youtube.com/@both", { fetch });
  assert.ok(!both.ok);
  assert.match(both.message, /more than one channel/i);
});

test("YouTube: a video resolves to its uploader as a related channel to confirm", async () => {
  const { fetch } = youtubeStub();
  const d = okDraft(await discover("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch, now: NOW }));
  assert.equal(d.candidates.length, 1);
  assert.equal(d.candidates[0]!.via, "Related channel — confirm");
  assert.equal(d.candidates[0]!.feedUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`);
  for (const input of ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share"]) {
    const x = okDraft(await discover(input, { fetch, now: NOW }));
    assert.equal(x.candidates[0]!.via, "Related channel — confirm", input);
  }
  // oEmbed unavailable: fall back to the watch page
  const fallback = okDraft(await discover("https://www.youtube.com/watch?v=privateVid1", { fetch, now: NOW }));
  assert.equal(fallback.candidates[0]!.feedUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CH2}`);
  assert.equal(fallback.candidates[0]!.via, "Related channel — confirm");
});

test("YouTube: playlists use the official playlist feed and are labelled as playlists; unsupported lists say why", async () => {
  const { fetch } = youtubeStub();
  const d = okDraft(await discover("https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { fetch, now: NOW }));
  const c = d.candidates[0]!;
  assert.equal(c.via, "Playlist feed");
  assert.equal(c.origin, "YouTube playlist feed");
  assert.equal(c.title, "Shed builds");
  assert.equal(c.kind, "youtube");
  // a video inside a playlist offers both the related channel and the playlist
  const both = okDraft(await discover("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { fetch, now: NOW }));
  assert.deepEqual(both.candidates.map((x) => x.via), ["Related channel — confirm", "Playlist feed"]);
  for (const bad of ["https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ", "https://www.youtube.com/playlist?list=WL", "https://www.youtube.com/", "https://www.youtube.com/feed/subscriptions", "https://www.youtube.com/results?search_query=x", "https://www.youtube.com/channel/notachannel"]) {
    const x = await discover(bad, { fetch });
    assert.ok(!x.ok, bad);
    assert.equal(x.reason, "unsupported", bad);
  }
});

test("YouTube feed addresses pasted directly are still YouTube sources", async () => {
  const { fetch } = youtubeStub();
  const d = okDraft(await discover(`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`, { fetch, now: NOW }));
  assert.equal(d.candidates[0]!.kind, "youtube");
  assert.equal(d.candidates[0]!.via, "Channel feed");
});

test("YouTube: a page that did not answer in time is asked once more, so the first lookup of a channel does not fail for a stall", async () => {
  const { fetch, calls } = youtubeStub();
  let tries = 0;
  const stalls: FetchFn = async (url, o) => (url === "https://www.youtube.com/@shedlife" && ++tries === 1 ? fakeFailure("timeout", "That website took too long to answer.") : fetch(url, o));
  const d = okDraft(await discover("https://www.youtube.com/@shedlife", { fetch: stalls, now: NOW }));
  assert.equal(d.candidates[0]!.feedUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`);
  assert.equal(tries, 2, "the page was asked for twice");
  assert.equal(calls.filter((u) => u.includes("videos.xml")).length, 1, "the feed once");
  // A connection cut off in the middle is asked again too; a refusal is not.
  let cuts = 0;
  const cut: FetchFn = async (url, o) => (url === "https://www.youtube.com/@shedlife" && ++cuts === 1 ? { ok: false, reason: "unreachable", message: "The connection to that website was interrupted.", detail: "ECONNRESET https://www.youtube.com/@shedlife" } : fetch(url, o));
  okDraft(await discover("https://www.youtube.com/@shedlife", { fetch: cut, now: NOW }));
  assert.equal(cuts, 2);
  let refusals = 0;
  const refused: FetchFn = async (url, o) => (url === "https://www.youtube.com/@shedlife" ? (refusals++, { ok: false, reason: "unreachable", message: "That website refused the connection.", detail: "ECONNREFUSED https://www.youtube.com/@shedlife" }) : fetch(url, o));
  assert.ok(!(await discover("https://www.youtube.com/@shedlife", { fetch: refused, now: NOW })).ok);
  assert.equal(refusals, 1);
  // A video link: its oEmbed answer stalls once too.
  let oembedTries = 0;
  const slowOembed: FetchFn = async (url, o) => (url.includes("/oembed") && ++oembedTries === 1 ? fakeFailure("timeout") : fetch(url, o));
  const video = okDraft(await discover("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: slowOembed, now: NOW }));
  assert.equal(video.keep?.title, "Video A");
  assert.equal(oembedTries, 2);
});

test("YouTube: slowness is called slowness, in the words of a timeout and not of an unreachable site", async () => {
  const { fetch } = youtubeStub();
  const never: FetchFn = async (url, o) => (url.startsWith("https://www.youtube.com/@") ? fakeFailure("timeout", "That website took too long to answer.") : fetch(url, o));
  const page = await discover("https://www.youtube.com/@shedlife", { fetch: never, now: NOW });
  assert.ok(!page.ok);
  assert.equal(page.reason, "timeout");
  assert.equal(page.message, YOUTUBE_SLOW);
  assert.doesNotMatch(page.message, /couldn't reach|website/i);
  const video = await discover("https://www.youtube.com/watch?v=privateVid1", { fetch: async (url, o) => (url.includes("watch?v=privateVid1") || url.includes("/oembed") ? fakeFailure("timeout") : fetch(url, o)), now: NOW });
  assert.ok(!video.ok);
  assert.equal(video.reason, "timeout");
  // A feed that stalls on a channel the page named: the channel is known, so it is offered with a note, as for any unreachable feed.
  const feedStall: FetchFn = async (url, o) => (url.includes("videos.xml") ? fakeFailure("timeout") : fetch(url, o));
  const offered = okDraft(await discover("https://www.youtube.com/@shedlife", { fetch: feedStall, now: NOW, retryDelayMs: 1 }));
  assert.match(offered.candidates[0]!.note ?? "", /Following will keep trying/);
  // A feed address alone has no channel name to offer, so a stalled feed there is the slowness message, not "YouTube refuses cloud servers".
  const direct = await discover(`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`, { fetch: feedStall, now: NOW, retryDelayMs: 1 });
  assert.ok(!direct.ok);
  assert.equal(direct.reason, "timeout");
  assert.equal(direct.message, YOUTUBE_SLOW);
});

test("YouTube classification and page parsing helpers", () => {
  assert.deepEqual(classifyYoutubeUrl(new URL(`https://www.youtube.com/channel/${CH}`)), { kind: "channel-id", channelId: CH });
  assert.deepEqual(classifyYoutubeUrl(new URL("https://www.youtube.com/@Some.Name/shorts")), { kind: "page", path: "/@Some.Name", label: "handle" });
  assert.equal(classifyYoutubeUrl(new URL("https://youtu.be/dQw4w9WgXcQ")).kind, "video");
  assert.equal(classifyYoutubeUrl(new URL("https://www.youtube.com/watch?v=short")).kind, "unsupported");
  assert.equal(channelIdFromHtml(`<meta itemprop="channelId" content="${CH}">`, "channel").ok, true);
  assert.equal(channelIdFromHtml(`"channelMetadataRenderer":{"title":"x","externalId":"${CH}"}`, "channel").ok, true);
  assert.equal(channelIdFromHtml("nothing", "video").ok, false);
});

test("a YouTube host lookalike is not treated as YouTube", async () => {
  const { fetch, calls } = stub({ "https://youtube.com.evil.example/": fakeResponse("https://youtube.com.evil.example/", "<html>hi</html>", "text/html") });
  const d = await discover("https://youtube.com.evil.example/", { fetch });
  assert.ok(!d.ok);
  assert.equal(d.reason, "nofeed");
  assert.ok(calls.every((u) => u.includes("evil.example")));
});

test("a feed far larger than the preview limit is still previewed from its start", async () => {
  const items = Array.from({ length: 20_000 }, (_, i) => `<item><title>Episode ${20_000 - i}</title><link>https://pod.example/e${i}</link><guid>e${i}</guid><pubDate>${new Date(Date.parse("2026-11-01T00:00:00Z") - i * 7 * 86_400_000).toUTCString()}</pubDate><description>${"notes ".repeat(30)}</description><enclosure url="https://pod.example/e${i}.mp3" type="audio/mpeg" length="1"/></item>`).join("");
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Long Running Show</title><link>https://pod.example/</link><itunes:author>x</itunes:author>${items}</channel></rss>`;
  assert.ok(xml.length > 5 * 1024 * 1024);
  const server = await startServer((_req, res) => send(res, 200, "application/xml", xml));
  try {
    const d = okDraft(await discover(`${server.url}/feed`, { testAllowAddress: allowLoopback, now: NOW }));
    const c = d.candidates[0]!;
    assert.equal(c.title, "Long Running Show");
    assert.equal(c.kind, "podcast");
    assert.equal(c.samples[0]!.title, "Episode 20000");
    assert.equal(c.cadence, "about 1 episode a week");
  } finally {
    await server.close();
  }
});

test("discovery respects a caller's AbortSignal and an overall budget", async () => {
  const server = await startServer(() => {});
  try {
    const started = Date.now();
    const d = await discover(`${server.url}/`, { testAllowAddress: allowLoopback, timeoutMs: 300 });
    assert.ok(!d.ok);
    assert.equal(d.reason, "timeout");
    assert.ok(Date.now() - started < 3000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const e = await discover(`${server.url}/`, { testAllowAddress: allowLoopback, signal: controller.signal });
    assert.ok(!e.ok);
    assert.equal(e.reason, "timeout");
  } finally {
    await server.close();
  }
});

test("a stubbed fetch receives the safety-relevant options", async () => {
  const seen: SafeFetchOptions[] = [];
  const fetch: FetchFn = async (url, opts) => {
    seen.push(opts ?? {});
    return fakeResponse(url, rssWithDates("S", WEEKLY), "application/rss+xml");
  };
  okDraft(await discover("https://s.example/feed", { fetch, now: NOW }));
  assert.ok(seen[0]!.signal, "a deadline signal is always passed");
  assert.ok((seen[0]!.maxBytes ?? 0) <= 8 * 1024 * 1024);
  const direct = await safeFetch("http://127.0.0.1:9/", { timeoutMs: 500 });
  assert.ok(!direct.ok && direct.reason === "blocked");
});

test("generic feed titles fall back to something meaningful", async () => {
  const { meaningfulTitle } = await import("./discover.ts");
  assert.equal(meaningfulTitle("RSS"), null);
  assert.equal(meaningfulTitle(" Feed "), null);
  assert.equal(meaningfulTitle("Dan Luu"), "Dan Luu");
});

test("YouTube's flaky feed: retried, then the known channel is still offered with a note", async () => {
  const flaky = "UCbbbbbbbbbbbbbbbbbbbbbb";
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${flaky}`;
  let feedCalls = 0;
  const base = stub({ "https://www.youtube.com/@cloudblocked": fakeResponse("https://www.youtube.com/@cloudblocked", channelPage(flaky), "text/html") });
  // First answer 404, then the real feed: the retry recovers.
  const recovering: FetchFn = async (url, o) => {
    if (url === feedUrl) return ++feedCalls === 1 ? fakeResponse(feedUrl, "Not Found", "text/html", 404) : fakeResponse(feedUrl, YT_ATOM(flaky, "Cloud Channel"), "text/xml");
    return base.fetch(url, o);
  };
  const d1 = okDraft(await discover("https://www.youtube.com/@cloudblocked", { fetch: recovering, now: NOW, retryDelayMs: 0 }));
  assert.equal(d1.candidates[0]!.title, "Cloud Channel");
  assert.equal(feedCalls, 2);
  // Always 404: the channel is still offered (the engine keeps retrying), never "check for typos".
  const refusing: FetchFn = async (url, o) => (url === feedUrl ? fakeResponse(feedUrl, "Not Found", "text/html", 404) : base.fetch(url, o));
  const d2 = okDraft(await discover("https://www.youtube.com/@cloudblocked", { fetch: refusing, now: NOW, retryDelayMs: 0 }));
  assert.equal(d2.candidates[0]!.feedUrl, feedUrl);
  assert.equal(d2.candidates[0]!.title, "@cloudblocked");
  assert.match(d2.candidates[0]!.note ?? "", /keep trying/);
  // A pasted feed address with no channel to fall back on gets an honest message.
  const d3 = await discover(feedUrl, { fetch: refusing, now: NOW, retryDelayMs: 0 });
  assert.equal(d3.ok, false);
  if (!d3.ok) assert.equal(d3.message, YOUTUBE_REFUSED);
});

test("a cookie-check bounce that only adds query noise keeps the advertised feed address", async () => {
  const { stableFeedUrl } = await import("./discover.ts");
  assert.equal(stableFeedUrl("https://www.nature.com/nature.rss", "https://www.nature.com/nature.rss?error=cookies_not_supported&code=4f1c2b9e-7a1d-4c1e-9a5e-2b7d1f0c9e11"), "https://www.nature.com/nature.rss");
  assert.equal(stableFeedUrl("https://example.org/feed?cat=3", "https://example.org/feed?cat=3&utm=x"), "https://example.org/feed?cat=3");
  assert.equal(stableFeedUrl("https://example.org/feed?cat=3", "https://example.org/feed?cat=4"), "https://example.org/feed?cat=4", "a changed parameter is a real redirect");
  assert.equal(stableFeedUrl("http://example.org/feed", "https://example.org/feed"), "https://example.org/feed", "an https upgrade is kept");
  assert.equal(stableFeedUrl("https://old.example/feed", "https://new.example/feed"), "https://new.example/feed");
});

test("Nature's cookie-check bounce never makes a pasted feed look private", async () => {
  const clean = "https://www.nature.com/nature.rss";
  const bounced = `${clean}?error=cookies_not_supported&code=4f1c2b9e-7a1d-4c1e-9a5e-2b7d1f0c9e11`;
  const body = rssWithDates("Nature", ["Mon, 02 Nov 2026 10:00:00 GMT"], { link: "https://www.nature.com" });
  // The site answers the feed only after bouncing to the noisy address.
  const fetch: FetchFn = async () => fakeResponse(bounced, body, "application/rss+xml");
  for (const pasted of [clean, bounced]) {
    const d = okDraft(await discover(pasted, { fetch, now: NOW }));
    assert.equal(d.candidates[0]!.feedUrl, clean, pasted);
    assert.equal(d.candidates[0]!.privateWarning, null, pasted);
  }
  const n = normalizeInput(bounced);
  assert.ok(n.ok && n.url === clean, "the bounce noise is dropped from pasted input");
  const other = normalizeInput("https://example.org/callback?code=abcdef123456");
  assert.ok(other.ok && other.url.includes("code="), "a code parameter without the bounce marker is left alone");
});

// ---------- services that publish a native feed at a predictable address ----------

const ghAtom = (title: string) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title><link rel="alternate" href="https://github.com/torvalds"/><entry><id>tag:github.com,2008:push/1</id><title>torvalds pushed to master</title><link rel="alternate" href="https://github.com/torvalds/linux/commit/1"/><updated>2026-11-02T10:00:00Z</updated></entry><entry><id>tag:github.com,2008:push/2</id><title>torvalds pushed to master</title><link rel="alternate" href="https://github.com/torvalds/linux/commit/2"/><updated>2026-11-01T10:00:00Z</updated></entry></feed>`;
/** What a PeerTube instance sends: RSS with the podcast namespace and a video enclosure per entry, generated by PeerTube. */
const peertubeRss = (title: string, host = "framatube.org", count = 4) => {
  const items = WEEKLY.slice(0, count).map((d, i) => `<item><title>Video ${i + 1}</title><link>https://${host}/w/v${i + 1}</link><guid>https://${host}/w/v${i + 1}</guid><pubDate>${d}</pubDate><description>About it</description><enclosure url="https://${host}/static/v${i + 1}.mp4" type="video/mp4" length="100"/></item>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${title}</title><link>https://${host}/</link><description></description><generator>PeerTube - https://${host}</generator><podcast:locked>no</podcast:locked>${items}</channel></rss>`;
};
const EMPTY_ARXIV = '<?xml version="1.0"?><rss version="2.0"><channel><title>cs.LG updates on arXiv.org</title><link>http://rss.arxiv.org/rss/cs.LG</link><description>cs.LG updates on the arXiv.org e-print archive.</description></channel></rss>';

type Service = { name: string; input: string; feedUrl: string; body: string; type?: string; title: string; via: string; origin: string };
const SERVICES: Service[] = [
  { name: "GitHub user", input: "https://github.com/torvalds", feedUrl: "https://github.com/torvalds.atom", body: ghAtom("GitHub Public Timeline Feed"), type: "application/atom+xml", title: "torvalds activity", via: "Activity feed", origin: "GitHub activity" },
  { name: "GitHub organisation", input: "github.com/vercel/", feedUrl: "https://github.com/vercel.atom", body: ghAtom("GitHub Public Timeline Feed"), type: "application/atom+xml", title: "vercel activity", via: "Activity feed", origin: "GitHub activity" },
  { name: "Steam game", input: "https://store.steampowered.com/app/730/CounterStrike_2/", feedUrl: "https://store.steampowered.com/feeds/news/app/730/", body: rssWithDates("730 RSS Feed", WEEKLY, { link: "https://store.steampowered.com" }), type: "text/xml; charset=UTF-8", title: "CounterStrike 2 news", via: "Posts feed", origin: "Steam news" },
  { name: "arXiv listing", input: "https://arxiv.org/list/cs.LG/recent", feedUrl: "https://rss.arxiv.org/rss/cs.LG", body: rssWithDates("cs.LG updates on arXiv.org", WEEKLY, { link: "https://arxiv.org" }), title: "cs.LG updates on arXiv.org", via: "Posts feed", origin: "arXiv listing" },
  { name: "Dailymotion channel", input: "https://www.dailymotion.com/dailymotion", feedUrl: "https://www.dailymotion.com/rss/user/dailymotion", body: rssWithDates("dailymotion - Most recent videos - Dailymotion", WEEKLY, { link: "https://www.dailymotion.com" }), type: "text/xml; charset=utf-8", title: "dailymotion on Dailymotion", via: "Channel feed", origin: "Dailymotion channel" },
  { name: "Odysee channel", input: "https://odysee.com/@veritasium:f", feedUrl: "https://odysee.com/$/rss/@veritasium:f", body: rssWithDates("Veritasium on Odysee", WEEKLY, { link: "https://odysee.com" }), type: "application/xml", title: "Veritasium on Odysee", via: "Channel feed", origin: "Odysee channel" },
  { name: "DeviantArt profile", input: "https://www.deviantart.com/spyed", feedUrl: "https://backend.deviantart.com/rss.xml?q=gallery:spyed", body: rssWithDates("DeviantArt: spyed's gallery", WEEKLY, { link: "https://www.deviantart.com" }), type: "text/xml; charset=utf-8", title: "DeviantArt: spyed's gallery", via: "Gallery feed", origin: "DeviantArt gallery" },
  { name: "DeviantArt gallery", input: "https://www.deviantart.com/spyed/gallery", feedUrl: "https://backend.deviantart.com/rss.xml?q=gallery:spyed", body: rssWithDates("DeviantArt: spyed's gallery", WEEKLY, { link: "https://www.deviantart.com" }), title: "DeviantArt: spyed's gallery", via: "Gallery feed", origin: "DeviantArt gallery" },
  { name: "PeerTube account", input: "https://framatube.org/a/framasoft/video-channels", feedUrl: "https://framatube.org/feeds/videos.xml?accountName=framasoft", body: peertubeRss("Framasoft"), type: "application/xml; charset=utf-8", title: "Framasoft", via: "Channel feed", origin: "PeerTube account feed" },
  { name: "PeerTube channel", input: "https://video.blender.org/c/blender_open_movies/videos", feedUrl: "https://video.blender.org/feeds/videos.xml?videoChannelName=blender_open_movies", body: peertubeRss("Blender Open Movies", "video.blender.org"), type: "application/xml; charset=utf-8", title: "Blender Open Movies", via: "Channel feed", origin: "PeerTube channel feed" },
  { name: "Behance profile", input: "https://www.behance.net/behance", feedUrl: "https://www.behance.net/feeds/user?username=behance", body: rssWithDates("Behance Team", WEEKLY, { link: "https://www.behance.net" }), type: 'application/rss+xml; charset="utf-8"', title: "Behance Team", via: "Projects feed", origin: "Behance projects" },
];

test("a profile or page address of a service with a native feed is followed through that feed, with the normal preview and no page request", async () => {
  for (const svc of SERVICES) {
    const { fetch, calls } = stub({ [svc.feedUrl]: fakeResponse(svc.feedUrl, svc.body, svc.type ?? "application/rss+xml") });
    const d = okDraft(await discover(svc.input, { fetch, now: NOW }));
    assert.equal(d.candidates.length, 1, svc.name);
    const c = d.candidates[0]!;
    assert.deepEqual([c.title, c.via, c.origin, c.feedUrl], [svc.title, svc.via, svc.origin, svc.feedUrl], svc.name);
    assert.equal(c.matchesPage, undefined, svc.name);
    assert.ok(c.samples.length > 0, `${svc.name} has its preview`);
    assert.ok(c.cadence, `${svc.name} has its cadence`);
    assert.deepEqual(calls, [svc.feedUrl], `${svc.name} asked only for the feed`);
  }
});

test("an arXiv listing's feed that is empty (weekends) is still followed, and says why it is empty", async () => {
  const feed = "https://rss.arxiv.org/rss/cs.LG";
  const { fetch } = stub({ [feed]: fakeResponse(feed, EMPTY_ARXIV, "application/rss+xml") });
  const c = okDraft(await discover("https://arxiv.org/list/cs.LG/new", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.feedUrl, feed);
  assert.deepEqual(c.samples, []);
  assert.match(c.note ?? "", /weekdays.*empty at weekends/);
  // On a weekday the same feed has entries and no note.
  const full = stub({ [feed]: fakeResponse(feed, rssWithDates("cs.LG updates on arXiv.org", WEEKLY.slice(0, 2)), "application/rss+xml") });
  const weekday = okDraft(await discover("https://arxiv.org/list/cs.LG/new", { fetch: full.fetch, now: NOW })).candidates[0]!;
  assert.equal(weekday.note, undefined);
});

test("GitHub's account feed does not disturb a repository's releases and tags", async () => {
  const rel = "https://github.com/BurntSushi/ripgrep/releases.atom";
  const tags = "https://github.com/BurntSushi/ripgrep/tags.atom";
  const profile = "https://github.com/BurntSushi.atom";
  const { fetch, calls } = stub({ [rel]: fakeResponse(rel, ghAtom("Release notes from ripgrep"), "application/atom+xml"), [tags]: fakeResponse(tags, ghAtom("Tags from ripgrep"), "application/atom+xml"), [profile]: fakeResponse(profile, ghAtom("GitHub Public Timeline Feed"), "application/atom+xml") });
  const d = okDraft(await discover("https://github.com/BurntSushi/ripgrep", { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), [rel, tags]);
  assert.ok(!calls.includes(profile));
});

test("PeerTube on a domain of its own: found by the address shape, asked for its own feed, end to end through safeFetch", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/feeds/videos.xml?accountName=alice") return send(res, 200, "application/xml", peertubeRss("Alice", "peer.example"));
    if (req.url === "/feeds/videos.xml?videoChannelName=alice_channel") return send(res, 200, "application/xml", peertubeRss("Alice's channel", "peer.example"));
    send(res, 404, "text/html", "<html><body>Not found</body></html>");
  });
  try {
    const account = okDraft(await discover(`${server.url}/a/alice/video-channels`, { testAllowAddress: allowLoopback, now: NOW })).candidates[0]!;
    assert.deepEqual([account.title, account.via, account.origin, account.feedUrl], ["Alice", "Channel feed", "PeerTube account feed", `${server.url}/feeds/videos.xml?accountName=alice`]);
    const channel = okDraft(await discover(`${server.url}/c/alice_channel/videos`, { testAllowAddress: allowLoopback, now: NOW })).candidates[0]!;
    assert.deepEqual([channel.title, channel.origin, channel.feedUrl], ["Alice's channel", "PeerTube channel feed", `${server.url}/feeds/videos.xml?videoChannelName=alice_channel`]);
    assert.deepEqual(server.requests.map((r) => r.url), ["/feeds/videos.xml?accountName=alice", "/feeds/videos.xml?videoChannelName=alice_channel"], "the pages themselves were never asked for");
  } finally {
    await server.close();
  }
});

test("when the resolved feed doesn't validate, the address goes through ordinary discovery as before", async () => {
  const page = (url: string, extra = "") => fakeResponse(url, `<html><head><title>Plain</title>${extra}</head><body>Hello</body></html>`, "text/html");
  const notFound = (url: string) => fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
  for (const svc of SERVICES) {
    // The feed address answers 404: the page is asked for next and, having no feed, gives the usual answer.
    const none = stub({ [svc.input.startsWith("http") ? svc.input : `https://${svc.input}`]: page(svc.input.startsWith("http") ? svc.input : `https://${svc.input}`), [svc.feedUrl]: notFound(svc.feedUrl) });
    const d = await discover(svc.input, { fetch: none.fetch, now: NOW });
    assert.ok(!d.ok, svc.name);
    assert.equal(d.reason, "nofeed", svc.name);
    assert.match(d.message, /couldn't find a feed/i, svc.name);
    assert.equal(none.calls[0], svc.feedUrl, `${svc.name} tried the service's feed first`);
    assert.ok(none.calls.length > 1 && none.calls[1]!.startsWith("http"), `${svc.name} then looked at the page`);
    // A page that advertises a feed of its own still gets it found the ordinary way.
    const pageUrl = svc.input.startsWith("http") ? svc.input : `https://${svc.input}`;
    const advertised = new URL("/own-feed.xml", pageUrl).href;
    const found = stub({ [pageUrl]: page(pageUrl, `<link rel="alternate" type="application/rss+xml" title="Own" href="${advertised}">`), [svc.feedUrl]: notFound(svc.feedUrl), [advertised]: fakeResponse(advertised, rssWithDates("Own feed", WEEKLY, { link: new URL(pageUrl).origin }), "application/rss+xml") });
    const e = okDraft(await discover(svc.input, { fetch: found.fetch, now: NOW }));
    assert.equal(e.candidates[0]!.feedUrl, advertised, svc.name);
  }
  // A service answering 200 with something that is not a feed (Odysee's "Invalid URL", a soft 404 page) is no feed either.
  const odysee = "https://odysee.com/$/rss/@veritasium:f";
  const invalid = stub({ [odysee]: fakeResponse(odysee, "Invalid URL", "text/plain; charset=utf-8"), "https://odysee.com/@veritasium:f": page("https://odysee.com/@veritasium:f") });
  const d = await discover("https://odysee.com/@veritasium:f", { fetch: invalid.fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "nofeed");
  // PeerTube's shape on a site that is something else: its own feed at that address (a whole blog's, whatever the query) is not taken for the channel's.
  const wp = "https://blog.example/feeds/videos.xml?videoChannelName=news";
  const generic = stub({
    [wp]: fakeResponse(wp, rssWithDates("Blog", WEEKLY, { link: "https://blog.example" }).replace("<channel>", "<channel><generator>https://wordpress.org/?v=6.8</generator>"), "application/rss+xml"),
    "https://blog.example/c/news": page("https://blog.example/c/news", `<link rel="alternate" type="application/rss+xml" title="News" href="/c/news/feed/">`),
    "https://blog.example/c/news/feed/": fakeResponse("https://blog.example/c/news/feed/", rssWithDates("News category", WEEKLY, { link: "https://blog.example" }), "application/rss+xml"),
  });
  const e = okDraft(await discover("https://blog.example/c/news", { fetch: generic.fetch, now: NOW }));
  assert.deepEqual(e.candidates.map((c) => c.feedUrl), ["https://blog.example/c/news/feed/"]);
  // DeviantArt answers an empty gallery for a name it doesn't know: that is not a source to follow.
  const unknown = "https://backend.deviantart.com/rss.xml?q=gallery:nobody-here";
  const empty = stub({ [unknown]: fakeResponse(unknown, '<rss version="2.0"><channel><title>DeviantArt: nobody-here</title><link>https://www.deviantart.com</link></channel></rss>', "text/xml"), "https://www.deviantart.com/nobody-here": page("https://www.deviantart.com/nobody-here") });
  const f = await discover("https://www.deviantart.com/nobody-here", { fetch: empty.fetch, now: NOW });
  assert.ok(!f.ok);
  assert.equal(f.reason, "nofeed");
});

test("a service that is busy does not make its address look feedless", async () => {
  const feed = "https://rss.arxiv.org/rss/cs.LG";
  const busy = stub({ [feed]: fakeResponse(feed, "slow down", "text/html", 429), "https://arxiv.org/list/cs.LG/recent": fakeResponse("https://arxiv.org/list/cs.LG/recent", "<html><body>Listing</body></html>", "text/html") });
  const d = await discover("https://arxiv.org/list/cs.LG/recent", { fetch: busy.fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "unreachable");
});

test("site pages and bare names of those services are not guessed at: the first request is for the page itself", async () => {
  for (const input of [
    "https://github.com/about", "https://github.com/settings", "https://www.deviantart.com/tag/cats", "https://www.deviantart.com/spyed/art/A-Work-1", "https://www.behance.net/search/projects?search=x", "https://www.behance.net/gallery/1/Project",
    "https://www.dailymotion.com/video/x8abc", "https://www.dailymotion.com/search/cats", "https://odysee.com/@veritasium", "https://store.steampowered.com/search/?term=x", "https://arxiv.org/abs/2511.00001",
    "https://framatube.org/about/instance", "https://framatube.org/w/abc123",
  ]) {
    const { fetch, calls } = stub({});
    await discover(input, { fetch, now: NOW });
    assert.equal(calls[0], input, input);
  }
  // A bare @name is no address at all.
  const { fetch, calls } = stub({});
  const bare = await discover("@veritasium", { fetch, now: NOW });
  assert.ok(!bare.ok);
  assert.equal(bare.reason, "invalid");
  assert.deepEqual(calls, []);
});

test("Hashnode: a profile page is not turned into a guessed blog address, since a blog's name need not be the profile's", async () => {
  const page = "https://hashnode.com/@someone";
  const company = "https://hashnode.com/blog/rss.xml";
  const { fetch, calls } = stub({ [page]: fakeResponse(page, "<html><head><title>Someone</title></head><body>Hi</body></html>", "text/html"), [company]: fakeResponse(company, rssWithDates("The foreword by Hashnode", WEEKLY, { link: "https://hashnode.com/blog" }), "application/rss+xml") });
  const c = okDraft(await discover(page, { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.feedUrl, company);
  assert.equal(c.via, "Whole site feed");
  assert.equal(c.note, WHOLE_SITE_NOTE);
  assert.ok(calls.every((u) => !u.includes("hashnode.dev")), "no personal blog was guessed");
});

// ---------- a conventional address that lands on something else ----------

test("a conventional address that the site sends to a person's page or feed is not offered as the site's feed", async () => {
  // Like Behance: any /name or /name.xml is read as a user name, so /atom.xml is the feed of the user "atom".
  const server = await startServer((req, res) => {
    const url = req.url ?? "/";
    const feed = (title: string) => send(res, 200, "application/rss+xml", rssWithDates(title, WEEKLY, { link: server.origin }));
    if (url === "/" || url === "/about") return send(res, 200, "text/html", "<html><head><title>Gallery</title></head><body>Hello</body></html>");
    if (url === "/rss") return send(res, 302, "text/plain", "", { location: "/feeds/projects" });
    if (/^\/(?:about\/)?(?:atom|feed|rss|index)(?:\.xml)?$/.test(url)) return send(res, 302, "text/plain", "", { location: `/feeds/user?username=${url.split("/").at(-1)!.replace(/\.xml$/, "")}` });
    if (url === "/feeds/projects") return feed("Featured Projects");
    if (url.startsWith("/feeds/user?username=")) return feed(`Person ${url.split("=")[1]}`);
    send(res, 404, "text/plain", "no");
  });
  try {
    for (const path of ["/", "/about"]) {
      const d = okDraft(await discover(`${server.url}${path}`, { testAllowAddress: allowLoopback, now: NOW }));
      assert.deepEqual(d.candidates.map((c) => c.title), ["Featured Projects"], `from ${path}`);
    }
  } finally {
    await server.close();
  }
});

test("a conventional address that ends at the same feed under another address is still the site's feed", async () => {
  const site = "https://site.example";
  const body = (t: string) => rssWithDates(t, WEEKLY, { link: site });
  const cases: [string, string, string][] = [
    ["/rss", `${site}/feed/`, "WordPress sends /rss to /feed/"],
    ["/feed", `${site}/blog/feed/`, "a feed kept in a folder"],
    ["/feed", `${site}/feed.xml`, "another name for the feed"],
    ["/atom.xml", "https://feeds.feedburner.com/site", "a feed kept on another host"],
  ];
  for (const [asked, landed, why] of cases) {
    const { fetch } = stub({
      [`${site}/`]: fakeResponse(`${site}/`, "<html><head><title>Site</title></head><body>Hello</body></html>", "text/html"),
      [`${site}${asked}`]: fakeResponse(landed, body("Site Blog"), "application/rss+xml"),
    });
    const d = okDraft(await discover(site, { fetch, now: NOW }));
    assert.deepEqual(d.candidates.map((c) => c.feedUrl), [landed], why);
  }
});

// ---------- Framatube ----------

test("a PeerTube page that offers only its instance's feed calls it the whole site's, never a podcast", async () => {
  const origin = "https://peer.example";
  const instance = `${origin}/feeds/videos.xml`;
  const html = `<html><head><title>Peer</title><link rel="alternate" type="application/rss+xml" title="Peer - Videos feed" href="${instance}"></head><body>x</body></html>`;
  // Not an account the resolver can confirm (the instance has no such account): the page's own advertised feed is all there is.
  const { fetch } = stub({
    [`${origin}/a/framasoft/video-channels`]: fakeResponse(`${origin}/a/framasoft/video-channels`, html, "text/html"),
    [instance]: fakeResponse(instance, peertubeRss("Peer", "peer.example"), "application/xml"),
  });
  const c = okDraft(await discover(`${origin}/a/framasoft/video-channels`, { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.feedUrl, instance);
  assert.equal(c.via, "Whole site feed");
  assert.equal(c.note, WHOLE_SITE_NOTE);
  // A feed that names an account or channel in its query is that one's, not the whole instance's.
  const own = `${origin}/feeds/videos.xml?videoChannelId=7`;
  const withOwn = stub({
    [`${origin}/w/abc`]: fakeResponse(`${origin}/w/abc`, `<html><head><title>A video</title><link rel="alternate" type="application/rss+xml" title="Channel" href="${own}"></head><body>x</body></html>`, "text/html"),
    [own]: fakeResponse(own, peertubeRss("Channel", "peer.example"), "application/xml"),
  });
  const d = okDraft(await discover(`${origin}/w/abc`, { fetch: withOwn.fetch, now: NOW })).candidates[0]!;
  assert.notEqual(d.via, "Whole site feed");
});
