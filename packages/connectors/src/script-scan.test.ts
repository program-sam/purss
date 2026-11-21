import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesAKey, inlineScripts, namedAddresses, readableAddress, scriptFiles, SCRIPT_BYTES, SCRIPT_FEEDS, SCRIPT_FILE_BYTES, SCRIPT_FILES, SCRIPT_SIBLINGS } from "./script-scan.ts";
import { registrableDomain, sameSite } from "./hosts.ts";

const PAGE = "https://www.government.nl/latest/news";
const urls = (list: { url: string }[]) => list.map((a) => a.url);

test("the caps are the measured ones: ten files, three MiB, eight addresses of which two are pages", () => {
  assert.equal(SCRIPT_FILES, 10);
  assert.equal(SCRIPT_BYTES, 3 * 1024 * 1024);
  assert.ok(SCRIPT_FILE_BYTES <= SCRIPT_BYTES);
  assert.equal(SCRIPT_FEEDS + SCRIPT_SIBLINGS, 8);
});

test("a site is its registrable domain: a CDN subdomain belongs to it, another company's host and an address by number do not", () => {
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("static.files.example.com"), "example.com");
  assert.equal(registrableDomain("127.0.0.1"), null);
  assert.equal(registrableDomain("localhost"), null);
  assert.ok(sameSite("www.example.com", "cdn.example.com"));
  assert.ok(!sameSite("www.example.com", "example.net"));
  assert.ok(!sameSite("10.0.0.1", "10.0.0.1"), "two addresses by number are never one site");
  // On a host where everyone gets a subdomain, the subdomain is the site.
  assert.ok(!sameSite("alice.github.io", "bob.github.io"));
  assert.ok(sameSite("alice.github.io", "www.alice.github.io"));
  assert.equal(registrableDomain("news.example.com.br"), "example.com.br");
});

test("addresses that differ in their query are different feeds; tracking parameters don't make a second one", () => {
  const found = namedAddresses([`"/feed?category=news"`, `"/feed?category=sports"`, `"/feed?category=news&utm_source=x"`], "https://www.example.org/news");
  assert.deepEqual(found.feeds.map((f) => new URL(f.url).searchParams.get("category")).sort(), ["news", "sports"]);
});

test("only the page's own site's scripts are read, a CDN subdomain of it included, the ones that look like the page's code first", () => {
  const html = `<html><head>
    <script src="/_next/static/chunks/framework-aaaa.js"></script>
    <script src="https://static.government.nl/assets/news-page.js"></script>
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script>
    <script src="https://cdn.other-company.example/lib.js"></script>
    <script src="//www.government.nl/_next/static/chunks/latest-1234.js?v=1&amp;x=2#frag"></script>
    <script async src="/plain.js"></script>
    <link rel="modulepreload" href="/_next/static/chunks/app-main.js">
    <link rel="preload" as="script" href="https://static.government.nl/preloaded.js">
    <link rel="preload" as="style" href="/style.css">
    <script src="javascript:alert(1)"></script>
    <script>inline()</script></head></html>`;
  const files = scriptFiles(html, PAGE);
  assert.ok(files.every((f) => sameSite(new URL(f).hostname, "www.government.nl")), files.join("\n"));
  assert.ok(!files.some((f) => /googletagmanager|other-company|style\.css|javascript:/.test(f)));
  assert.ok(files.includes("https://static.government.nl/preloaded.js") && files.includes("https://www.government.nl/_next/static/chunks/app-main.js"));
  assert.equal(files.filter((f) => f.includes("latest-1234")).length, 1);
  assert.ok(files.includes("https://www.government.nl/_next/static/chunks/latest-1234.js?v=1&x=2"), "entities undone, the fragment dropped");
  assert.ok(files.indexOf("https://www.government.nl/_next/static/chunks/latest-1234.js?v=1&x=2") < files.indexOf("https://www.government.nl/_next/static/chunks/framework-aaaa.js"), "a file named like the page before a library");
  assert.deepEqual(scriptFiles(`<html></html>`, PAGE), []);
});

test("the inline scripts are read from the page in hand, JSON-LD and data included, bounded", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "BreadcrumbList", url: "https://www.government.nl/latest" })}</script><script>const a = 1;</script><script src="/x.js">${"x".repeat(100)}</script><script>${"var big = '/latest/news-a';".repeat(80_000)}</script><script>${"y".repeat(900_000)}</script><script>${"z".repeat(900_000)}</script>`;
  const texts = inlineScripts(html);
  assert.ok(texts[0]!.includes("BreadcrumbList"));
  assert.ok(texts.every((t) => t.length > 40 && t.length <= 600_000), "each bounded, none a file's body or tiny");
  assert.ok(texts.reduce((n, t) => n + t.length, 0) <= 1_500_000, "and bounded in all");
});

test("a feed address a script writes out is found, in the plain and the JSON-escaped way, and the page itself and its language version are not siblings", () => {
  const rotterdam = "https://www.rotterdam.nl/nieuws";
  const found = namedAddresses([`const f="/feed/rss/nieuws/";`, `{"u":"https:\\/\\/www.rotterdam.nl\\/feed\\/rss\\/algemeen\\/"}`, `const p="/nieuws", q="/nieuwsoverzicht", img="/_next/image", t="/api/deepl/translate"`], rotterdam);
  assert.deepEqual(urls(found.feeds), ["https://www.rotterdam.nl/feed/rss/nieuws/", "https://www.rotterdam.nl/feed/rss/algemeen/"]);
  assert.ok(!urls(found.pages).includes("https://www.rotterdam.nl/nieuws"), "not the page itself");
  assert.deepEqual(urls(found.pages), ["https://www.rotterdam.nl/nieuwsoverzicht"], "not an interface, a file or an image route either");

  const nato = namedAddresses([`"/fr/news-and-events/articles/news"`, `"/en/news-and-events/articles"`, `"/"`, `"/en"`], "https://www.nato.int/en/news-and-events/articles/news");
  assert.deepEqual(urls(nato.pages), ["https://www.nato.int/en/news-and-events/articles"], "the page's French version and the front page are no siblings");
});

test("a page of the same site named in a script is a sibling; another site's page, an interface, a file and a fragment of the page are not", () => {
  const text = `
    "url":"https://www.government.nl/latest/news#webpage","url":"https://www.government.nl/latest","u":"https://www.government.nl/latest#breadcrumb",
    "https://analytics.example.net/latest/news","https://www.government.nl/documents/reports","https://www.government.nl/api/search","https://www.government.nl/data/list.json",
    "/assets/logo.png","/sitemap.xml","https://www.youtube.com/latest","https://www.government.nl/_next/data/abc/latest.json","https://www.government.nl/static/latest"`;
  const found = namedAddresses([text], PAGE);
  assert.deepEqual(urls(found.pages), ["https://www.government.nl/latest"], "the page's own words; a page about something else (documents) is not a sibling");
  assert.deepEqual(found.feeds, []);
  // A script on a CDN subdomain names the same address as one on the site: the same page.
  assert.equal(urls(namedAddresses([`"//cdn.government.nl/latest"`], PAGE).pages).length, 1, "a CDN subdomain of the site is the site");
});

test("a sibling is about what the page is about: its address shares a word with the page's, a whole word or the start of a longer one, never a word that merely contains it", () => {
  const pages = (page: string, ...paths: string[]) => urls(namedAddresses([paths.map((p) => `"${p}"`).join(",")], page).pages).map((u) => new URL(u).pathname);
  assert.deepEqual(pages("https://www.example.net/en/publications", "/en/search-publications", "/en/all-news", "/en/about-us"), ["/en/search-publications"]);
  assert.deepEqual(pages("https://www.example.net/news", "/newsroom/latest", "/news-archive", "/knews", "/blog"), ["/newsroom/latest", "/news-archive"], "newsroom and news-archive begin with news; knews only contains it");
  assert.deepEqual(pages("https://www.example.net/en/search", "/en/research", "/en/search/advanced"), ["/en/search/advanced"], "research only contains search");
  assert.deepEqual(pages("https://www.cdc.gov/media/releases/index.html", "/media/index.html", "/other/index.html", "/other/home.html"), ["/media/index.html"], "index and html say nothing about a page");
  assert.deepEqual(pages("https://www.example.net/", "/news", "/blog"), [], "a page whose own address has no word says nothing to match");
  assert.deepEqual(pages("https://www.example.net/faq", "/faq-list", "/news"), [], "three letters are no word");
});

test("a feed another host serves is found when the scripts name it, but a page of another host is no sibling", () => {
  const found = namedAddresses([`"https://feeds.example.net/site/rss.xml"`, `"https://other.example.net/news"`, `"https://www.government.nl/latest"`], PAGE);
  assert.deepEqual(urls(found.feeds), ["https://feeds.example.net/site/rss.xml"]);
  assert.deepEqual(urls(found.pages), ["https://www.government.nl/latest"]);
});

test("a feed route built on an API root the scripts name is found, and only feed routes are: no JSON interface is", () => {
  // The European Commission's press corner: its script builds `${base}rss?language=…` and writes the API's root elsewhere.
  const press = "https://ec.europa.eu/commission/presscorner/home/en";
  const script = `class S{constructor(){this.prdfocoreservicesUrl=e.root+"/"}} const root="/commission/presscorner/api";
    rss(t,o="en"){return \`\${this.prdfocoreservicesUrl}rss?language=\${o}\`+this.generateUrlParam(t)} search(t){return \`\${this.prdfocoreservicesUrl}search?x=\${t}\`} docs(){return \`\${this.prdfocoreservicesUrl}documents\`}`;
  const found = namedAddresses([script], press);
  assert.deepEqual(urls(found.feeds), ["https://ec.europa.eu/commission/presscorner/api/rss"]);
  assert.ok(!urls(found.pages).some((u) => /search|documents/.test(u)), urls(found.pages).join("\n"));
  // Without a root written out there is nothing to build on.
  assert.deepEqual(namedAddresses([`rss(){return \`\${this.apiUrl}rss?x=1\`}`], press).feeds, []);
  // A base that isn't named like one is not taken for one.
  assert.deepEqual(namedAddresses([`const root="/commission/presscorner/api"; f(){return \`\${count}rss\`}`], press).feeds, []);
});

test("an address that carries a key is never named: a parameter called one, whatever its value, a credential, a secret in the path", () => {
  const keyed = [
    "https://www.sample.net/news/feed?key=abc", "https://www.sample.net/news/feed?token=x", "https://www.sample.net/news/feed?hash=1", "https://www.sample.net/news/feed?sha256=0f",
    "https://www.sample.net/news/feed?client_id=app", "https://www.sample.net/news/feed?signature=zz", "https://www.sample.net/news/feed?api_key=1", "https://www.sample.net/news/feed?accessToken=z",
    "https://www.sample.net/news/feed?sig=1", "https://www.sample.net/news/feed?secret=1", "https://www.sample.net/archive?page=2&clientId=x",
    "https://www.sample.net/private/feeds/a8f3c91d2e7b4f6a9c0d1e2f3a4b5c6d/rss",
  ];
  for (const u of keyed) {
    assert.ok(carriesAKey(new URL(u)), u);
    const found = namedAddresses([`"${u}"`], "https://www.sample.net/news");
    assert.deepEqual([...found.feeds, ...found.pages], [], u);
  }
  for (const u of ["https://www.sample.net/news/feed?language=en", "https://www.sample.net/archive?page=2&sort=date", "https://www.sample.net/news/feed?keywords=garden"]) {
    assert.ok(!carriesAKey(new URL(u)), u);
  }
  assert.deepEqual(urls(namedAddresses([`"https://www.sample.net/news/feed?language=en"`], "https://www.sample.net/blog").feeds), ["https://www.sample.net/news/feed?language=en"]);
});

test("the usual feed addresses that discovery asked for already are not asked for again, and noise is not an address", () => {
  const found = namedAddresses([`"/feed","/rss","/feed.xml","/blog/feed","/news/feed/","https://example.org/","http://www.w3.org/2000/svg","/locales/en/rss.json","/a.js","/img/logo.svg"`], "https://example.org/news");
  assert.deepEqual(urls(found.feeds), ["https://example.org/news/feed/"], "only the one that was not a usual address");
  assert.deepEqual(found.pages, []);
});

test("a script that is nothing but noise or minified code names nothing, in no time", () => {
  const code = "function a(b){return b?b.c:{d:[1,2,3],e:\"x\"}}".repeat(60_000);
  const started = Date.now();
  assert.deepEqual(namedAddresses([code, "", "\\u002f\\u002f//////////////////"], PAGE), { feeds: [], pages: [] });
  assert.ok(Date.now() - started < 3000, "linear in the text");
});

test("an address is shown as a reader would say it", () => {
  assert.equal(readableAddress("https://www.government.nl/latest/"), "government.nl/latest");
  assert.equal(readableAddress("https://news.example/list?page=2"), "news.example/list?page=2");
  assert.equal(readableAddress("not an address"), "not an address");
});
