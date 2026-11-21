import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { decodePageKey, encodePageKey, MAX_PAGE_KEY, needsCharsetRepair, pageBridgeParams, pageHost, pagePostId } from "./page-feeds.ts";
import type { PageSource } from "./page-feeds.ts";
import { detectPageLists, markupDeclaresCharset } from "./page-lists.ts";

const NEWS: PageSource = {
  url: "https://www.anthropic.com/news",
  recipe: { item: "//li[contains(@class, '_row')]", title: ".//h3", link: ".//a/@href", date: ".//time" },
  fixEncoding: false,
};

/** A key made by hand from any document, to show what the reader refuses. */
const forged = (document: unknown): string => deflateRawSync(Buffer.from(typeof document === "string" ? document : JSON.stringify(document)), { level: 9 }).toString("base64url");
const FIELDS = { u: NEWS.url, i: NEWS.recipe.item, t: NEWS.recipe.title, l: NEWS.recipe.link, d: NEWS.recipe.date };

test("a key says the page, the recipe and the character-set repair, and reads back as exactly that", () => {
  const key = encodePageKey(NEWS)!;
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePageKey(key), NEWS);
  const repaired = encodePageKey({ ...NEWS, fixEncoding: true })!;
  assert.deepEqual(decodePageKey(repaired), { ...NEWS, fixEncoding: true });
  assert.notEqual(repaired, key);
  const undated = { ...NEWS, recipe: { item: NEWS.recipe.item, title: NEWS.recipe.title, link: NEWS.recipe.link } };
  assert.deepEqual(decodePageKey(encodePageKey(undated)!), undated);
});

test("the same recipe is always the same key, however it was written down", () => {
  const key = encodePageKey(NEWS)!;
  // Properties in another order, a page address in another spelling of the same address (fragment, default port).
  const shuffled: PageSource = { fixEncoding: false, recipe: { date: ".//time", link: ".//a/@href", title: ".//h3", item: NEWS.recipe.item }, url: "https://www.anthropic.com/news" };
  assert.equal(encodePageKey(shuffled), key);
  assert.equal(encodePageKey({ ...NEWS, url: "https://www.anthropic.com:443/news#top" }), key, "the address is written the way the address parser writes it");
  assert.notEqual(encodePageKey({ ...NEWS, url: "https://www.anthropic.com/research" }), key);
  assert.notEqual(encodePageKey({ ...NEWS, recipe: { ...NEWS.recipe, title: ".//h2" } }), key);
});

test("a key is refused unless it is exactly what the writer makes", () => {
  const key = encodePageKey(NEWS)!;
  const refused = (k: string, why: string) => assert.equal(decodePageKey(k), null, why);
  refused("", "empty");
  refused(key + "A", "something added");
  refused(key.slice(0, -4), "cut short");
  refused(`${key}=`, "padding");
  refused(key.replace(/[-_]/, "+"), "not base64url");
  refused(`${key.slice(0, -1)}${key.at(-1) === "A" ? "B" : "A"}`, "another spelling of nearly the same bytes");
  refused("A".repeat(MAX_PAGE_KEY + 1), "longer than any key");
  refused(forged({ ...FIELDS, x: 1 }), "an extra field");
  refused(forged({ i: FIELDS.i, u: FIELDS.u, t: FIELDS.t, l: FIELDS.l, d: FIELDS.d }), "fields in another order");
  refused(forged(`${JSON.stringify(FIELDS)} `), "whitespace after the document");
  refused(forged(JSON.stringify(FIELDS, null, 1)), "a document written with spaces");
  refused(forged({ ...FIELDS, e: 2 }), "a repair flag that is not 1");
  refused(forged({ ...FIELDS, e: true }), "a repair flag that is not a number");
  refused(forged({ ...FIELDS, e: 0 }), "a repair flag that says no, which the writer leaves out");
  refused(forged({ ...FIELDS, d: 5 }), "a date expression that is not text");
  refused(forged({ ...FIELDS, u: 5 }), "an address that is not text");
  refused(forged([FIELDS]), "a list");
  refused(forged("not json"), "not a document");
  refused(forged("null"), "null");
  refused(deflateRawSync(Buffer.from(`{"u":"https://www.anthropic.com/news"${" ".repeat(1)}`)).toString("base64url"), "unfinished");
  assert.deepEqual(decodePageKey(forged(FIELDS)), NEWS, "the same fields in the writer's form are accepted (they are the writer's own)");
});

test("a key changed anywhere is refused, or is a source the writer could have made; nothing malformed gets through", () => {
  // (A change can land on another well-formed document, a different title expression say, which is just another source: that the key
  // is the one PURSS made is the address' signature's business, and it covers the key as written.)
  let refused = 0;
  let accepted = 0;
  for (const source of [NEWS, { ...NEWS, fixEncoding: true }]) {
    const key = encodePageKey(source)!;
    for (let at = 0; at < key.length; at++) {
      for (const swap of ["A", "B", "-", "_", "0", "z"]) {
        if (key[at] === swap) continue;
        const read = decodePageKey(`${key.slice(0, at)}${swap}${key.slice(at + 1)}`);
        if (!read) { refused++; continue; }
        accepted++;
        const again = encodePageKey(read);
        assert.ok(again, `position ${at} → ${swap}: read as a source the writer would refuse`);
        assert.deepEqual(decodePageKey(again), read);
      }
    }
  }
  assert.ok(refused > accepted, `${refused} refused, ${accepted} read as other sources`);
});

test("a key that inflates to far more than a key ever holds is refused without being inflated whole", () => {
  const bomb = forged(" ".repeat(200_000));
  assert.ok(bomb.length <= MAX_PAGE_KEY, `${bomb.length} characters: short enough to pass the length check, which is the point`);
  assert.equal(decodePageKey(bomb), null);
  const sized = forged(`{"u":"https://www.anthropic.com/${"a".repeat(5000)}"}`);
  assert.ok(sized.length <= MAX_PAGE_KEY && decodePageKey(sized) === null);
});

test("a key holds only an address PURSS may fetch, and only a recipe inside the grammar", () => {
  for (const url of [
    "http://127.0.0.1/news", "http://10.0.0.5/news", "http://[::1]/news", "http://169.254.169.254/latest", "http://localhost/news", "http://intranet.local/news", "http://printer/news",
    "https://user:secret@example.com/news", "ftp://example.com/news", "file:///etc/passwd", "javascript:alert(1)", "not an address", "https://example.com:25/news",
    `https://example.com/${"a".repeat(2100)}`, "https://example.com/private/feeds/a8f3c91d2e7b4f6a9c0d1e2f3a4b5c6d", "https://example.com/feed?token=a8f3c91d2e7b4f6a9c0d1e2f",
    // Written into the key, so a credential-named parameter refuses the address however short its value.
    "https://example.org/news?token=abc", "https://example.org/news?api_key=x1", "https://example.org/news?sig=1", "https://example.org/news?auth=y&page=2", "https://example.org/news?key=x1", "https://example.org/news?code=7f3",
  ]) {
    assert.equal(encodePageKey({ ...NEWS, url }), null, `${url.slice(0, 60)}: not made`);
    assert.equal(decodePageKey(forged({ ...FIELDS, u: url })), null, `${url.slice(0, 60)}: not read`);
  }
  // Ordinary parameters, a paging token among them, are kept.
  for (const url of ["https://example.org/news?page=2", "https://example.org/news?category=tech&nextPageToken=abc", "https://example.org/news?key=sport"]) assert.ok(encodePageKey({ ...NEWS, url }), url);
  // An address that isn't written the way the parser writes it is not the one the writer made.
  assert.equal(decodePageKey(forged({ ...FIELDS, u: "https://www.anthropic.com:443/news#top" })), null);
  assert.equal(decodePageKey(forged({ ...FIELDS, u: "HTTPS://WWW.ANTHROPIC.COM/news" })), null);
  for (const [field, bad] of [
    ["i", "//li[document('http://example.com/x')]"], ["i", "//li[contains(@class, 'x')] | document('http://example.com/x')"], ["i", "//li[@onclick=concat('a','b')]"], ["i", "//li[count(a) > 3]"], ["i", ""],
    ["t", "document('/etc/passwd')"], ["t", ".//a[@href=$x]"], ["t", "../../.."], ["t", ".//a[string-length(.) > 3]"], ["l", "id('x')"], ["l", `.//a/@href${"/x".repeat(100)}`],
    ["d", "system-property('xsl:vendor')"], ["d", ".//time[php:function('exec')]"],
  ] as const) {
    const fields = { ...FIELDS, [field]: bad };
    assert.equal(decodePageKey(forged(fields)), null, `${field}: ${bad.slice(0, 50)}`);
  }
  const recipe = (r: Partial<PageSource["recipe"]>) => ({ ...NEWS, recipe: { ...NEWS.recipe, ...r } });
  assert.equal(encodePageKey(recipe({ item: "//li[document('http://example.com/x')]" })), null);
  assert.equal(encodePageKey(recipe({ link: "" })), null);
  assert.equal(encodePageKey({ ...NEWS, recipe: { item: NEWS.recipe.item, title: NEWS.recipe.title } as never }), null, "a recipe with no link");
});

test("a recipe too long for a key is not made into one", () => {
  const wide = { item: "//div[contains(@class, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]/ul/li/div[contains(@class, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')]/div[@class='cccccccccccccccccccccccccccc']/a", title: ".//h3", link: ".//a/@href" };
  const url = `https://example.com/${Array.from({ length: 40 }, (_, i) => `section${i}x${(i * 7919) % 9973}`).join("/")}`;
  assert.equal(encodePageKey({ url, recipe: wide, fixEncoding: false }), null);
});

test("every list the detector finds on its saved pages fits a key with room to spare", () => {
  const pages: Record<string, string> = {
    "anthropic-news.html": "https://www.anthropic.com/news", "anthropic-research.html": "https://www.anthropic.com/research", "stripe-blog.html": "https://stripe.com/blog",
    "firefox-releases.html": "https://www.firefox.com/en-US/releases/", "paulgraham.html": "https://paulgraham.com/articles.html", "h-tk-kamernieuws.html": "https://www.tweedekamer.nl/nieuws/kamernieuws",
    "nos-nieuws.html": "https://nos.nl/nieuws", "go-release.html": "https://go.dev/doc/devel/release", "hn-front.html": "https://news.ycombinator.com/", "hn-jobs.html": "https://news.ycombinator.com/jobs",
    "melkweg.html": "https://www.melkweg.nl/nl/agenda", "govuk-news.html": "https://www.gov.uk/search/news-and-communications",
  };
  const sizes: number[] = [];
  for (const [file, url] of Object.entries(pages)) {
    const html = readFileSync(new URL(`./fixtures/page-lists/${file}`, import.meta.url), "utf8");
    for (const c of detectPageLists(html, url, new Date("2026-11-21T12:00:00Z")).candidates) {
      if (!c.recipe) continue;
      const fixEncoding = !markupDeclaresCharset(html);
      const key = encodePageKey({ url, recipe: c.recipe, fixEncoding });
      assert.ok(key, `${file} #${c.rank}`);
      assert.deepEqual(decodePageKey(key), { url: new URL(url).href, recipe: c.recipe, fixEncoding }, `${file} #${c.rank}`);
      sizes.push(key.length);
    }
  }
  assert.ok(sizes.length >= 30, `${sizes.length} lists`);
  assert.ok(Math.max(...sizes) <= 0.7 * MAX_PAGE_KEY, `the longest key is ${Math.max(...sizes)} of ${MAX_PAGE_KEY} characters`);
});

test("XPathBridge is asked for the page, the item, its title, link and date, and for the repair only when the page needs it", () => {
  assert.deepEqual(pageBridgeParams(NEWS), { url: "https://www.anthropic.com/news", item: "//li[contains(@class, '_row')]", title: ".//h3", uri: ".//a/@href", timestamp: ".//time" });
  assert.deepEqual(pageBridgeParams({ ...NEWS, fixEncoding: true }), { ...pageBridgeParams(NEWS), fix_encoding: "on" });
  const undated = pageBridgeParams({ ...NEWS, recipe: { item: NEWS.recipe.item, title: NEWS.recipe.title, link: NEWS.recipe.link } });
  assert.ok(!("timestamp" in undated));
  assert.ok(!("content" in undated) && !("author" in undated) && !("enclosures" in undated) && !("categories" in undated), "nothing else XPathBridge reads is asked");
});

test("XPathBridge reads each expression through urldecode once more, so % and + are written to survive it", () => {
  const phpUrldecode = (value: string) => value.replace(/\+/g, " ").replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const expression = "//li[contains(@class, 'a+b%20c%2Bd 100%')]";
  const params = pageBridgeParams({ ...NEWS, recipe: { item: expression, title: ".//a[contains(@class, 'x+y')]", link: ".//a/@href", date: ".//time[@class='t%41']" } });
  // What reaches PHP: the query string is decoded once (into $_GET) and the bridge decodes the value again.
  const query = new URLSearchParams(Object.entries(params));
  const received = new URLSearchParams(query.toString());
  assert.equal(phpUrldecode(received.get("item")!), expression);
  assert.equal(phpUrldecode(received.get("title")!), ".//a[contains(@class, 'x+y')]");
  assert.equal(phpUrldecode(received.get("timestamp")!), ".//time[@class='t%41']");
  assert.equal(phpUrldecode(received.get("uri")!), ".//a/@href");
  // The page's address is not decoded again.
  assert.equal(received.get("url"), NEWS.url);
  // Without the writing it would not survive.
  assert.notEqual(phpUrldecode(new URLSearchParams({ item: expression }).get("item")!), expression);
});

test("a post is known by its canonical address, written as the detector writes it for the samples it shows", () => {
  const id = (link: string, source: PageSource = NEWS) => pagePostId(source, new URL(link));
  assert.equal(id("https://www.anthropic.com/news/ipo-close"), "page:https://anthropic.com/news/ipo-close");
  assert.equal(id("http://anthropic.com/news/ipo-close/?utm_source=x&ref=y#top"), "page:https://anthropic.com/news/ipo-close", "scheme, www, tracking, fragment, trailing slash");
  assert.equal(id("https://example.com/post/index.html"), "page:https://example.com/post");
  assert.equal(id("https://example.com/post?id=7"), "page:https://example.com/post?id=7", "a query that names the post stays");
  for (const link of ["mailto:press@example.com", "javascript:void(0)", "ftp://example.com/x", "tel:+3120", "data:text/html,x"]) assert.equal(id(link), null, link);
  // The same address as the detector's own sample id, for every sample of every list on the saved pages.
  for (const [file, url] of [["anthropic-news.html", "https://www.anthropic.com/news"], ["hn-front.html", "https://news.ycombinator.com/"], ["nos-nieuws.html", "https://nos.nl/nieuws"], ["go-release.html", "https://go.dev/doc/devel/release"]] as const) {
    const html = readFileSync(new URL(`./fixtures/page-lists/${file}`, import.meta.url), "utf8");
    const best = detectPageLists(html, url, new Date("2026-11-21T12:00:00Z")).candidates[0]!;
    const source = { url, recipe: best.recipe!, fixEncoding: false };
    assert.ok(best.samples.length > 0, file);
    for (const sample of best.samples) assert.equal(pagePostId(source, new URL(sample.url)), `page:${sample.id}`, `${file}: ${sample.url}`);
  }
});

test("the entries of a changelog on one page are told apart by their heading, and no other fragment is part of an identity", () => {
  const log: PageSource = { url: "https://go.dev/doc/devel/release", recipe: NEWS.recipe, fixEncoding: false };
  assert.equal(pagePostId(log, new URL("https://go.dev/doc/devel/release#go1.26.0")), "page:https://go.dev/doc/devel/release#go1.26.0");
  assert.equal(pagePostId(log, new URL("https://go.dev/doc/devel/release#go1.25.0")), "page:https://go.dev/doc/devel/release#go1.25.0");
  assert.equal(pagePostId(log, new URL("https://go.dev/doc/devel/release")), "page:https://go.dev/doc/devel/release");
  assert.equal(pagePostId(log, new URL("https://go.dev/doc/go1.26#tools")), "page:https://go.dev/doc/go1.26", "another page's anchor is that page");
  assert.equal(pagePostId(NEWS, new URL("https://www.anthropic.com/news/post#comments")), "page:https://anthropic.com/news/post");
});

test("a source with no name of its own is called by its page's site", () => {
  assert.equal(pageHost(NEWS), "anthropic.com");
  assert.equal(pageHost({ ...NEWS, url: "https://blog.example.org/news" }), "blog.example.org");
});

test("a page needs its character set repaired only when it is UTF-8 with letters outside ASCII", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(needsCharsetRepair(bytes("<p>Café — “quoted”</p>")), true);
  assert.equal(needsCharsetRepair(bytes("<p>Plain ASCII, with &eacute; as an entity</p>")), false, "entities are read right whatever the character set");
  assert.equal(needsCharsetRepair(new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])), false, "Latin-1 bytes are what PHP reads them as");
  assert.equal(needsCharsetRepair(bytes("<p>Café").subarray(0, 8)), true, "a page cut in the middle of a letter is still UTF-8");
  assert.equal(needsCharsetRepair(new Uint8Array()), false);
});
