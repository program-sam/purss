import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/translations/server";
import { crossrefWorksToRss } from "./crossref.ts";
import { discover, WIKIDATA_NOTE } from "./discover.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./discover.ts";
import { WHOLE_SITE_NOTE } from "./feed-choice.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeFailure, fakeResponse } from "./testing.ts";
import { addressVariants, readWikidataEntities, readWikidataSearch, wikidataEntitiesUrl, wikidataSearchUrl } from "./wikidata.ts";

const copy = server.sources.connectors;

const NOW = () => new Date("2026-11-18T12:00:00Z");

test("an address's spellings for Wikidata: both schemes, with and without www, with and without the trailing slash, never a query", () => {
  assert.deepEqual(addressVariants(new URL("https://www.deutschlandfunk.de/?utm=x#top")), [
    "https://www.deutschlandfunk.de", "https://www.deutschlandfunk.de/", "https://deutschlandfunk.de", "https://deutschlandfunk.de/",
    "http://www.deutschlandfunk.de", "http://www.deutschlandfunk.de/", "http://deutschlandfunk.de", "http://deutschlandfunk.de/",
  ]);
  assert.deepEqual(addressVariants(new URL("https://journals.sagepub.com/home/eth/")).slice(0, 4), [
    "https://journals.sagepub.com/home/eth", "https://journals.sagepub.com/home/eth/", "https://www.journals.sagepub.com/home/eth", "https://www.journals.sagepub.com/home/eth/",
  ]);
});

test("Wikidata's answers: one exact statement search for all spellings, then the items' websites, feeds and ISSNs without deprecated ones", () => {
  const url = wikidataSearchUrl(["https://a.example/", "http://a.example/", 'https://bad.example/"x'])!;
  assert.equal(new URL(url).searchParams.get("srsearch"), "haswbstatement:P856=https://a.example/|P856=http://a.example/", "a spelling the search syntax can't hold is left out");
  assert.equal(wikidataSearchUrl([]), null);
  assert.deepEqual(readWikidataSearch({ query: { search: [{ title: "Q1" }, { title: "Property:P1" }, { title: "Q2" }] } }), ["Q1", "Q2"]);
  assert.match(wikidataEntitiesUrl(["Q1", "Q2"]), /action=wbgetentities.*ids=Q1\|Q2$/);
  const claim = (value: string, rank = "normal") => ({ rank, mainsnak: { datavalue: { value } } });
  assert.deepEqual(readWikidataEntities({ entities: { Q1: { claims: {
    P856: [claim("https://a.example/")],
    P1019: [claim("https://a.example/feed"), claim("https://a.example/old.rss", "deprecated"), claim("ftp://a.example/x")],
    P236: [claim("1466-1381")],
  } } } }), [{ id: "Q1", websites: ["https://a.example/"], feeds: ["https://a.example/feed"], issns: ["1466-1381"] }]);
});

// ---------- discovery ----------

type Route = SafeFetchResult | ((url: string) => SafeFetchResult);

function stub(routes: Record<string, Route>): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(url) : route;
  };
  return { fetch, calls };
}

const json = (url: string, data: unknown) => fakeResponse(url, JSON.stringify(data), "application/json");
const page = (url: string) => fakeResponse(url, "<html><head><title>A site</title></head><body>No feed here</body></html>", "text/html; charset=utf-8");
function rss(title: string, link: string): string {
  const items = [1, 2, 3].map((i) => `<item><title>Story ${i}</title><link>${link}s${i}</link><guid>${link}s${i}</guid><pubDate>Mon, 0${i} Nov 2026 10:00:00 GMT</pubDate></item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>x</description>${items}</channel></rss>`;
}
const feed = (url: string, title: string) => fakeResponse(url, rss(title, `${url}/`), "application/rss+xml");
const claim = (value: string) => ({ rank: "normal", mainsnak: { datavalue: { value } } });

/** Wikidata's two answers for the spellings of `asked` (and its front page): items with these websites, feeds and ISSNs. */
function wikidata(asked: string, items: Record<string, { websites: string[]; feeds?: string[]; issns?: string[] }>): Record<string, Route> {
  const u = new URL(asked);
  const spellings = [...addressVariants(u), ...(u.pathname.replace(/\/+$/, "") ? addressVariants(new URL("/", u)) : [])];
  const search = wikidataSearchUrl(spellings)!;
  const ids = Object.keys(items);
  return {
    [search]: json(search, { query: { search: ids.map((title) => ({ title })) } }),
    [wikidataEntitiesUrl(ids)]: json(wikidataEntitiesUrl(ids), { entities: Object.fromEntries(Object.entries(items).map(([id, i]) => [id, { claims: { P856: i.websites.map(claim), P1019: (i.feeds ?? []).map(claim), P236: (i.issns ?? []).map(claim) } }])) }),
  };
}

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

test("a site that points to no feed: the feeds Wikidata lists for it are offered, saying where they came from; a dead one is left out", async () => {
  const site = "https://www.deutschlandfunk.de/";
  const { fetch } = stub({
    [site]: page(site),
    ...wikidata(site, { Q1: { websites: ["https://www.deutschlandfunk.de/"], feeds: ["https://www.deutschlandfunk.de/nachrichten-100.rss", "https://www.deutschlandfunk.de/dead.rss"] } }),
    "https://www.deutschlandfunk.de/nachrichten-100.rss": feed("https://www.deutschlandfunk.de/nachrichten-100.rss", "Nachrichten"),
  });
  const d = ok(await discover(site, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.note, c.matchesPage]), [["https://www.deutschlandfunk.de/nachrichten-100.rss", WIKIDATA_NOTE, true]]);
});

test("a site whose own addresses used up the lookup's requests still gets Wikidata asked, within a small allowance of its own", async () => {
  const site = "https://essays.example/";
  const { fetch, calls } = stub({
    [site]: page(site),
    ...wikidata(site, { Q1: { websites: [site], feeds: ["https://mirror.example/essays.rss"] } }),
    "https://mirror.example/essays.rss": feed("https://mirror.example/essays.rss", "Essays"),
  });
  // A cap the page and its usual addresses use up before the registry's turn.
  const d = ok(await discover(site, { fetch, now: NOW, maxRequests: 3 }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.note]), [["https://mirror.example/essays.rss", WIKIDATA_NOTE]]);
  assert.ok(calls.filter((u) => !u.startsWith(site)).length <= 4, "the registry's allowance: its search, its items and the feeds it names");
});

test("a section page: the front page's item gives the whole site's feed, labelled so; its ISSNs are not taken for the section", async () => {
  const section = "https://news.example.org/politics";
  const { fetch } = stub({
    [section]: page(section),
    ...wikidata(section, { Q9: { websites: ["https://news.example.org/"], feeds: ["https://news.example.org/all.rss"], issns: ["0261-3077"] } }),
    "https://news.example.org/all.rss": feed("https://news.example.org/all.rss", "Everything"),
  });
  const d = ok(await discover(section, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.via, c.note, c.matchesPage]), [["https://news.example.org/all.rss", copy.labels.wholeSiteFeed, `${WIKIDATA_NOTE} ${WHOLE_SITE_NOTE}`, false]]);
});

test("an item the search found whose website isn't the page's (an index that lags behind an edit) is ignored", async () => {
  const site = "https://a.example.org/";
  const { fetch } = stub({
    [site]: page(site),
    ...wikidata(site, { Q5: { websites: ["https://elsewhere.example.org/"], feeds: ["https://a.example.org/odd/stream-42.rss"] } }),
    "https://a.example.org/odd/stream-42.rss": feed("https://a.example.org/odd/stream-42.rss", "Not this one"),
  });
  assert.ok(!(await discover(site, { fetch, now: NOW })).ok);
});

test("a journal page that refuses automated readers: the ISSN Wikidata gives leads to the journal through Crossref", async () => {
  const pageUrl = "https://journals.sagepub.com/home/eth";
  const { fetch } = stub({
    [pageUrl]: fakeResponse(pageUrl, "<html>Just a moment…</html>", "text/html", 403),
    ...wikidata(pageUrl, { Q15766587: { websites: ["https://journals.sagepub.com/home/eth"], issns: ["1466-1381", "1741-2714"] } }),
  });
  const asked: string[] = [];
  const bridge: BridgeClient = async (t) => {
    asked.push(`${t.service.id}/${t.key}`);
    return { status: 200, body: Buffer.from(crossrefWorksToRss({ message: { items: [{ DOI: "10.1177/1", type: "journal-article", title: ["An article"], "container-title": ["Ethnography"] }] } }, t.key)) };
  };
  const d = ok(await discover(pageUrl, { fetch, bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl]), [["Ethnography", "bridge:crossref/14661381"]]);
  assert.deepEqual(asked, ["crossref/14661381"]);
});

test("Wikidata is asked only as a last resort, never for a private-looking address, and failing or slow it leaves the answer as it was", async () => {
  // Something was found: Wikidata isn't asked.
  const blog = "https://blog.example.org/";
  const found = stub({ [blog]: fakeResponse(blog, `<html><head><link rel="alternate" type="application/rss+xml" href="${blog}feed"></head></html>`, "text/html"), [`${blog}feed`]: feed(`${blog}feed`, "Blog") });
  ok(await discover(blog, { fetch: found.fetch, now: NOW }));
  assert.ok(!found.calls.some((u) => u.startsWith("https://www.wikidata.org/")));
  // A private-looking address is never sent.
  const secret = "https://example.org/private/feeds/a8f3c91d2e7b4f6a9c0d1e2f3a4b5c6d";
  const hidden = stub({ [secret]: page(secret) });
  await discover(secret, { fetch: hidden.fetch, now: NOW });
  assert.ok(!hidden.calls.some((u) => u.startsWith("https://www.wikidata.org/")), "nothing sent for a private-looking address");
  // Wikidata down or timing out: the usual "no feed".
  const site = "https://quiet.example.org/";
  const search = wikidataSearchUrl(addressVariants(new URL(site)))!;
  for (const answer of [fakeResponse(search, "Service Unavailable", "text/plain", 503), fakeFailure("timeout"), json(search, { error: "x" })]) {
    const d = await discover(site, { fetch: stub({ [site]: page(site), [search]: answer }).fetch, now: NOW });
    assert.ok(!d.ok && d.reason === "nofeed", JSON.stringify(d));
  }
});

test("Wikidata is asked after a page turns automated readers away or is broken, and its feeds are offered then", async () => {
  for (const status of [403, 429, 500, 503]) {
    const site = "https://walled.example.org/";
    const { fetch, calls } = stub({
      [site]: fakeResponse(site, "x", "text/html", status),
      ...wikidata(site, { Q7: { websites: ["https://walled.example.org/"], feeds: ["https://walled.example.org/odd/news-7.rss"] } }),
      "https://walled.example.org/odd/news-7.rss": feed("https://walled.example.org/odd/news-7.rss", "News"),
    });
    const d = ok(await discover(site, { fetch, now: NOW }));
    assert.deepEqual(d.candidates.map((c) => c.feedUrl), ["https://walled.example.org/odd/news-7.rss"], String(status));
    assert.equal(calls.filter((u) => u.startsWith("https://www.wikidata.org/")).length, 2, `${status}: one search and one item request`);
  }
});

test("Wikidata's feeds keep to the lookup's limit on choices, and a page address too long to search falls back to its front page", async () => {
  const site = "https://many.example.org/";
  const feeds = [1, 2, 3, 4].map((n) => `https://many.example.org/odd/f${n}.rss`);
  const { fetch } = stub({ [site]: page(site), ...wikidata(site, { Q3: { websites: [site], feeds } }), ...Object.fromEntries(feeds.map((f, n) => [f, feed(f, `Feed ${n}`)])) });
  assert.equal(ok(await discover(site, { fetch, now: NOW, maxCandidates: 1 })).candidates.length, 1);
  const long = `https://long.example.org/${"section/".repeat(25)}page`;
  const spellings = [...addressVariants(new URL(long)), ...addressVariants(new URL("https://long.example.org/"))];
  assert.equal(wikidataSearchUrl(spellings), null, "too long to send");
  const front = wikidataSearchUrl(addressVariants(new URL("https://long.example.org/")))!;
  const s = stub({ [long]: page(long), [front]: json(front, { query: { search: [] } }) });
  await discover(long, { fetch: s.fetch, now: NOW });
  assert.ok(s.calls.includes(front), "the front page is asked about instead");
  assert.ok(s.calls.every((u) => u.length <= 2048));
});

test("Wikidata isn't asked about a page that isn't there, one that wants a password, or an address by number", async () => {
  for (const [url, status] of [["https://gone.example.org/page", 404], ["https://gone.example.org/old", 410], ["https://login.example.org/", 401], ["https://203.0.113.9/", 403]] as const) {
    const s = stub({ [url]: fakeResponse(url, "x", "text/html", status, status === 401 ? { headers: { "www-authenticate": "Basic" } } : {}) });
    await discover(url, { fetch: s.fetch, now: NOW, testAllowAddress: () => true });
    assert.ok(!s.calls.some((u) => u.startsWith("https://www.wikidata.org/")), url);
  }
});

test("on a publishing platform, the front page's item is not the journal's: its feed isn't offered for a journal page", async () => {
  const pageUrl = "https://www.tandfonline.com/journals/zzzz20";
  const { fetch } = stub({
    [pageUrl]: fakeResponse(pageUrl, "x", "text/html", 403),
    ...wikidata(pageUrl, { Q1: { websites: ["https://www.tandfonline.com/"], feeds: ["https://www.tandfonline.com/feed/rss/racl20"] } }),
    "https://www.tandfonline.com/feed/rss/racl20": feed("https://www.tandfonline.com/feed/rss/racl20", "tandf: New Review of Academic Librarianship: Table of Contents"),
  });
  const d = await discover(pageUrl, { fetch, now: NOW });
  assert.ok(!d.ok, JSON.stringify(d));
  // The same for a journal page on a platform whose own pages are read like any site's (PLOS).
  const plos = "https://journals.plos.org/plosnone/";
  const p = stub({
    [plos]: fakeResponse(plos, "x", "text/html", 503),
    ...wikidata(plos, { Q2: { websites: ["https://journals.plos.org/"], feeds: ["https://journals.plos.org/odd/all.rss"] } }),
    "https://journals.plos.org/odd/all.rss": feed("https://journals.plos.org/odd/all.rss", "PLOS"),
  });
  assert.ok(!(await discover(plos, { fetch: p.fetch, now: NOW })).ok);
});
