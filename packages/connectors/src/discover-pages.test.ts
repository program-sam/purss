import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { server } from "@purss/copy/server";
import { discover } from "./discover.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./discover.ts";
import { decodePageKey } from "./page-feeds.ts";
import { detectPageLists } from "./page-lists.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeResponse } from "./testing.ts";
import { addressVariants, wikidataEntitiesUrl, wikidataSearchUrl } from "./wikidata.ts";

const copy = server.sources.connectors;
const words = copy.pageLists;

const NOW = () => new Date("2026-11-21T12:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/page-lists/${name}`, import.meta.url), "utf8");

const NEWS = "https://www.anthropic.com/news";
const FIREFOX = "https://www.firefox.com/en-US/releases/";

type Route = SafeFetchResult | ((url: string) => SafeFetchResult);
/** A site whose one page is `html`; every other address (the usual feed addresses included) is a 404. */
function site(url: string, html: string, extra: Record<string, Route> = {}, type = "text/html; charset=utf-8"): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const routes: Record<string, Route> = { [url]: fakeResponse(url, html, type), ...extra };
  const fetch: FetchFn = async (u) => {
    calls.push(u);
    const route = routes[u];
    if (!route) return fakeResponse(u, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(u) : route;
  };
  return { fetch, calls };
}

/** What the router would answer for a key: the posts the detector reads from the page with that recipe. */
function previewFor(html: string, pageUrl: string, key: string): { status: number; body: Buffer } {
  const source = decodePageKey(key);
  const found = detectPageLists(html, pageUrl, NOW()).candidates.find((c) => JSON.stringify(c.recipe) === JSON.stringify(source?.recipe));
  if (!found) return { status: 503, body: Buffer.from("no posts") };
  const items = found.samples.map((s) => `<item><title>${s.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title><link>${s.url}</link><guid isPermaLink="false">page:${s.id}</guid>${s.date ? `<pubDate>${new Date(s.date).toUTCString()}</pubDate>` : ""}</item>`).join("");
  return { status: 200, body: Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>Newsroom</title><link>${pageUrl}</link><description>x</description>${items}</channel></rss>`) };
}

function bridgeFor(html: string, pageUrl: string, asked: string[] = []): BridgeClient {
  return async (target) => {
    asked.push(`${target.service.id}/${target.key}`);
    return previewFor(html, pageUrl, target.key);
  };
}

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

test("a page with no feed and a clearly best list of posts: that list is offered as the page's own, with the others as choices", async () => {
  const html = fixture("anthropic-news.html");
  const asked: string[] = [];
  const { fetch } = site(NEWS, html);
  const d = ok(await discover(NEWS, { fetch, now: NOW, bridge: bridgeFor(html, NEWS, asked) }));
  assert.equal(asked.length, 3, "each list is previewed through the router");
  assert.deepEqual(d.candidates.map((c) => [c.matchesPage, c.pageList?.confidence]), [[true, "high"], [false, "medium"], [false, "medium"]]);
  const [best, second] = d.candidates as [typeof d.candidates[0], typeof d.candidates[0]];
  assert.match(best.feedUrl, /^bridge:page\/[A-Za-z0-9_-]+$/);
  assert.equal(decodePageKey(best.feedUrl.slice("bridge:page/".length))?.url, NEWS);
  assert.equal(best.siteUrl, NEWS);
  assert.equal(best.origin, copy.bridges.pageList);
  assert.equal(best.via, words.viaNumbered(1));
  assert.equal(second.via, words.viaNumbered(2));
  assert.equal(best.privateWarning, null, "a descriptor is no link anyone holds, however random its key looks");
  assert.equal(best.samples.length, 3);
  assert.ok(best.samples.every((s) => s.publishedAt), "dated posts are shown with their dates");
  assert.equal(best.cadence, "about 2 posts a week");
  // What PURSS says plainly: how it reads the list, what it can't give, what can go wrong, how undated posts are dated, and why this list.
  assert.ok(best.note?.startsWith(words.note));
  assert.match(best.note!, /laid out/);
  assert.match(best.note!, /never older ones/);
  assert.match(best.note!, /stop working when the site changes/);
  assert.match(best.note!, /dated when PURSS first sees it/);
  assert.ok(best.note!.includes(words.because([words.reasons.slugUrls, words.reasons.inMain, words.reasons.dated, words.reasons.headingTitles])), best.note!);
  assert.ok(!best.note!.includes(words.unsure), "the confident list says nothing of doubt");
  assert.ok(second.note!.includes(words.unsure), "a possible list says PURSS isn't sure and doesn't choose it");
});

test("lists PURSS is less sure of are offered and none of them is the page's own", async () => {
  const html = fixture("firefox-releases.html");
  const { fetch } = site(FIREFOX, html);
  const d = ok(await discover(FIREFOX, { fetch, now: NOW, bridge: bridgeFor(html, FIREFOX) }));
  assert.equal(d.candidates.length, 3);
  assert.ok(d.candidates.every((c) => c.pageList?.confidence === "medium" && c.matchesPage === false), "no list is marked as the page's own");
  assert.ok(d.candidates.every((c) => c.note!.includes(words.unsure)));
  assert.ok(d.candidates[0]!.note!.includes(words.doubts([words.reasons.brittle])), "what makes a list doubtful is said");
  assert.ok(d.candidates.every((c) => c.note!.includes(words.reasons.undated)), "undated posts say so");
  assert.equal(d.candidates[0]!.cadence, null, "posts without dates give no rhythm");
});

test("a single list that PURSS is not sure of is offered alone, and still not as the page's own", async () => {
  const url = "https://paulgraham.com/articles.html";
  const html = fixture("paulgraham.html");
  const { fetch } = site(url, html);
  const d = ok(await discover(url, { fetch, now: NOW, bridge: bridgeFor(html, url) }));
  assert.deepEqual(d.candidates.map((c) => [c.matchesPage, c.pageList?.confidence, c.via]), [[false, "medium", words.via]]);
});

test("a page whose best list is only a guess has no list: the usual no-feed answer", async () => {
  const text = "A long page of ordinary writing about nothing in particular, with no list of posts in it at all. ".repeat(6);
  const html = `<html><head><title>About us</title></head><body><main><p>${text}</p><p>${text}</p><a href="/contact">Contact</a><a href="/jobs">Jobs</a></main></body></html>`;
  const asked: string[] = [];
  const url = "https://plain.example/about";
  const d = await discover(url, { fetch: site(url, html).fetch, now: NOW, bridge: bridgeFor(html, url, asked) });
  assert.ok(!d.ok && d.reason === "nofeed" && d.message === copy.discover.noFeed, JSON.stringify(d));
  assert.deepEqual(asked, []);
});

test("a page that draws its list with script says so, instead of the usual no-feed answer, and nothing is asked of the bridge", async () => {
  for (const [file, url] of [["ec-presscorner.html", "https://ec.europa.eu/commission/presscorner/home/en"], ["rijksoverheid-nieuws.html", "https://www.rijksoverheid.nl/actueel/nieuws"]] as const) {
    const html = fixture(file);
    assert.match(detectPageLists(html, url, NOW()).diagnosis ?? "", /^(appShell|emptyMain)$/, file);
    const asked: string[] = [];
    const d = await discover(url, { fetch: site(url, html).fetch, now: NOW, bridge: bridgeFor(html, url, asked) });
    assert.ok(!d.ok && d.reason === "nofeed", file);
    assert.equal(d.message, words.scriptPage, file);
    assert.deepEqual(asked, [], file);
  }
  assert.match(words.scriptPage, /may build its list with JavaScript, which PURSS doesn't run/);
  assert.match(words.scriptPage, /Paste the site's feed address if it has one, or keep this link/);
});

test("a feed the page itself advertises ends the search: the lists of the page are never looked for", async () => {
  const html = fixture("anthropic-news.html").replace("<head>", `<head><link rel="alternate" type="application/rss+xml" title="News" href="/news/rss">`);
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title><link>${NEWS}</link><description>x</description><item><title>One</title><link>${NEWS}/one</link><guid>1</guid><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const asked: string[] = [];
  const { fetch } = site(NEWS, html, { "https://www.anthropic.com/news/rss": fakeResponse("https://www.anthropic.com/news/rss", rss, "application/rss+xml") });
  const d = ok(await discover(NEWS, { fetch, now: NOW, bridge: bridgeFor(html, NEWS, asked) }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), ["https://www.anthropic.com/news/rss"]);
  assert.deepEqual(asked, []);
});

const claim = (value: string) => ({ rank: "normal", mainsnak: { datavalue: { value } } });
const json = (url: string, data: unknown) => fakeResponse(url, JSON.stringify(data), "application/json");

test("a feed Wikidata lists for the page always wins: the lists of the page are looked for only when nothing was found", async () => {
  const url = "https://blog.example.org/";
  const html = fixture("anthropic-news.html");
  const u = new URL(url);
  const search = wikidataSearchUrl(addressVariants(u))!;
  const feed = "https://blog.example.org/odd/stream-9.rss";
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>${url}</link><description>x</description><item><title>One</title><link>${url}one</link><guid>1</guid><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const routes: Record<string, Route> = {
    [search]: json(search, { query: { search: [{ title: "Q1" }] } }),
    [wikidataEntitiesUrl(["Q1"])]: json(wikidataEntitiesUrl(["Q1"]), { entities: { Q1: { claims: { P856: [claim(url)], P1019: [claim(feed)], P236: [] } } } }),
    [feed]: fakeResponse(feed, rss, "application/rss+xml"),
  };
  const asked: string[] = [];
  const d = ok(await discover(url, { fetch: site(url, html, routes).fetch, now: NOW, bridge: bridgeFor(html, url, asked) }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), [feed]);
  assert.deepEqual(asked, [], "the bridge was never asked");
  // Wikidata knows nothing of the page: then the lists are looked for.
  const nothing = ok(await discover(url, { fetch: site(url, html).fetch, now: NOW, bridge: bridgeFor(html, url) }));
  assert.ok(nothing.candidates.every((c) => c.feedUrl.startsWith("bridge:page/")));
});

test("the lists of a page are not looked for where the bridge doesn't read them, or when the page didn't open as a page", async () => {
  const html = fixture("anthropic-news.html");
  const asked: string[] = [];
  const bridge = bridgeFor(html, NEWS, asked);
  const nofeed = (d: DiscoveryDraft) => assert.ok(!d.ok && d.reason === "nofeed", JSON.stringify(d));
  nofeed(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW }));
  nofeed(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge, bridgeServes: (s) => s.id !== "page" }));
  // A page that refused automated readers, a page that is a feed or something else, an address that isn't a page.
  const refused = await discover(NEWS, { fetch: site(NEWS, html, { [NEWS]: fakeResponse(NEWS, html, "text/html", 403) }).fetch, now: NOW, bridge });
  assert.ok(!refused.ok && refused.message === copy.discover.refused, JSON.stringify(refused));
  const notHtml = await discover(NEWS, { fetch: site(NEWS, "{\"a\":1}", {}, "application/json").fetch, now: NOW, bridge });
  assert.ok(!notHtml.ok && notHtml.reason === "unsupported");
  assert.deepEqual(asked, []);
  // A router that serves page lists but not RSS-Bridge's other services.
  ok(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge, bridgeServes: (s) => s.id === "page" }));
  assert.equal(asked.length, 3);
});

test("a list is offered only when the router read posts from it just now", async () => {
  const html = fixture("anthropic-news.html");
  const real = bridgeFor(html, NEWS);
  // The router answers the first list, and fails for the others in each of the ways it can.
  for (const fail of [
    async () => ({ status: 503, body: Buffer.from("busy") }),
    async () => ({ failed: true as const }),
    async () => { throw new Error("socket hang up"); },
    async () => ({ status: 200, body: Buffer.from("<html>not a feed</html>") }),
    async () => ({ status: 200, body: Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>${NEWS}</link><description>x</description></channel></rss>`) }),
  ] as BridgeClient[]) {
    let n = 0;
    const bridge: BridgeClient = (t, s) => (n++ === 0 ? real(t, s) : fail(t, s));
    const d = ok(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge }));
    assert.deepEqual(d.candidates.map((c) => [c.matchesPage, c.pageList?.confidence, c.via]), [[true, "high", words.via]], "only the list that read is offered, and it is the only one: not numbered");
  }
  // None read: the usual answer, as for a page with no list.
  const all = await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge: async () => ({ status: 503, body: Buffer.from("busy") }) });
  assert.ok(!all.ok && all.reason === "nofeed" && all.message === copy.discover.noFeed, JSON.stringify(all));
});

test("the lookup's budget holds: at most three lists are previewed, none without time to read them, and the lookup's deadline ends them", async () => {
  const html = fixture("anthropic-news.html");
  const asked: string[] = [];
  ok(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge: bridgeFor(html, NEWS, asked), maxCandidates: 2 }));
  assert.equal(asked.length, 2, "no more lists than the caller wants");
  assert.equal(asked.length, new Set(asked).size);
  // Too little of the lookup's time left to have the bridge fetch and read the page.
  const tight: string[] = [];
  const d = await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge: bridgeFor(html, NEWS, tight), timeoutMs: 5000 });
  assert.ok(!d.ok && d.reason === "nofeed" && d.message === copy.discover.noFeed);
  assert.deepEqual(tight, []);
  // The deadline arrives while the router is reading: the lookup took too long; no list is offered half-read, and the router was asked to stop.
  const stopped: boolean[] = [];
  const controller = new AbortController();
  const slow: BridgeClient = (_t, signal) => new Promise((resolve) => {
    setTimeout(() => controller.abort(), 20);
    signal.addEventListener("abort", () => { stopped.push(true); resolve({ failed: true }); });
  });
  const late = await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge: slow, signal: controller.signal });
  assert.ok(!late.ok && late.reason === "timeout" && late.message === copy.discover.timeout, JSON.stringify(late));
  assert.equal(stopped.length, 3, "all three previews were stopped");
});

test("a site that spends the lookup's whole cap of requests on addresses that redirect still has its page's list offered, from three previews of its own", async () => {
  const html = fixture("anthropic-news.html");
  const calls: string[] = [];
  const fetch: FetchFn = async (u) => {
    calls.push(u);
    if (u === NEWS) return fakeResponse(u, html, "text/html; charset=utf-8");
    return fakeResponse(u, "nope", "text/html", 404, { redirects: [`${u}?a`, `${u}?b`] });
  };
  const asked: string[] = [];
  const d = ok(await discover(NEWS, { fetch, now: NOW, bridge: bridgeFor(html, NEWS, asked), maxRequests: 10 }));
  assert.ok(calls.length <= 5, `${calls.length} requests made by discovery itself: the cap held`);
  assert.equal(asked.length, 3);
  assert.equal(d.candidates.length, 3);
});

test("a page whose address looks to carry a key is not made into a descriptor that is kept, exported and logged", async () => {
  const url = "https://example.org/private/feeds/a8f3c91d2e7b4f6a9c0d1e2f3a4b5c6d";
  const html = fixture("anthropic-news.html");
  const asked: string[] = [];
  const d = await discover(url, { fetch: site(url, html).fetch, now: NOW, bridge: bridgeFor(html, url, asked) });
  assert.ok(!d.ok && d.reason === "nofeed");
  assert.deepEqual(asked, []);
});

test("the key carries the page's final address, and asks for the character-set repair only for a page that has none of its own and needs one", async () => {
  const body = (head: string, text: string) => `<!DOCTYPE html><html><head>${head}<title>Blog</title></head><body><main>${[1, 2, 3, 4, 5, 6].map((n) => `<article><h2><a href="/blog/post-number-${n}">${text} ${n}</a></h2><time datetime="2026-11-0${n}">${n} Nov 2026</time><p>A summary of the post with some words in it so that it is not tiny, number ${n}.</p></article>`).join("")}</main></body></html>`;
  const url = "https://blog.example.net/posts";
  const keyFor = async (html: string, final = url) => {
    let key = "";
    const bridge: BridgeClient = async (t) => { key = t.key; return previewFor(html, final, t.key); };
    await discover(url, { fetch: site(url, html, final === url ? {} : { [url]: fakeResponse(url, html, "text/html; charset=utf-8", 200, { redirects: [url] }) }).fetch, now: NOW, bridge });
    return decodePageKey(key);
  };
  assert.equal((await keyFor(body("", "Café — Ça va")))?.fixEncoding, true, "UTF-8 letters and no character set in the markup");
  assert.equal((await keyFor(body('<meta charset="utf-8">', "Café — Ça va")))?.fixEncoding, false, "the markup names its character set");
  assert.equal((await keyFor(body("", "Plain ascii")))?.fixEncoding, false, "nothing outside ASCII to repair");
  assert.equal((await keyFor(body("", "Plain ascii")))?.url, url);
});

test("a descriptor from an export is that source again, previewed through the router and described the same way", async () => {
  const html = fixture("anthropic-news.html");
  const first = ok(await discover(NEWS, { fetch: site(NEWS, html).fetch, now: NOW, bridge: bridgeFor(html, NEWS) }));
  const descriptor = first.candidates[0]!.feedUrl;
  const asked: string[] = [];
  const again = ok(await discover(descriptor, { bridge: bridgeFor(html, NEWS, asked), now: NOW }));
  assert.equal(again.candidates.length, 1);
  assert.equal(again.candidates[0]!.feedUrl, descriptor);
  assert.equal(again.candidates[0]!.siteUrl, NEWS);
  assert.equal(again.candidates[0]!.via, words.via);
  assert.equal(again.candidates[0]!.note, words.note);
  assert.equal(again.candidates[0]!.origin, copy.bridges.pageList);
  assert.equal(again.candidates[0]!.pageList, undefined, "an exported source is followed as it is, and chosen: it is the one that was exported");
  assert.equal(asked.length, 1);
  // The router can't read it just now: the message names the page, not the key.
  const broken = await discover(descriptor, { bridge: async () => ({ status: 503, body: Buffer.from("x") }), now: NOW });
  assert.ok(!broken.ok && broken.reason === "unreachable");
  assert.ok(broken.message.includes(NEWS) && !broken.message.includes(descriptor.slice(-30)), broken.message);
  // Without the router, or with a key that isn't one, a descriptor is refused.
  const none = await discover(descriptor, { now: NOW });
  assert.ok(!none.ok && none.message === copy.discover.bridgeNotRun);
  const bad = await discover("bridge:page/AAAAAAAAAA", { bridge: async () => { throw new Error("must not be asked"); }, now: NOW });
  assert.ok(!bad.ok && bad.message === copy.discover.bridgeNotRun);
});

test("every word the detector gives a list has words of its own, and the notes never name the machinery", () => {
  for (const [code, text] of Object.entries(words.reasons)) assert.ok(text.length > 8 && !/xpath|recipe|bridge|rss-bridge|detector/i.test(text), code);
  for (const text of [words.note, words.unsure, words.scriptPage, words.via, words.viaNumbered(2)]) assert.doesNotMatch(text, /xpath|recipe|rss-bridge|detector|descriptor/i);
});
