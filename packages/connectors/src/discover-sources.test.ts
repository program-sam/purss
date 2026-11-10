import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_MESSAGE, discover, MISSING_HOST_MESSAGE, TIMEOUT_MESSAGE } from "./discover.ts";
import type { DiscoveryDraft, FetchFn } from "./discover.ts";
import { EMAIL_MESSAGE, NAME_MESSAGE, normalizeInput } from "./input.ts";
import { noFeedMessage } from "./platforms.ts";
import { fakeFailure, fakeResponse } from "./testing.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";

const NOW = () => new Date("2026-11-03T12:00:00Z");
const WEEKLY = ["Mon, 02 Nov 2026 10:00:00 GMT", "Mon, 26 Oct 2026 10:00:00 GMT", "Mon, 19 Oct 2026 10:00:00 GMT", "Mon, 12 Oct 2026 10:00:00 GMT", "Mon, 05 Oct 2026 10:00:00 GMT"];

function rss(title: string, dates = WEEKLY, link = "https://x.example"): string {
  const items = dates.map((d, i) => `<item><title>${title} ${i + 1}</title><link>${link}/p${i + 1}</link><guid>g${i + 1}</guid><pubDate>${d}</pubDate><description>A teaser</description></item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}/</link><description>x</description>${items}</channel></rss>`;
}
const atom = (title: string) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title><link href="https://github.com/"/><entry><title>v1</title><id>1</id><link href="https://github.com/a/b/releases/tag/v1"/><updated>2026-11-02T10:00:00Z</updated></entry></feed>`;

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
const feedRes = (url: string, body: string, type = "application/rss+xml") => fakeResponse(url, body, type);
const page = (url: string, html: string) => fakeResponse(url, html, "text/html");

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

// ---------- F42: platforms without feeds ----------

test("platforms that publish no feeds are named at once, without any request, and keeping the link stays possible", async () => {
  const urls: [string, string][] = [
    ["https://www.instagram.com/someone/", "Instagram"],
    ["https://www.tiktok.com/@creator", "TikTok"],
    ["https://www.facebook.com/page", "Facebook"],
    ["https://x.com/user", "X (Twitter)"],
    ["https://twitter.com/user", "X (Twitter)"],
    ["https://www.threads.net/@user", "Threads"],
    ["https://chat.whatsapp.com/abc", "WhatsApp"],
    ["https://discord.gg/abc", "Discord"],
    ["https://t.me/channel", "Telegram"],
    ["https://www.snapchat.com/add/x", "Snapchat"],
    ["https://www.twitch.tv/streamer", "Twitch"],
    ["https://sacredbonesrecords.bandcamp.com/", "Bandcamp"],
    ["https://open.spotify.com/show/abc", "Spotify"],
  ];
  for (const [url, name] of urls) {
    const { fetch, calls } = stub({});
    const d = await discover(url, { fetch, now: NOW });
    assert.ok(!d.ok, url);
    assert.equal(d.reason, "unsupported", url); // the Add source dialog offers 'Keep this link' for this reason
    assert.equal(d.message, noFeedMessage(name), url);
    assert.deepEqual(calls, [], `${url} was not asked for a feed`);
  }
});

// ---------- F46, F47, F45 and the other known services ----------

test("Reddit: r/x and u/x are followed through /.rss and named r/x and u/x", async () => {
  const sub = "https://www.reddit.com/r/modeltrains/.rss";
  const { fetch, calls } = stub({ [sub]: feedRes(sub, atom("How We Roll"), "application/atom+xml") });
  const c = ok(await discover("https://www.reddit.com/r/modeltrains/", { fetch, now: NOW })).candidates;
  assert.equal(c.length, 1);
  assert.equal(c[0]!.title, "r/modeltrains", "not the subreddit's tagline");
  assert.equal(c[0]!.feedUrl, sub);
  assert.equal(c[0]!.via, "Posts feed");
  assert.deepEqual(calls, [sub], "only the feed was asked for");
  const user = "https://www.reddit.com/user/spez/.rss";
  const u = ok(await discover("reddit.com/u/spez", { fetch: stub({ [user]: feedRes(user, atom("overview for spez"), "application/atom+xml") }).fetch, now: NOW })).candidates[0]!;
  assert.equal(u.title, "u/spez");
});

test("Reddit limiting requests does not turn into 'nothing to follow'", async () => {
  const sub = "https://www.reddit.com/r/modeltrains/.rss";
  const { fetch } = stub({ [sub]: fakeResponse(sub, "Too Many Requests", "text/html", 429) });
  const c = ok(await discover("https://www.reddit.com/r/modeltrains/", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.title, "r/modeltrains");
  assert.equal(c.feedUrl, sub);
  assert.match(c.note ?? "", /Reddit didn't send recent posts just now\. Following will keep trying\./);
  assert.deepEqual(c.samples, []);
});

test("GitHub: a repository link offers Releases and Tags", async () => {
  const rel = "https://github.com/BurntSushi/ripgrep/releases.atom";
  const tags = "https://github.com/BurntSushi/ripgrep/tags.atom";
  const { fetch } = stub({ [rel]: feedRes(rel, atom("Release notes from ripgrep"), "application/atom+xml"), [tags]: feedRes(tags, atom("Tags from ripgrep"), "application/atom+xml") });
  const d = ok(await discover("https://github.com/BurntSushi/ripgrep", { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.via, c.feedUrl]), [
    ["BurntSushi/ripgrep releases", "Releases feed", rel],
    ["BurntSushi/ripgrep tags", "Tags feed", tags],
  ]);
  // A repository that does not exist is the ordinary 404, in plain words.
  const missing = await discover("https://github.com/nobody/nothing-here", { fetch: stub({}).fetch, now: NOW });
  assert.ok(!missing.ok);
  assert.match(missing.message, /couldn't find anything at that address/);
});

test("Apple Podcasts: the iTunes lookup supplies the feed, and the feed goes through the same fetcher", async () => {
  const lookup = "https://itunes.apple.com/lookup?id=1234567890&entity=podcast&country=nl";
  const feed = "https://feeds.example.net/show.xml";
  const { fetch, calls } = stub({
    [lookup]: fakeResponse(lookup, JSON.stringify({ resultCount: 1, results: [{ feedUrl: feed, collectionName: "Show" }] }), "text/javascript; charset=utf-8"),
    [feed]: feedRes(feed, `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title><itunes:author>a</itunes:author><item><title>Ep</title><enclosure url="https://a.example/1.mp3" type="audio/mpeg"/><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`),
  });
  const c = ok(await discover("https://podcasts.apple.com/nl/podcast/de-show/id1234567890", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.kind, "podcast");
  assert.equal(c.feedUrl, feed);
  assert.deepEqual(calls, [lookup, feed]);
  // A show with no public feed (or an unusable one) is explained.
  const hidden = await discover("https://podcasts.apple.com/nl/podcast/de-show/id1234567890", { fetch: stub({ [lookup]: fakeResponse(lookup, JSON.stringify({ resultCount: 1, results: [{}] }), "application/json") }).fetch, now: NOW });
  assert.ok(!hidden.ok);
  assert.match(hidden.message, /Apple Podcasts doesn't list a public feed/);
  // The address the lookup names is checked like any other: a private one is refused, not fetched.
  const evil = { ...stub({ [lookup]: fakeResponse(lookup, JSON.stringify({ results: [{ feedUrl: "http://127.0.0.1/feed" }] }), "application/json") }) };
  const { safeFetch } = await import("./safe-fetch.ts");
  const guarded: FetchFn = (url, o) => (url === lookup ? evil.fetch(url, o) : safeFetch(url, o));
  const refused = await discover("https://podcasts.apple.com/nl/podcast/de-show/id1234567890", { fetch: guarded, now: NOW });
  assert.ok(!refused.ok);
  assert.equal(refused.reason, "blocked");
});

test("Substack, Medium, Tumblr, Blogger, WordPress, Vimeo and Pinterest are followed through their known feed paths", async () => {
  const cases: [string, string][] = [
    ["https://astralcodexten.substack.com/p/a-post", "https://astralcodexten.substack.com/feed"],
    ["https://medium.com/@someone", "https://medium.com/feed/@someone"],
    ["https://medium.com/netflix-techblog", "https://medium.com/feed/netflix-techblog"],
    ["https://staff.tumblr.com/", "https://staff.tumblr.com/rss"],
    ["https://buzz.blogspot.com/", "https://buzz.blogspot.com/feeds/posts/default"],
    ["https://en-blog.wordpress.com/", "https://en-blog.wordpress.com/feed/"],
    ["https://vimeo.com/staff", "https://vimeo.com/staff/videos/rss"],
    ["https://www.pinterest.com/someone/recipes/", "https://www.pinterest.com/someone/recipes.rss"],
  ];
  for (const [input, feedUrl] of cases) {
    const { fetch, calls } = stub({ [feedUrl]: feedRes(feedUrl, rss("Some Blog", WEEKLY, "https://some.example")) });
    const c = ok(await discover(input, { fetch, now: NOW })).candidates[0]!;
    assert.equal(c.feedUrl, feedUrl, input);
    assert.equal(c.title, "Some Blog", input);
    assert.deepEqual(calls, [feedUrl], input);
  }
});

// ---------- F40, F41, F54: honest failures ----------

const BARE = `<html><head><title>Plain</title></head><body>Hello</body></html>`;

test("a probe that times out is never reported as 'nothing to follow'", async () => {
  const slow = stub({ "https://plain.example/": page("https://plain.example/", BARE) });
  const timing: FetchFn = async (url, o) => (url === "https://plain.example/" ? slow.fetch(url, o) : fakeFailure("timeout"));
  const d = await discover("https://plain.example/", { fetch: timing, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "timeout");
  assert.equal(d.message, TIMEOUT_MESSAGE);
  assert.doesNotMatch(d.message, /couldn't find a feed|Nothing to follow/i);
  // The message does not put the blame on the site.
  assert.match(d.message, /may be slow or PURSS busy/);
  // A site that is limiting requests is not 'no feed' either.
  const limiting: FetchFn = async (url, o) => (url === "https://plain.example/" ? slow.fetch(url, o) : fakeResponse(url, "slow down", "text/html", 429));
  const b = await discover("https://plain.example/", { fetch: limiting, now: NOW });
  assert.ok(!b.ok);
  assert.equal(b.reason, "unreachable");
  assert.equal(b.message, BUSY_MESSAGE);
  // Only when every probe really answered 'no' is it 'no feed'.
  const none = await discover("https://plain.example/", { fetch: slow.fetch, now: NOW });
  assert.ok(!none.ok);
  assert.equal(none.reason, "nofeed");
});

test("the first request timing out says the same kind of thing", async () => {
  const d = await discover("https://slow.example/", { fetch: async () => fakeFailure("timeout"), now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "timeout");
  assert.equal(d.message, TIMEOUT_MESSAGE);
  const aborted = await discover("https://slow.example/", { fetch: async () => fakeFailure("aborted"), now: NOW });
  assert.ok(!aborted.ok && aborted.message === TIMEOUT_MESSAGE);
});

test("a host that does not resolve says it does not exist", async () => {
  const gone = (): SafeFetchResult => ({ ok: false, reason: "unreachable", message: "We couldn't find that website. Check the spelling of the address.", detail: "dns ENOTFOUND" });
  const d = await discover("https://no-such-label.example/", { fetch: async () => gone(), now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "unreachable");
  assert.equal(d.message, MISSING_HOST_MESSAGE);
  // Through the real fetch layer: a resolver that finds nothing.
  const real = await discover("https://no-such-label.example/", { resolver: async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }, now: NOW });
  assert.ok(!real.ok);
  assert.equal(real.message, MISSING_HOST_MESSAGE);
  // A resolver that merely fails is not 'does not exist'.
  const flaky = await discover("https://flaky.example/", { resolver: async () => { throw Object.assign(new Error("again"), { code: "EAI_AGAIN" }); }, now: NOW });
  assert.ok(!flaky.ok);
  assert.notEqual(flaky.message, MISSING_HOST_MESSAGE);
});

// ---------- F43, F44: things that are not links ----------

test("an email address and a name each say what they are and what to paste instead", async () => {
  for (const input of ["someone@example.com", "first.last+news@sub.example.co.uk", "mailto:someone@example.com"]) {
    const n = normalizeInput(input);
    assert.ok(!n.ok, input);
    assert.equal(n.message, EMAIL_MESSAGE, input);
    const d = await discover(input, { fetch: stub({}).fetch });
    assert.ok(!d.ok && d.reason === "invalid" && d.message === EMAIL_MESSAGE, input);
  }
  assert.match(EMAIL_MESSAGE, /^That's an email address\. Newsletters that only arrive by email can't be followed here yet; many have a web page with a feed — paste that\.$/);
  for (const input of ["Veritasium", "linus tech tips", "Mr. Beast", "the verge"]) {
    const n = normalizeInput(input);
    assert.ok(!n.ok, input);
    assert.equal(n.message, NAME_MESSAGE, input);
  }
  assert.equal(NAME_MESSAGE, "Paste a link. To follow a YouTube channel, open it in YouTube and copy its address.");
  // Not names: addresses, two addresses, @handles, and the host names that must stay refused as private.
  assert.ok(normalizeInput("example.com").ok);
  assert.equal((normalizeInput("https://a.example https://b.example") as { message: string }).message, "That doesn't look like a single web address. Paste just one address.");
  assert.match((normalizeInput("@somebody") as { message: string }).message, /Paste the full web address/);
  const local = normalizeInput("localhost");
  assert.ok(!local.ok && local.reason === "blocked");
});

// ---------- F49, F50, F52: sections, whole sites, directories and names ----------

test("a section page uses the section's own feed before any guess at the whole site", async () => {
  const pageUrl = "https://news.example/world/france";
  const own = "https://news.example/world/france/rss";
  const { fetch, calls } = stub({
    [pageUrl]: page(pageUrl, BARE),
    [own]: feedRes(own, rss("France | The News", WEEKLY, "https://news.example")),
    "https://news.example/rss": feedRes("https://news.example/rss", rss("The News", WEEKLY, "https://news.example")),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.via]), [[own, "Section feed"]]);
  assert.ok(!calls.includes("https://news.example/rss") && !calls.includes("https://news.example/feed"), "the site root was not probed");
});

test("a site-wide feed found for a section page is never picked silently: it says it is the whole site", async () => {
  const pageUrl = "https://news.example/world/france";
  const whole = "https://news.example/rss";
  const { fetch } = stub({ [pageUrl]: page(pageUrl, BARE), [whole]: feedRes(whole, rss("The News", WEEKLY, "https://news.example")) });
  const c = ok(await discover(pageUrl, { fetch, now: NOW })).candidates;
  assert.equal(c.length, 1);
  assert.equal(c[0]!.via, "Whole site feed");
  assert.match(c[0]!.note ?? "", /whole site/);
  // The section's advertised feed did not answer: the whole-site feed says why it is what is offered.
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="France" href="/world/france/rss"></head><body></body></html>`;
  const timing: FetchFn = async (url, o) => (url === "https://news.example/world/france/rss" ? fakeFailure("timeout") : stub({ [pageUrl]: page(pageUrl, html), [whole]: feedRes(whole, rss("The News", WEEKLY, "https://news.example")) }).fetch(url, o));
  const t = ok(await discover(pageUrl, { fetch: timing, now: NOW })).candidates[0]!;
  assert.equal(t.via, "Whole site feed");
  assert.match(t.note ?? "", /didn't answer, so this is the whole site's feed/);
  // On the front page the same feed is simply the site's feed.
  const front = "https://news.example/";
  const f = ok(await discover(front, { fetch: stub({ [front]: page(front, BARE), [whole]: feedRes(whole, rss("The News", WEEKLY, "https://news.example")) }).fetch, now: NOW })).candidates[0]!;
  assert.equal(f.via, "Posts feed");
  assert.equal(f.note, undefined);
});

test("a site-wide feed that answers from another host than the page's is still the whole site's", async () => {
  const pageUrl = "https://en.blog.example/category/news/";
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Blog" href="/feed/"></head><body></body></html>`;
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), "https://en.blog.example/feed/": feedRes("https://example.net/blog/feed/", rss("Blog", WEEKLY, "https://example.net/blog")) });
  const c = ok(await discover(pageUrl, { fetch, now: NOW })).candidates;
  assert.deepEqual(c.map((x) => [x.via, x.feedUrl]), [["Whole site feed", "https://example.net/blog/feed/"]]);
});

test("a page that lists the site's feeds is followed one step, and the feeds are named after the site", async () => {
  const home = "https://www.rtv.example/";
  const html = `<html><head><title>Het laatste nieuws uit de regio - RTV Example</title></head><body><a href="/rss-feeds">RSS feeds</a></body></html>`;
  const list = `<html><body><ul><li><a href="/rss/nieuws.xml">Nieuws</a></li><li><a href="https://feeds.rtv.example/sport">Sport</a></li></ul></body></html>`;
  const { fetch } = stub({
    [home]: page(home, html),
    "https://www.rtv.example/rss-feeds": page("https://www.rtv.example/rss-feeds", list),
    "https://www.rtv.example/rss/nieuws.xml": feedRes("https://www.rtv.example/rss/nieuws.xml", rss("Nieuws", WEEKLY, "https://www.rtv.example")),
    "https://feeds.rtv.example/sport": feedRes("https://feeds.rtv.example/sport", rss("Sport", WEEKLY.slice(0, 4), "https://www.rtv.example")),
  });
  const c = ok(await discover(home, { fetch, now: NOW })).candidates;
  assert.deepEqual(c.map((x) => x.title), ["RTV Example – Nieuws", "RTV Example – Sport"]);
});

test("generic feed names become the site's name; a page's own feed link name is cleaned", async () => {
  const home = "https://blog.example/";
  const html = `<html><head><title>Dan's Blog</title><meta property="og:site_name" content="Dan's Blog">
    <link rel="alternate" type="application/rss+xml" title="Dan's Blog » Feed" href="/feed/"></head><body></body></html>`;
  const { fetch } = stub({ [home]: page(home, html), "https://blog.example/feed/": feedRes("https://blog.example/feed/", rss("Feed")) });
  const c = ok(await discover(home, { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.title, "Dan's Blog");
});

test("comment feeds are not offered next to a posts feed; alone they still are, labelled", async () => {
  const home = "https://blog.example/";
  const both = `<html><head><link rel="alternate" type="application/rss+xml" title="Comments for Blog" href="/comments/feed/"><link rel="alternate" type="application/rss+xml" title="Blog" href="/feed/"></head></html>`;
  const routes = { "https://blog.example/feed/": feedRes("https://blog.example/feed/", rss("Blog")), "https://blog.example/comments/feed/": feedRes("https://blog.example/comments/feed/", rss("Comments for Blog", WEEKLY.slice(0, 2))) };
  const c = ok(await discover(home, { fetch: stub({ [home]: page(home, both), ...routes }).fetch, now: NOW })).candidates;
  assert.deepEqual(c.map((x) => x.via), ["Posts feed"]);
  const only = `<html><head><link rel="alternate" type="application/rss+xml" title="Comments for Blog" href="/comments/feed/"></head></html>`;
  const o = ok(await discover(home, { fetch: stub({ [home]: page(home, only), ...routes }).fetch, now: NOW })).candidates;
  assert.deepEqual(o.map((x) => x.via), ["Comments feed"]);
});

test("a Discourse forum offers its latest topics first, and says the posts feed is every reply", async () => {
  const home = "https://forum.example/";
  const html = `<html><head><meta name="generator" content="Discourse 3.3.0"><link rel="alternate" type="application/rss+xml" title="Latest posts" href="https://forum.example/posts.rss"></head><body></body></html>`;
  const { fetch } = stub({
    [home]: page(home, html),
    "https://forum.example/posts.rss": feedRes("https://forum.example/posts.rss", rss("Example Forum - Latest posts", WEEKLY, "https://forum.example")),
    "https://forum.example/latest.rss": feedRes("https://forum.example/latest.rss", rss("Example Forum - Latest topics", WEEKLY.slice(0, 3), "https://forum.example")),
  });
  const c = ok(await discover(home, { fetch, now: NOW })).candidates;
  assert.deepEqual(c.map((x) => [x.via, x.feedUrl]), [
    ["Latest topics", "https://forum.example/latest.rss"],
    ["All replies", "https://forum.example/posts.rss"],
  ]);
  assert.match(c[1]!.note ?? "", /every reply/);
});

// ---------- F48: a single video ----------

test("a YouTube video link offers to keep the video, with its title, channel and picture, and the channel second", async () => {
  const CH = "UCaaaaaaaaaaaaaaaaaaaaaa";
  const watch = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`;
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`;
  const body = JSON.stringify({ title: "A Very Good Video", author_name: "The Channel", author_url: `https://www.youtube.com/channel/${CH}`, thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
  const yt = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>The Channel</title><yt:channelId>${CH}</yt:channelId><link rel="alternate" href="https://www.youtube.com/channel/${CH}"/><entry><id>yt:video:dQw4w9WgXcQ</id><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>A Very Good Video</title><link rel="alternate" href="${watch}"/><published>2026-11-01T10:00:00+00:00</published></entry></feed>`;
  const { fetch } = stub({ [oembed]: fakeResponse(oembed, body, "application/json"), [feedUrl]: fakeResponse(feedUrl, yt, "text/xml") });
  const d = ok(await discover("https://youtu.be/dQw4w9WgXcQ?si=abc", { fetch, now: NOW, retryDelayMs: 0 }));
  assert.deepEqual(d.keep, { url: watch, kind: "video", title: "A Very Good Video", siteName: "YouTube", author: "The Channel", imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
  assert.equal(d.candidates[0]!.feedUrl, feedUrl);
  assert.match(d.candidates[0]!.via, /Related channel/);
  // The video can be kept even when its channel's feed cannot be found.
  const noChannel = stub({ [oembed]: fakeResponse(oembed, JSON.stringify({ title: "Orphan", author_name: "Someone" }), "application/json") });
  const k = ok(await discover("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: noChannel.fetch, now: NOW, retryDelayMs: 0 }));
  assert.equal(k.keep?.title, "Orphan");
  assert.deepEqual(k.candidates, []);
  // A video YouTube will not describe is still the old 'which channel' answer, with nothing to keep.
  const gone = await discover("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: stub({}).fetch, now: NOW, retryDelayMs: 0 });
  assert.ok(!gone.ok);
});

// ---------- known services: sections and trouble ----------

test("a category page of a known blog service offers the category's own feed first and labels the blog's feed as the whole site", async () => {
  const category = "https://writer.wordpress.com/category/science/feed/";
  const whole = "https://writer.wordpress.com/feed/";
  const { fetch, calls } = stub({ [category]: feedRes(category, rss("Science – Writer", WEEKLY, "https://writer.wordpress.com")), [whole]: feedRes(whole, rss("Writer", WEEKLY.slice(0, 4), "https://writer.wordpress.com")) });
  const c = ok(await discover("https://writer.wordpress.com/category/science/", { fetch, now: NOW })).candidates;
  assert.deepEqual(c.map((x) => [x.via, x.feedUrl]), [["Section feed", category], ["Whole site feed", whole]]);
  assert.equal(c[0]!.note, undefined);
  assert.match(c[1]!.note ?? "", /whole site, not just this page or section/);
  assert.deepEqual([...calls].sort(), [category, whole].sort(), "only the two feeds were asked for");

  // The blog's feeds live on another host than its pages (WordPress.com and Blogger blogs often do): same answer.
  const moved = stub({
    [category]: feedRes("https://blog.example.net/category/science/feed/", rss("Science – Writer", WEEKLY, "https://blog.example.net")),
    [whole]: feedRes("https://blog.example.net/feed/", rss("Writer", WEEKLY.slice(0, 4), "https://blog.example.net")),
  });
  const m = ok(await discover("https://writer.wordpress.com/category/science/", { fetch: moved.fetch, now: NOW })).candidates;
  assert.deepEqual(m.map((x) => x.via), ["Section feed", "Whole site feed"]);

  // The category has no feed of its own: only the blog's remains, and it says it is the whole blog and why.
  const only = stub({ [whole]: feedRes(whole, rss("Writer", WEEKLY, "https://writer.wordpress.com")) });
  const w = ok(await discover("https://writer.wordpress.com/category/science/", { fetch: only.fetch, now: NOW })).candidates;
  assert.deepEqual(w.map((x) => x.via), ["Whole site feed"]);
  assert.match(w[0]!.note ?? "", /didn't answer, so this is the whole site's feed/);

  // A tag page and a post page are not the front page either; the front page is simply the blog's feed.
  const t = ok(await discover("https://writer.wordpress.com/2026/01/a-post/", { fetch: only.fetch, now: NOW })).candidates;
  assert.deepEqual(t.map((x) => x.via), ["Whole site feed"]);
  const front = ok(await discover("https://writer.wordpress.com/", { fetch: only.fetch, now: NOW })).candidates;
  assert.deepEqual([front[0]!.via, front[0]!.note], ["Posts feed", undefined]);
  // A Blogger label page works the same way.
  const label = "https://buzz.blogspot.com/feeds/posts/default/-/Tips";
  const base = "https://buzz.blogspot.com/feeds/posts/default";
  const b = ok(await discover("https://buzz.blogspot.com/search/label/Tips", { fetch: stub({ [label]: feedRes(label, rss("Tips")), [base]: feedRes(base, rss("Buzz")) }).fetch, now: NOW })).candidates;
  assert.deepEqual(b.map((x) => x.via), ["Section feed", "Whole site feed"]);
});

test("a known service's feeds timing out are not 'nothing to follow' when the page has nothing else either", async () => {
  const rel = "https://github.com/acme/tool/releases.atom";
  const tags = "https://github.com/acme/tool/tags.atom";
  const repo = "https://github.com/acme/tool";
  const repoPage = page(repo, `<html><head><title>acme/tool</title></head><body>A repository</body></html>`);
  const run = async (failure: SafeFetchResult) => {
    const fetch: FetchFn = async (url) => (url === rel || url === tags ? failure : url === repo ? repoPage : fakeResponse(url, "nope", "text/html", 404));
    return discover(repo, { fetch, now: NOW });
  };
  const timed = await run(fakeFailure("timeout"));
  assert.ok(!timed.ok);
  assert.equal(timed.reason, "timeout");
  assert.equal(timed.message, TIMEOUT_MESSAGE);
  const busy = await run(fakeResponse(rel, "slow down", "text/html", 429));
  assert.ok(!busy.ok);
  assert.equal(busy.reason, "unreachable");
  assert.equal(busy.message, BUSY_MESSAGE);
  // Feeds that really are not there remain 'no feed'; and a feed the page itself advertises still wins over the trouble.
  const gone = await run(fakeResponse(rel, "nope", "text/html", 404));
  assert.ok(!gone.ok);
  assert.equal(gone.reason, "nofeed");
  const advertised = `<html><head><link rel="alternate" type="application/atom+xml" title="Commits" href="/acme/tool/commits/main.atom"></head></html>`;
  const commits = "https://github.com/acme/tool/commits/main.atom";
  const fetch: FetchFn = async (url) => (url === rel || url === tags ? fakeFailure("timeout") : url === repo ? page(repo, advertised) : url === commits ? feedRes(commits, atom("Commits"), "application/atom+xml") : fakeResponse(url, "nope", "text/html", 404));
  assert.equal(ok(await discover(repo, { fetch, now: NOW })).candidates[0]!.feedUrl, commits);
});

// ---------- which feed is the page's, names, usual feed paths ----------

const GUARDIAN_PAGE = "https://www.theguardian.com/football/series/footballweekly";
const podcastRss = (title: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title><link>${GUARDIAN_PAGE}</link><description>x</description>${WEEKLY.map((d, i) => `<item><title>Episode ${i + 1}</title><guid>e${i}</guid><pubDate>${d}</pubDate><enclosure url="https://audio.example/e${i}.mp3" length="1000" type="audio/mpeg"/></item>`).join("")}</channel></rss>`;

test("a series page whose show is a podcast offers the podcast feed first and preselects it, with the articles second", async () => {
  const podcast = `${GUARDIAN_PAGE}/podcast.xml`;
  const articles = `${GUARDIAN_PAGE}/rss`;
  const { fetch } = stub({
    [podcast]: feedRes(podcast, podcastRss("Football Weekly"), "application/xml"),
    [articles]: feedRes(articles, rss("Football Weekly | The Guardian", WEEKLY, GUARDIAN_PAGE)),
  });
  const d = ok(await discover(GUARDIAN_PAGE, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.kind, c.via, c.matchesPage]), [["podcast", "Podcast feed", true], ["feed", "Posts feed", false]]);
  assert.match(d.candidates[1]!.note ?? "", /without the audio/);
  // A series that is no podcast has no podcast.xml: the articles are offered alone, as before.
  const only = stub({ [articles]: feedRes(articles, rss("Football Weekly | The Guardian", WEEKLY, GUARDIAN_PAGE)) });
  const a = ok(await discover(GUARDIAN_PAGE, { fetch: only.fetch, now: NOW }));
  assert.deepEqual(a.candidates.map((c) => c.via), ["Posts feed"]);
  assert.equal(a.candidates[0]!.matchesPage, undefined);
});

const HUB_PAGE = "https://journals.example/journal/ns";
const HUB_LIST = "https://journals.example/webFeedsRss";
const hubFeeds = ["cnp:Cancer Nursing Practice", "en:Emergency Nurse", "ebn:Evidence-Based Nursing", "ldp:Learning Disability Practice", "mhp:Mental Health Practice", "nr:Nurse Researcher", "ncyp:Nursing Children and Young People", "nm:Nursing Management", "ns:Nursing Standard", "phc:Primary Health Care"].map((x) => x.split(":") as [string, string]);
function hubRoutes(pageTitle: string, pageUrl = HUB_PAGE): Routes {
  const list = `<html><head><title>Journals</title></head><body>${hubFeeds.map(([id, name]) => `<a href="/feeds/${id}">${name}</a>`).join("")}</body></html>`;
  return {
    [pageUrl]: page(pageUrl, `<html><head><title>${pageTitle}</title></head><body><a href="/webFeedsRss">RSS</a></body></html>`),
    [HUB_LIST]: page(HUB_LIST, list),
    ...Object.fromEntries(hubFeeds.map(([id, name]) => [`https://journals.example/feeds/${id}`, feedRes(`https://journals.example/feeds/${id}`, rss(name, WEEKLY, "https://journals.example"))])),
  };
}

test("a hub page that lists many journals' feeds offers the journal that was pasted, even when it is far down the list", async () => {
  const d = ok(await discover(HUB_PAGE, { fetch: stub(hubRoutes("Nursing Standard")).fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage]), [["Nursing Standard", true]], "only the page's own feed, preselected");
});

test("a hub page with none of the listed feeds being the pasted journal offers a few and preselects none", async () => {
  const other = "https://journals.example/journal/zz";
  const d = ok(await discover(other, { fetch: stub(hubRoutes("Something Else Entirely", other)).fetch, now: NOW }));
  assert.ok(d.candidates.length > 1);
  assert.ok(d.candidates.every((c) => c.matchesPage === false), "none is shown to be the page's own");
});

test("a page's own advertised feeds are its own; a front page's conventional feed is the site's", async () => {
  const home = "https://blog.example/";
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Blog" href="/feed/"><link rel="alternate" type="application/rss+xml" title="Notes" href="/notes/feed/"></head></html>`;
  const routes = { "https://blog.example/feed/": feedRes("https://blog.example/feed/", rss("Blog")), "https://blog.example/notes/feed/": feedRes("https://blog.example/notes/feed/", rss("Notes", WEEKLY.slice(0, 3))) };
  const advertised = ok(await discover(home, { fetch: stub({ [home]: page(home, html), ...routes }).fetch, now: NOW })).candidates;
  assert.deepEqual(advertised.map((c) => c.matchesPage), [true, true]);
  const probed = ok(await discover(home, { fetch: stub({ [home]: page(home, BARE), "https://blog.example/feed": feedRes("https://blog.example/feed", rss("Blog")) }).fetch, now: NOW })).candidates;
  assert.deepEqual(probed.map((c) => c.matchesPage), [true]);
});

test("a section's feed called by the site's name is named after the section too", async () => {
  const pageUrl = "https://www.bbc.example/sport/football/teams/liverpool";
  const html = `<html><head><title>Liverpool - Football - BBC Sport</title><meta property="og:site_name" content="BBC Sport"><link rel="alternate" type="application/rss+xml" title="BBC Sport RSS feed" href="https://feeds.bbc.example/sport/football/teams/liverpool/rss.xml"></head></html>`;
  const feed = "https://feeds.bbc.example/sport/football/teams/liverpool/rss.xml";
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), [feed]: feedRes(feed, rss("BBC Sport RSS feed", WEEKLY, "https://www.bbc.example/sport")) });
  const c = ok(await discover(pageUrl, { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.title, "BBC Sport – Liverpool");
});

test("machine feed titles are tidied when the page names the source", async () => {
  const home = "https://qc.example/";
  const html = `<html><head><title>Questionable Content</title><meta property="og:site_name" content="Questionable Content"><link rel="alternate" type="application/rss+xml" title="Subscribe via RSS" href="/QCRSS.xml"></head></html>`;
  const { fetch } = stub({ [home]: page(home, html), "https://qc.example/QCRSS.xml": feedRes("https://qc.example/QCRSS.xml", rss("QC RSS v2", WEEKLY, "https://qc.example")) });
  assert.equal(ok(await discover(home, { fetch, now: NOW })).candidates[0]!.title, "Questionable Content");
});

test("a front page that failed (500) or refused (403) still gets the site's usual feed addresses tried, and says so", async () => {
  const feed = "https://comic.example/comic/rss";
  for (const status of [500, 403]) {
    const { fetch } = stub({ "https://comic.example/": fakeResponse("https://comic.example/", "<html>broken</html>", "text/html", status), [feed]: feedRes(feed, rss("Comic", WEEKLY, "https://comic.example"), "application/xml") });
    const d = ok(await discover("https://comic.example/", { fetch, now: NOW }));
    assert.equal(d.candidates[0]!.feedUrl, feed, String(status));
    assert.match(d.candidates[0]!.note ?? "", new RegExp(`front page didn't open \\(error ${status}\\)`));
  }
  // A page inside the site that fails says "that page", not "front page".
  const inner = stub({ "https://comic.example/strip/12": fakeResponse("https://comic.example/strip/12", "<html>broken</html>", "text/html", 500), "https://comic.example/rss": feedRes("https://comic.example/rss", rss("Comic", WEEKLY, "https://comic.example")) });
  const i = ok(await discover("https://comic.example/strip/12", { fetch: inner.fetch, now: NOW }));
  assert.match(i.candidates[0]!.note ?? "", /^That page didn't open \(error 500\), but this feed does\. This is the feed for the whole site/, "and the whole-site note stays");
  // Nothing found at the usual addresses either: the answer is the front page's own, as before.
  const none = stub({ "https://comic.example/": fakeResponse("https://comic.example/", "<html>broken</html>", "text/html", 500) });
  const d = await discover("https://comic.example/", { fetch: none.fetch, now: NOW });
  assert.ok(!d.ok);
  assert.match(d.message, /having problems right now \(error 500\)/);
  // A page that is not found is a typing mistake, not a reason to look around the site.
  const gone = stub({ "https://comic.example/": fakeResponse("https://comic.example/", "nope", "text/html", 404), "https://comic.example/feed": feedRes("https://comic.example/feed", rss("Comic")) });
  const g = await discover("https://comic.example/", { fetch: gone.fetch, now: NOW });
  assert.ok(!g.ok && /error 404/.test(g.message));
  assert.deepEqual(gone.calls, ["https://comic.example/"], "nothing else was asked for");
});

test("publisher software that names its feed after its format is found by the second wave of usual addresses", async () => {
  const home = "https://esurf.example/";
  const feed = "https://esurf.example/xml/rss2_0.xml";
  const { fetch, calls } = stub({ [home]: page(home, BARE), [feed]: feedRes(feed, rss("Earth Surface Dynamics", WEEKLY, home), "application/xml") });
  const d = ok(await discover(home, { fetch, now: NOW }));
  assert.equal(d.candidates[0]!.feedUrl, feed);
  assert.ok(calls.includes("https://esurf.example/feed") && calls.includes("https://esurf.example/rss.php"), "the first wave was asked before the second");
  // A site that has none of them is "no feed" after the second wave too.
  const none = await discover(home, { fetch: stub({ [home]: page(home, BARE) }).fetch, now: NOW });
  assert.ok(!none.ok && none.reason === "nofeed");
});

test("feed links in the page's own body: the one that is about this page is offered, the other journals' are not", async () => {
  const html = `<html><head><title>Nursing Standard</title></head><body>${hubFeeds.slice(0, 5).map(([id, name]) => `<a href="/feeds/${id}">${name} RSS</a>`).join("")}<a href="/feeds/ns">RSS</a></body></html>`;
  const routes = hubRoutes("x");
  delete routes[HUB_LIST];
  const d = ok(await discover(HUB_PAGE, { fetch: stub({ ...routes, [HUB_PAGE]: page(HUB_PAGE, html) }).fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage]), [["Nursing Standard", true]]);
});

test("a hub of many journals' feeds offers the pasted journal when its slug is several words, however far down the list it is", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `Journal number ${i + 1}`);
  const slugOf = (n: string) => n.toLowerCase().replace(/ /g, "-");
  const own = "Nursing Standard";
  const all = [...names, own];
  const pageUrl = "https://journals.example/journal/nursing-standard";
  const list = `<html><head><title>Journals</title></head><body>${all.map((n) => `<a href="/feeds/${slugOf(n)}">${n === own ? "RSS" : `${n} RSS`}</a>`).join("")}</body></html>`;
  const routes: Routes = {
    [pageUrl]: page(pageUrl, `<html><head><title>Something unrelated</title></head><body><a href="/webFeedsRss">RSS feeds</a></body></html>`),
    "https://journals.example/webFeedsRss": page("https://journals.example/webFeedsRss", list),
    ...Object.fromEntries(all.map((n) => [`https://journals.example/feeds/${slugOf(n)}`, feedRes(`https://journals.example/feeds/${slugOf(n)}`, rss(n, WEEKLY, "https://journals.example"))])),
  };
  const d = ok(await discover(pageUrl, { fetch: stub(routes).fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage]), [[own, true]]);
});

// ---------- the cost of one lookup ----------

/** A site whose every address answers with a page on another host, as a login wall or a parked domain does. */
function elsewhereStub(front: SafeFetchResult) {
  const calls: string[] = [];
  const opts: { url: string; maxRedirects?: number }[] = [];
  const fetch: FetchFn = async (url, o) => {
    calls.push(url);
    opts.push({ url, maxRedirects: o?.maxRedirects });
    if (url === "https://wall.example/") return front;
    return fakeResponse("https://login.example/sso", "<html><body>Sign in</body></html>", "text/html", 200, { redirects: [url] });
  };
  return { fetch, calls, opts };
}

test("probing a site's usual addresses stops each wave at its first batch when they all lead to another host", async () => {
  const { fetch, calls } = elsewhereStub(fakeResponse("https://wall.example/", "<html>no</html>", "text/html", 403));
  const d = await discover("https://wall.example/", { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.match(d.message, /403/);
  assert.equal(calls.length, 1 + 3 + 3, "the page, then one batch of the usual addresses and one of the second wave, and no more");
  // The same for a page that opened but has no feed.
  const open = elsewhereStub(fakeResponse("https://wall.example/", "<html><head><title>Plain</title></head></html>", "text/html"));
  const n = await discover("https://wall.example/", { fetch: open.fetch, now: NOW });
  assert.ok(!n.ok);
  assert.equal(open.calls.length, 1 + 3 + 3);
});

test("the usual addresses are asked for with at most two redirects each, and one lookup has a cap on what it asks", async () => {
  const { fetch, opts } = elsewhereStub(fakeResponse("https://wall.example/", "<html>no</html>", "text/html", 500));
  await discover("https://wall.example/", { fetch, now: NOW });
  assert.ok(opts.slice(1).every((o) => o.maxRedirects === 2), "probes of conventional paths do not follow long redirect chains");
  // Every address answers 404: the cap ends the probing, and what was found so far (nothing) is the answer.
  const calls: string[] = [];
  const answer = (url: string) => url === "https://plain.example/" ? fakeResponse(url, BARE, "text/html") : fakeResponse(url, "nope", "text/html", 404);
  const nothing: FetchFn = async (url) => { calls.push(url); return answer(url); };
  const d = await discover("https://plain.example/", { fetch: nothing, now: NOW, maxRequests: 7 });
  assert.ok(!d.ok && d.reason === "nofeed");
  assert.ok(calls.length <= 7, `${calls.length} requests`);
  const unlimited: string[] = [];
  await discover("https://plain.example/", { fetch: async (url) => { unlimited.push(url); return answer(url); }, now: NOW });
  assert.ok(unlimited.length > 7 && unlimited.length <= 40, `${unlimited.length} requests without the small cap, still bounded`);
});

test("one address that leads elsewhere ends that batch of usual addresses, not the whole lookup", async () => {
  const home = "https://odd.example/";
  const feed = "https://odd.example/comic/rss";
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    if (url === home) return page(home, BARE);
    if (url === feed) return feedRes(feed, rss("Odd comic", WEEKLY, home), "application/xml");
    // /feed alone is sent to another host's page; the rest are plain 404s.
    if (url === "https://odd.example/feed") return fakeResponse("https://cdn.example/landing", "<html>x</html>", "text/html", 200, { redirects: [url] });
    return fakeResponse(url, "nope", "text/html", 404);
  };
  const d = ok(await discover(home, { fetch, now: NOW }));
  assert.equal(d.candidates[0]!.feedUrl, feed, "the second wave still ran and found it");
  // The first wave stopped after its first batch of three; nothing past it was asked.
  assert.ok(!calls.includes("https://odd.example/index.xml"), "the rest of the first wave was skipped");
});

test("redirects count toward the cap, and a lookup that hit the cap says so instead of 'took too long'", async () => {
  const home = "https://maze.example/";
  const calls: string[] = [];
  // Every address answers after two redirects; the cap is a handful of requests.
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    if (url === home) return page(home, BARE);
    return fakeResponse(url, "nope", "text/html", 404, { redirects: [`${url}?a`, `${url}?b`] });
  };
  const d = await discover(home, { fetch, now: NOW, maxRequests: 10 });
  assert.ok(!d.ok);
  assert.ok(calls.length <= 4, `${calls.length} fetches: the redirects used the cap up`);
  assert.equal(d.reason, "nofeed");
  assert.match(d.message, /stopped looking/i);
  assert.doesNotMatch(d.message, /took too long|busy/i);
});
