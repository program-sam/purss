import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { server } from "@purss/translations/server";
import { lookupLink } from "./link-lookup.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./link-lookup.ts";
import { decodePageKey } from "./page-feeds.ts";
import { detectPageLists } from "./page-lists.ts";
import { SCRIPT_BYTES, SCRIPT_FEEDS, SCRIPT_FILE_BYTES, SCRIPT_FILES, SCRIPT_SIBLINGS } from "./script-scan.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { fakeResponse } from "./testing.ts";
import { addressVariants, wikidataEntitiesUrl, wikidataSearchUrl } from "./wikidata.ts";

const copy = server.sources.connectors;
const words = copy.pageLists;
const NOW = () => new Date("2026-11-21T12:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/page-lists/${name}`, import.meta.url), "utf8");

/** A page built with script, as the fixtures are: no list of its own. */
const SHELL_URL = "https://www.rijksoverheid.nl/actueel/nieuws";
const shell = (head = "", body = "") => fixture("rijksoverheid-nieuws.html").replace("<head>", `<head>${head}`).replace("</body>", `${body}</body>`);
/** A page whose own list the detector reads with confidence, and a page of the same site whose list it also reads. */
const LIST_URL = "https://www.anthropic.com/news";
const LISTED = fixture("anthropic-news.html");

const WEEKLY = ["Mon, 16 Nov 2026 10:00:00 GMT", "Mon, 09 Nov 2026 10:00:00 GMT", "Mon, 02 Nov 2026 10:00:00 GMT"];
const rss = (title: string, link: string, n = 3) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>x</description>${WEEKLY.slice(0, n).map((d, i) => `<item><title>${title} ${i + 1}</title><link>${link}/p${i + 1}</link><guid>${link}-${i + 1}</guid><pubDate>${d}</pubDate></item>`).join("")}</channel></rss>`;
const feed = (url: string, title = "Newsroom", n = 3) => fakeResponse(url, rss(title, url.replace(/\/$/, ""), n), "application/rss+xml");
const html = (url: string, body: string) => fakeResponse(url, body, "text/html; charset=utf-8");
const script = (url: string, text: string) => fakeResponse(url, text, "application/javascript");
const json = (url: string, data: unknown) => fakeResponse(url, JSON.stringify(data), "application/json");

type Route = SafeFetchResult | ((url: string, opts?: SafeFetchOptions) => SafeFetchResult);
/** A site made of the routes given; every other address is a 404. `calls` lists every address asked for, in order. */
function site(routes: Record<string, Route>): { fetch: FetchFn; calls: string[]; options: Map<string, SafeFetchOptions | undefined> } {
  const calls: string[] = [];
  const options = new Map<string, SafeFetchOptions | undefined>();
  const fetch: FetchFn = async (u, opts) => {
    calls.push(u);
    options.set(u, opts);
    const route = routes[u];
    if (!route) return fakeResponse(u, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(u, opts) : route;
  };
  return { fetch, calls, options };
}

/** What the router would answer for a key: the posts the detector reads from the page with that recipe. */
function router(pages: Record<string, string>, asked: string[] = []): BridgeClient {
  return async (target) => {
    const source = decodePageKey(target.key);
    asked.push(source?.url ?? "?");
    const html = source ? pages[source.url] : undefined;
    const found = html ? detectPageLists(html, source!.url, NOW()).candidates.find((c) => JSON.stringify(c.recipe) === JSON.stringify(source!.recipe)) : undefined;
    if (!found) return { status: 503, body: Buffer.from("no posts") };
    const items = found.samples.map((s) => `<item><title>${s.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title><link>${s.url}</link><guid isPermaLink="false">page:${s.id}</guid>${s.date ? `<pubDate>${new Date(s.date).toUTCString()}</pubDate>` : ""}</item>`).join("");
    return { status: 200, body: Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>Newsroom</title><link>${source!.url}</link><description>x</description>${items}</channel></rss>`) };
  };
}

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

test("a feed a script writes out is found, checked like any feed, and offered with a note that the page doesn't link it, never as the page's own", async () => {
  const page = "https://www.rotterdam.nl/nieuws";
  const feedUrl = "https://www.rotterdam.nl/feed/rss/nieuws/";
  const { fetch, calls } = site({
    [page]: html(page, `<html><head><title>Nieuws - Rotterdam</title><script src="/_next/static/chunks/nieuws-1a2b.js"></script></head><body><div id="__next"></div></body></html>`),
    "https://www.rotterdam.nl/_next/static/chunks/nieuws-1a2b.js": script("x", `var a="/api/deepl/translate",b="${new URL(feedUrl).pathname}",c="/_next/image";`),
    [feedUrl]: feed(feedUrl, "Nieuws Rotterdam"),
  });
  const d = ok(await lookupLink(page, { fetch, now: NOW }));
  assert.equal(d.candidates.length, 1);
  const c = d.candidates[0]!;
  assert.deepEqual([c.feedUrl, c.route, c.fromScripts, c.matchesPage, c.note], [feedUrl, "script-feed", true, false, copy.scriptScan.feedNote]);
  assert.equal(c.samples.length, 3, "it is a preview of the feed as it is: its posts");
  assert.match(copy.scriptScan.feedNote, /doesn't link to this feed/);
  assert.match(copy.scriptScan.feedNote, /page's own scripts/);
  assert.ok(calls.indexOf(feedUrl) > calls.indexOf("https://www.rotterdam.nl/_next/static/chunks/nieuws-1a2b.js"), "the script was read first");
  assert.ok(!calls.includes("https://www.rotterdam.nl/api/deepl/translate") && !calls.includes("https://www.rotterdam.nl/_next/image"), "an interface or an image route is not asked for");
});

test("an address a script names counts only when it answers as a feed with entries", async () => {
  const page = "https://news.example/overview";
  const names = ["/rss/a.xml", "/rss/b.xml", "/rss/c.xml", "/rss/d.xml", "/rss/e.xml"];
  const url = (p: string) => `https://news.example${p}`;
  const { fetch } = site({
    [page]: html(page, `<html><head><script src="/app.js"></script></head><body></body></html>`),
    "https://news.example/app.js": script("x", names.map((n) => `"${n}"`).join(",")),
    [url("/rss/a.xml")]: html(url("/rss/a.xml"), "<html><body>A page that is not a feed</body></html>"),
    [url("/rss/b.xml")]: feed(url("/rss/b.xml"), "Empty", 0),
    [url("/rss/c.xml")]: fakeResponse(url("/rss/c.xml"), "{\"not\":\"a feed\"}", "application/json"),
    [url("/rss/d.xml")]: fakeResponse(url("/rss/d.xml"), "", "application/rss+xml", 500),
    [url("/rss/e.xml")]: feed(url("/rss/e.xml"), "The one that works"),
  });
  const d = ok(await lookupLink(page, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), [url("/rss/e.xml")]);
  // Nothing of them answers as a feed: the usual answer.
  const none = await lookupLink(page, { fetch: site({ [page]: html(page, `<html><head><script src="/app.js"></script></head><body></body></html>`), "https://news.example/app.js": script("x", names.map((n) => `"${n}"`).join(",")) }).fetch, now: NOW });
  assert.ok(!none.ok && none.reason === "nofeed" && none.message === copy.discover.noFeed, JSON.stringify(none));
});

test("at most three script feeds are offered, one feed written two ways once, and a feed of comments never", async () => {
  const page = "https://blog.example.net/archive";
  const addresses = ["/rss/one.xml", "/rss/two.xml", "/rss/three.xml", "/rss/four.xml", "/rss/dup.xml", "/comments/rss.xml"];
  const same = rss("Shared", "https://blog.example.net/shared");
  const { fetch } = site({
    [page]: html(page, `<html><head><script src="/a.js"></script></head></html>`),
    "https://blog.example.net/a.js": script("x", addresses.map((n) => `"${n}"`).join(",")),
    ...Object.fromEntries(addresses.slice(0, 4).map((n) => [`https://blog.example.net${n}`, feed(`https://blog.example.net${n}`, `Feed ${n}`)])),
    "https://blog.example.net/rss/dup.xml": fakeResponse("https://blog.example.net/rss/dup.xml", same, "application/rss+xml"),
    "https://blog.example.net/rss/one.xml": fakeResponse("https://blog.example.net/rss/one.xml", same, "application/rss+xml"),
    "https://blog.example.net/comments/rss.xml": feed("https://blog.example.net/comments/rss.xml", "Comments on the blog"),
  });
  const d = ok(await lookupLink(page, { fetch, now: NOW }));
  assert.ok(d.candidates.length <= 3 && d.candidates.length >= 2, `${d.candidates.length} feeds`);
  assert.ok(!d.candidates.some((c) => c.feedUrl.includes("comments")), "no comment feed");
  assert.equal(d.candidates.filter((c) => c.title === "Shared" || c.feedUrl.endsWith("dup.xml") || c.feedUrl.endsWith("one.xml")).length, 1, "the same posts under two addresses are one choice");
  assert.ok(d.candidates.every((c) => c.fromScripts === true && c.matchesPage === false && c.route === "script-feed"));
});

test("a page of the same site that the scripts name, which shows its list as markup, is offered through the router; never as the page's own", async () => {
  const sibling = "https://www.rijksoverheid.nl/actueel";
  const asked: string[] = [];
  const page = shell(`<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"item":"${sibling}"},{"item":"${SHELL_URL}#breadcrumb"}]}</script>`);
  const { fetch, calls } = site({ [SHELL_URL]: html(SHELL_URL, page), [sibling]: html(sibling, LISTED) });
  const d = ok(await lookupLink(SHELL_URL, { fetch, now: NOW, bridge: router({ [sibling]: LISTED }, asked) }));
  assert.ok(d.candidates.length >= 1 && d.candidates.length <= 3);
  for (const c of d.candidates) {
    assert.equal(c.route, "script-page");
    assert.equal(c.fromScripts, true);
    assert.equal(c.matchesPage, false, "PURSS can't tell that it is the page's own");
    assert.ok(c.pageList?.confidence === "high" || c.pageList?.confidence === "medium", "it keeps what the detector thought of it");
    assert.match(c.feedUrl, /^bridge:page\/[A-Za-z0-9_-]+$/);
    assert.equal(decodePageKey(c.feedUrl.slice("bridge:page/".length))?.url, sibling, "the source is the sibling page's list");
    assert.equal(c.siteUrl, sibling);
    assert.ok(c.note?.startsWith(copy.scriptScan.listNote("rijksoverheid.nl/actueel")), String(c.note));
    assert.ok(c.note!.includes(words.note), "and what PURSS says of every list it reads from a layout");
  }
  assert.deepEqual([...new Set(asked)], [sibling], "the list was previewed through the router");
  assert.ok(calls.includes(sibling));
  assert.match(copy.scriptScan.listNote("x.example/news"), /^PURSS found this list on x\.example\/news, which the page's scripts point to\.$/);
});

test("the usual answer when nothing a script names is a feed or a page with a list: a page that builds its list with script says so", async () => {
  const page = shell(`<script src="/app.js"></script>`, `<script>const n = "/actueel/nieuws"; const t = "/actueel/zoeken";</script>`);
  const { fetch, calls } = site({
    [SHELL_URL]: html(SHELL_URL, page),
    "https://www.rijksoverheid.nl/app.js": script("x", `const a="/actueel/zoeken", b="/api/rss-nope", c="/over-ons";`),
    "https://www.rijksoverheid.nl/actueel/zoeken": html("https://www.rijksoverheid.nl/actueel/zoeken", "<html><body><p>Search</p></body></html>"),
  });
  const d = await lookupLink(SHELL_URL, { fetch, now: NOW, bridge: router({}) });
  assert.ok(!d.ok && d.reason === "nofeed" && d.message === words.scriptPage, JSON.stringify(d));
  assert.ok(calls.includes("https://www.rijksoverheid.nl/app.js") && calls.includes("https://www.rijksoverheid.nl/actueel/zoeken"), "the scan did look");
  // A plain page with nothing script-built keeps the plain answer.
  const plain = "https://plain.example/about";
  const text = "A long page of ordinary writing about nothing in particular, with no list of posts in it at all. ".repeat(6);
  const p = await lookupLink(plain, { fetch: site({ [plain]: html(plain, `<html><head><title>About</title><script src="/a.js"></script></head><body><main><p>${text}</p><p>${text}</p></main></body></html>`), "https://plain.example/a.js": script("x", `"/jobs"`) }).fetch, now: NOW, bridge: router({}) });
  assert.ok(!p.ok && p.message === copy.discover.noFeed);
});

test("order: a feed found anywhere earlier ends the search, a script feed beats the page's list, and the page's own list beats a sibling's", async () => {
  // Wikidata names a feed: the scripts are never read.
  const url = "https://blog.example.org/";
  const claim = (value: string) => ({ rank: "normal", mainsnak: { datavalue: { value } } });
  const search = wikidataSearchUrl(addressVariants(new URL(url)))!;
  const wdFeed = "https://blog.example.org/odd/stream-9.rss";
  const withScript = LISTED.replace("<head>", `<head><script src="/app.js"></script>`);
  const registry = site({
    [url]: html(url, withScript),
    "https://blog.example.org/app.js": script("x", `"/feed/from-script.xml"`),
    [search]: json(search, { query: { search: [{ title: "Q1" }] } }),
    [wikidataEntitiesUrl(["Q1"])]: json(wikidataEntitiesUrl(["Q1"]), { entities: { Q1: { claims: { P856: [claim(url)], P1019: [claim(wdFeed)], P236: [] } } } }),
    [wdFeed]: feed(wdFeed, "Registry"),
    "https://blog.example.org/feed/from-script.xml": feed("https://blog.example.org/feed/from-script.xml", "From script"),
  });
  const first = ok(await lookupLink(url, { fetch: registry.fetch, now: NOW }));
  assert.deepEqual(first.candidates.map((c) => [c.route, c.feedUrl]), [["wikidata", wdFeed]]);
  assert.ok(!registry.calls.includes("https://blog.example.org/app.js"), "no script was read");

  // A feed in a script and a list on the page: the feed, and the router is never asked.
  const asked: string[] = [];
  const both = site({
    [LIST_URL]: html(LIST_URL, LISTED.replace("<head>", `<head><script src="/app.js"></script>`)),
    "https://www.anthropic.com/app.js": script("x", `"/news/rss-feed.xml"`),
    "https://www.anthropic.com/news/rss-feed.xml": feed("https://www.anthropic.com/news/rss-feed.xml", "Anthropic news"),
  });
  const feedWins = ok(await lookupLink(LIST_URL, { fetch: both.fetch, now: NOW, bridge: router({ [LIST_URL]: LISTED }, asked) }));
  assert.deepEqual(feedWins.candidates.map((c) => c.route), ["script-feed"]);
  assert.deepEqual(asked, []);

  // The page's own list, and a sibling in a script: the page's own list; the sibling is not even asked for.
  const sibling = "https://www.anthropic.com/news/archive";
  const own = site({
    [LIST_URL]: html(LIST_URL, LISTED.replace("<head>", `<head><script src="/app.js"></script>`)),
    "https://www.anthropic.com/app.js": script("x", `"/news/archive"`),
    [sibling]: html(sibling, fixture("anthropic-research.html")),
  });
  const ownWins = ok(await lookupLink(LIST_URL, { fetch: own.fetch, now: NOW, bridge: router({ [LIST_URL]: LISTED, [sibling]: fixture("anthropic-research.html") }, asked) }));
  assert.ok(ownWins.candidates.every((c) => c.route === "page-list" && !c.fromScripts));
  assert.equal(ownWins.candidates[0]!.matchesPage, true);
  assert.ok(!own.calls.includes(sibling), "the sibling was not asked for");
});

test("caps: ten script files, three MiB, six feeds and two pages, only the page's own site's scripts, inline ones too", async () => {
  const page = "https://www.example.net/news";
  const routes: Record<string, Route> = {};
  const scripts = Array.from({ length: 14 }, (_, i) => `https://www.example.net/js/chunk-${i}.js`);
  const big = (n: number) => Buffer.alloc(n, "a");
  for (const s of scripts) routes[s] = (u) => fakeResponse(u, big(2000), "application/javascript");
  const feeds = Array.from({ length: 12 }, (_, i) => `/rss/f${i}.xml`);
  const pagesNamed = ["/aaa-news", "/bbb-news", "/ccc-news", "/ddd-news"];
  routes[page] = html(page, `<html><head>${scripts.map((s) => `<script src="${s}"></script>`).join("")}<script src="https://cdn.third-party.example/lib.js"></script><script src="https://www.googletagmanager.com/gtm.js"></script>
    <script>var names = ${JSON.stringify([...feeds, ...pagesNamed])};</script></head><body></body></html>`);
  const { fetch, calls } = site(routes);
  const d = await lookupLink(page, { fetch, now: NOW, bridge: router({}) });
  assert.ok(!d.ok);
  const fetchedScripts = calls.filter((c) => c.includes("/js/chunk-"));
  assert.equal(fetchedScripts.length, SCRIPT_FILES, "ten files");
  assert.ok(!calls.some((c) => /third-party|googletagmanager/.test(c)), "no script of another site");
  const feedCalls = calls.filter((c) => /\/rss\/f\d+\.xml$/.test(c));
  const pageCalls = calls.filter((c) => /-news$/.test(c));
  assert.ok(feedCalls.length <= SCRIPT_FEEDS, `${feedCalls.length} feeds asked`);
  assert.ok(pageCalls.length <= SCRIPT_SIBLINGS, `${pageCalls.length} pages asked`);
  assert.ok(feedCalls.length + pageCalls.length <= SCRIPT_FEEDS + SCRIPT_SIBLINGS, "eight addresses at most");
  assert.ok(feedCalls.length > 0, "the inline script's addresses were read");
});

test("the bytes of scripts are bounded: no file past two MiB, all of them together past three", async () => {
  const page = "https://www.example.net/news";
  const urls = Array.from({ length: 6 }, (_, i) => `https://www.example.net/js/file-${i}.js`);
  const asked: number[] = [];
  const routes: Record<string, Route> = { [page]: html(page, `<html><head>${urls.map((u) => `<script src="${u}"></script>`).join("")}</head></html>`) };
  for (const u of urls) routes[u] = (url, opts) => { asked.push(opts?.maxBytes ?? -1); return fakeResponse(url, Buffer.alloc(opts?.maxBytes ?? 0, "x"), "application/javascript"); };
  const { fetch } = site(routes);
  await lookupLink(page, { fetch, now: NOW });
  assert.ok(asked.every((n) => n > 0 && n <= SCRIPT_FILE_BYTES), asked.join(","));
  assert.ok(asked.length <= 3, "the room is gone after the first three or so: two MiB, one MiB, then none");
  assert.ok(asked.reduce((a, b) => a + b, 0) <= SCRIPT_BYTES + SCRIPT_FILE_BYTES, "what was asked for never exceeds the room");
});

test("only the page's own site is asked: another site's page is no sibling, and an address with a key is never asked for", async () => {
  const page = "https://www.example.net/news";
  const { fetch, calls } = site({
    [page]: html(page, `<html><head><script src="/app.js"></script></head></html>`),
    "https://www.example.net/app.js": script("x", `"https://other-company.example/latest","https://www.example.net/feed.xml?token=abc123","https://www.example.net/rss/key.xml?api_key=zz","https://www.example.net/rss/h.xml?sha256=aa","https://www.example.net/rss/s.xml?client_id=1&signature=2","https://www.example.net/rss/hh.xml?hash=1","https://www.example.net/rss/k.xml?key=x1","https://www.example.net/rss/ok.xml?language=en"`),
    "https://www.example.net/rss/ok.xml?language=en": feed("https://www.example.net/rss/ok.xml?language=en"),
  });
  const d = ok(await lookupLink(page, { fetch, now: NOW, bridge: router({}) }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), ["https://www.example.net/rss/ok.xml?language=en"]);
  assert.ok(!calls.some((c) => /other-company|token=|api_key|sha256|client_id|hash=|key=x1/.test(c)), calls.filter((c) => /other|token|key|sha256|client|hash/.test(c)).join("\n"));
});

test("the step has requests and time of its own, and gives way when the lookup has too little time left", async () => {
  const page = "https://www.example.net/news";
  const body = `<html><head><script src="/a.js"></script><script src="/b.js"></script></head><body>x</body></html>`;
  // The cap of requests is spent already (two): the scripts are still read, from the step's own allowance.
  const used = site({ [page]: html(page, body), "https://www.example.net/a.js": script("x", `"/rss/found.xml"`), "https://www.example.net/rss/found.xml": feed("https://www.example.net/rss/found.xml") });
  const d = ok(await lookupLink(page, { fetch: used.fetch, now: NOW, maxRequests: 2 }));
  assert.deepEqual(d.candidates.map((c) => c.route), ["script-feed"]);
  // With only a few seconds of the lookup left, the scripts are not read at all, and the usual answer stands.
  const short = site({ [page]: html(page, body), "https://www.example.net/a.js": script("x", `"/rss/found.xml"`), "https://www.example.net/rss/found.xml": feed("https://www.example.net/rss/found.xml") });
  const none = await lookupLink(page, { fetch: short.fetch, now: NOW, timeoutMs: 9500 });
  assert.ok(!none.ok && none.message === copy.discover.noFeed, JSON.stringify(none));
  assert.ok(!short.calls.some((c) => c.endsWith(".js")), "no script was asked for");
});

test("a page whose address looks to carry a key, and one that is no web page, are left alone", async () => {
  const keyed = "https://example.net/private/feeds/a8f3c91d2e7b4f6a9c0d1e2f3a4b5c6d";
  const k = site({ [keyed]: html(keyed, `<html><head><script src="/a.js"></script></head></html>`), "https://example.net/a.js": script("x", `"/rss/found.xml"`) });
  const d = await lookupLink(keyed, { fetch: k.fetch, now: NOW });
  assert.ok(!d.ok);
  assert.ok(!k.calls.some((c) => c.endsWith(".js")), "no script was read");
});

test("a sibling the scripts name is asked for at most twice and judged like the page itself: no list, no offer", async () => {
  const page = shell(`<script>const a = "/actueel", b = "/actueel/archief", c = "/nieuws-archief";</script>`);
  const asked: string[] = [];
  const plain = `<html><body><main><p>${"Ordinary writing. ".repeat(40)}</p></main></body></html>`;
  const { fetch, calls } = site({
    [SHELL_URL]: html(SHELL_URL, page),
    "https://www.rijksoverheid.nl/actueel": html("https://www.rijksoverheid.nl/actueel", plain),
    "https://www.rijksoverheid.nl/nieuws-archief": html("https://www.rijksoverheid.nl/nieuws-archief", plain),
    // The third that the scripts name is the only one with a list, and the least likely: it is never asked for.
    "https://www.rijksoverheid.nl/actueel/archief": html("https://www.rijksoverheid.nl/actueel/archief", LISTED),
  });
  const d = await lookupLink(SHELL_URL, { fetch, now: NOW, bridge: router({ "https://www.rijksoverheid.nl/actueel/archief": LISTED }, asked) });
  assert.ok(!d.ok && d.message === words.scriptPage, JSON.stringify(d));
  assert.equal(calls.filter((c) => /\/(actueel|actueel\/archief|nieuws-archief)$/.test(c)).length, SCRIPT_SIBLINGS, "two pages, not three");
  assert.ok(!calls.includes("https://www.rijksoverheid.nl/actueel/archief"));
  assert.deepEqual(asked, [], "a page with no list is never previewed");
});

test("a sibling that sends the reader to another site, or back to the page, is not used", async () => {
  const sibling = "https://www.rijksoverheid.nl/actueel";
  const moved = fakeResponse("https://elsewhere.example/news", LISTED, "text/html", 200, { redirects: ["https://elsewhere.example/news"] });
  const away = site({ [SHELL_URL]: html(SHELL_URL, shell(`<script>const a = "/actueel";</script>`)), [sibling]: moved });
  const d = await lookupLink(SHELL_URL, { fetch: away.fetch, now: NOW, bridge: router({ "https://elsewhere.example/news": LISTED }) });
  assert.ok(!d.ok, JSON.stringify(d));
  const back = site({ [SHELL_URL]: html(SHELL_URL, shell(`<script>const a = "/actueel";</script>`)), [sibling]: fakeResponse(SHELL_URL, shell(), "text/html", 200, { redirects: [SHELL_URL] }) });
  assert.ok(!(await lookupLink(SHELL_URL, { fetch: back.fetch, now: NOW, bridge: router({ [SHELL_URL]: LISTED }) })).ok);
});

test("without a router the scripts still give their feeds, and no list is looked for", async () => {
  const page = "https://www.example.net/news";
  const found = site({ [page]: html(page, `<html><head><script src="/a.js"></script></head></html>`), "https://www.example.net/a.js": script("x", `"/rss/found.xml","/news/latest"`), "https://www.example.net/rss/found.xml": feed("https://www.example.net/rss/found.xml") });
  assert.deepEqual(ok(await lookupLink(page, { fetch: found.fetch, now: NOW })).candidates.map((c) => c.route), ["script-feed"]);
  const none = site({ [page]: html(page, `<html><head><script src="/a.js"></script></head></html>`), "https://www.example.net/a.js": script("x", `"/news/latest"`), "https://www.example.net/news/latest": html("x", LISTED) });
  assert.ok(!(await lookupLink(page, { fetch: none.fetch, now: NOW })).ok);
  assert.ok(!none.calls.includes("https://www.example.net/news/latest"), "a sibling is asked for only to preview its lists");
});

test("the page's own links name its parent and sibling pages: a breadcrumb or a menu that a script doesn't repeat is read as text too", async () => {
  const page = "https://www.cdc.gov/media/releases/index.html";
  const sibling = "https://www.cdc.gov/media/index.html";
  const asked: string[] = [];
  const markup = `<html><head><title>Media releases</title></head><body><nav><a href="/media/index.html">Media</a> <a href="/about/index.html">About</a> <a href="/other/page.html">Other</a></nav><div id="app"></div></body></html>`;
  const { fetch, calls } = site({ [page]: html(page, markup), [sibling]: html(sibling, LISTED) });
  const d = ok(await lookupLink(page, { fetch, now: NOW, bridge: router({ [sibling]: LISTED }, asked) }));
  assert.ok(d.candidates.length >= 1 && d.candidates.every((c) => c.route === "linked-page" && c.fromScripts === true && c.matchesPage === false), "named only by the page's links: its own route");
  assert.deepEqual([...new Set(asked)], [sibling]);
  assert.ok(!calls.includes("https://www.cdc.gov/about/index.html") && !calls.includes("https://www.cdc.gov/other/page.html"), "a page about something else is not asked for");
});

test("a script file that redirects to another site is not read, and a sibling on another subdomain of the site is not offered", async () => {
  const page = SHELL_URL;
  const moved = "https://www.rijksoverheid.nl/assets/app.js";
  const feedUrl = "https://www.rijksoverheid.nl/feed/rss/nieuws/";
  const { fetch, calls } = site({
    [page]: html(page, shell(`<script src="/assets/app.js"></script>`)),
    // The site sends its script to someone else's host: what that host serves is not the page's code.
    [moved]: fakeResponse("https://cdn.other.example/app.js", `const f="/feed/rss/nieuws/";`, "application/javascript", 200, { redirects: ["https://cdn.other.example/app.js"] }),
    [feedUrl]: feed(feedUrl),
  });
  const d = await lookupLink(page, { fetch, now: NOW, bridge: router({}) });
  assert.ok(!calls.includes(feedUrl), "the redirected file's addresses were not asked for");
  assert.ok(!d.ok || d.candidates.every((c) => c.route !== "script-feed"));
  // A sibling a script names on another subdomain of the same site is another part of the site, not the page's sibling.
  const named = "https://blog.rijksoverheid.nl/actueel";
  const other = site({ [page]: html(page, shell(`<script>window.r = { a: "https://blog.rijksoverheid.nl/actueel" };</script>`)), [named]: html(named, LISTED) });
  const asked: string[] = [];
  const e = await lookupLink(page, { fetch: other.fetch, now: NOW, bridge: router({ [named]: LISTED }, asked) });
  assert.deepEqual(asked, []);
  assert.ok(!e.ok || e.candidates.every((c) => c.route !== "script-page"));
});
