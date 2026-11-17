import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeService, parseBridgeDescriptor } from "./bridges.ts";
import { crossrefWorksToRss, crossrefWorksUrl, findCrossrefJournal, issnFromInput, issnFromPortalUrl, issnPortalUrl } from "./crossref.ts";
import { CROSSREF_NOTE, CROSSREF_VIA, discover } from "./discover.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./discover.ts";
import { parseFeed } from "./feed.ts";
import { DUKE_MESSAGE } from "./journals.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeResponse } from "./testing.ts";

const NOW = () => new Date("2026-11-17T12:00:00Z");

/** Crossref's answer for a journal's works, shaped like the live API's (`message.items`). */
function works(items: Record<string, unknown>[], journal = "New Directions for Child and Adolescent Development") {
  return { status: "ok", message: { items: items.map((i) => ({ "container-title": [journal], type: "journal-article", ...i })) } };
}

const ARTICLE = {
  DOI: "10.1155/cad/8705978",
  title: ["The Effects of Working Memory Updating on <i>Chinese</i> Reading Comprehension"],
  subtitle: ["A Longitudinal Study"],
  author: [{ given: "Li", family: "Wang" }, { given: "Mei", family: "Chen" }, { name: "Child Study Group" }],
  abstract: "<jats:title>Abstract</jats:title><jats:p>Working memory &amp; reading.</jats:p><jats:p>Second <jats:italic>paragraph</jats:italic>.</jats:p>",
  created: { "date-time": "2026-05-22T09:14:00Z" },
  "published-online": { "date-parts": [[2026, 5, 21]] },
};

test("Crossref's works become RSS: plain titles with subtitles, authors, abstracts as paragraphs, the DOI as link and id", () => {
  const parsed = parseFeed(Buffer.from(crossrefWorksToRss(works([ARTICLE]), "15348687")), "application/rss+xml");
  assert.equal(parsed.title, "New Directions for Child and Adolescent Development");
  const [item] = parsed.items;
  assert.equal(item!.title, "The Effects of Working Memory Updating on Chinese Reading Comprehension: A Longitudinal Study");
  assert.equal(item!.url, "https://doi.org/10.1155/cad/8705978");
  assert.equal(item!.guid, "doi:10.1155/cad/8705978");
  assert.equal(item!.author, "Li Wang, Mei Chen, Child Study Group");
  assert.equal(item!.publishedAt, "2026-05-21T00:00:00.000Z", "the online publication day");
  assert.equal(item!.summaryHtml, "<p>Working memory &amp; reading.</p><p>Second paragraph .</p>");
});

test("Crossref entries that aren't articles, the journal's front matter and records without a DOI are left out", () => {
  const rss = crossrefWorksToRss(works([
    { ...ARTICLE, DOI: "10.1155/cad/1", title: ["Issue Information"] },
    { ...ARTICLE, DOI: "10.1155/cad/2", title: ["Cover Image"] },
    { ...ARTICLE, DOI: "10.1155/cad/3", type: "journal-issue", title: ["Volume 2026"] },
    { ...ARTICLE, DOI: undefined },
    { ...ARTICLE, DOI: "10.1155/cad/4", title: ["Issue information: a study of how journals label their issues"] },
    { ...ARTICLE, DOI: "10.1155/cad/5", title: ["Masthead"] },
    { ...ARTICLE, DOI: "10.1155/cad/6", title: ["Cover images in children's books"] },
  ]), "15348687");
  const titles = parseFeed(Buffer.from(rss), "application/rss+xml").items.map((i) => i.url);
  assert.deepEqual(titles, ["https://doi.org/10.1155/cad/6"], "only the article whose title merely starts like front matter's");
});

test("a Crossref record without an online day is dated by its registration; one without authors or abstract has neither", () => {
  const rss = crossrefWorksToRss(works([{ DOI: "10.1155/cad/7", title: ["Plain"], created: { "date-time": "2026-11-05T08:30:00Z" }, "published-online": { "date-parts": [[2026, 11]] } }]), "15348687");
  const [item] = parseFeed(Buffer.from(rss), "application/rss+xml").items;
  assert.equal(item!.publishedAt, "2026-11-05T08:30:00.000Z");
  assert.equal(item!.author, null);
  assert.equal(item!.summaryHtml, null);
});

test("an ISSN with no works is named by its ISSN; an answer that isn't a list of works is an error, never an empty feed", () => {
  assert.equal(parseFeed(Buffer.from(crossrefWorksToRss({ message: { items: [] } }, "15348687")), "application/rss+xml").title, "ISSN 1534-8687");
  assert.throws(() => crossrefWorksToRss({ message: { error: "x" } }, "15348687"));
  assert.equal(crossrefWorksUrl("15348687"), "https://api.crossref.org/journals/1534-8687/works?sort=created&order=desc&rows=40&select=DOI,title,subtitle,author,abstract,created,published-online,type,container-title");
});

test("a DOI with reserved characters keeps one address and one id through RSS and the service's post rule", () => {
  const crossref = bridgeService("crossref")!;
  for (const doi of ["10.1002/(SICI)1097-4679(199711)53:7<657::AID-JCLP3>3.0.CO;2-#", "10.1000/a%2Fb", "10.1000/x?y=1"]) {
    const [item] = parseFeed(Buffer.from(crossrefWorksToRss(works([{ ...ARTICLE, DOI: doi }]), "15348687")), "application/rss+xml").items;
    assert.equal(item!.guid, `doi:${doi.toLowerCase()}`, doi);
    const link = new URL(item!.url!);
    assert.equal(link.hash, "", `${doi}: nothing of the DOI ends up in a fragment`);
    assert.equal(crossref.postId("15348687", link), `doi:${doi.toLowerCase()}`, doi);
  }
  assert.equal(crossref.postId("15348687", new URL("https://example.org/10.1155/cad/1")), null);
  assert.equal(crossref.postId("15348687", new URL("https://doi.org/not-a-doi")), null);
});

test("Crossref sources: the ISSN without its hyphen is the key, the ISSN portal page is the site, and its address names the source again", () => {
  assert.equal(parseBridgeDescriptor("bridge:crossref/15348687")?.key, "15348687");
  assert.equal(parseBridgeDescriptor("bridge:crossref/0000000X")?.key, "0000000X");
  for (const bad of ["bridge:crossref/1534-8687", "bridge:crossref/0000000x", "bridge:crossref/1534868", "bridge:crossref/doi"]) assert.equal(parseBridgeDescriptor(bad), null, bad);
  assert.equal(issnPortalUrl("15348687"), "https://portal.issn.org/resource/ISSN/1534-8687");
  assert.equal(issnFromPortalUrl(new URL("https://portal.issn.org/resource/ISSN/1534-8687")), "15348687");
  assert.equal(issnFromPortalUrl(new URL("https://portal.issn.org/resource/ISSN/1534-8688")), null, "a wrong check digit");
  assert.equal(issnFromPortalUrl(new URL("https://example.org/resource/ISSN/1534-8687")), null);
});

test("a pasted ISSN: with its hyphen or after the word ISSN; eight digits alone are a number", () => {
  assert.equal(issnFromInput("1534-8687"), "15348687");
  assert.equal(issnFromInput(" ISSN 1534-8687 "), "15348687");
  assert.equal(issnFromInput("eISSN: 15348687"), "15348687");
  assert.equal(issnFromInput("15348687"), null);
  assert.equal(issnFromInput("1534-8688"), null, "a wrong check digit");
});

test("a journal by name: one exact title (from the platform's publisher when given), listed once or more under the same ISSNs", () => {
  const item = (title: string, publisher: string, issns: string[]) => ({ title, publisher, ISSN: issns, "issn-type": [{ type: "electronic", value: issns[1] }, { type: "print", value: issns[0] }] });
  const data = { message: { items: [item("Public Culture", "Duke University Press", ["0899-2363", "1527-8018"]), item("Public Culture", "Duke University Press", ["0899-2363", "1527-8018"]), item("Media culture and public relations", "X", ["1333-6371", "1848-8374"])] } };
  assert.deepEqual(findCrossrefJournal(data, "public culture", /duke/i)?.issns, ["15278018", "08992363"]);
  assert.equal(findCrossrefJournal(data, "Public Culture", /wiley/i), null, "another publisher's");
  assert.equal(findCrossrefJournal(data, "Culture"), null, "not exactly the title");
  const two = { message: { items: [item("Oceania", "Wiley", ["0029-8077", "1834-4461"]), item("Oceania", "Other", ["1111-1119", "2049-3630"])] } };
  assert.equal(findCrossrefJournal(two, "Oceania"), null, "two journals of that name");
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
const forbidden = (url: string) => fakeResponse(url, "<html><body>Just a moment…</body></html>", "text/html", 403);
function rss(title: string, link: string): string {
  const items = [1, 2, 3].map((i) => `<item><title>Article ${i}</title><link>${link}a${i}</link><guid>${link}a${i}</guid><pubDate>Mon, 0${i} Nov 2026 10:00:00 GMT</pubDate></item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>x</description>${items}</channel></rss>`;
}
const feed = (url: string, title: string) => fakeResponse(url, rss(title, `${url}/`), "application/rss+xml");

/** A bridge router that answers Crossref sources with the journal's works converted, and records what it was asked. */
function crossrefRouter(byIssn: Record<string, string>): { bridge: BridgeClient; asked: string[] } {
  const asked: string[] = [];
  const bridge: BridgeClient = async (t) => {
    asked.push(`${t.service.id}/${t.key}`);
    const journal = byIssn[t.key];
    if (t.service.id !== "crossref" || !journal) return { status: 404, body: Buffer.from("Not found.\n") };
    return { status: 200, body: Buffer.from(crossrefWorksToRss(works([ARTICLE], journal), t.key)) };
  };
  return { bridge, asked };
}

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

const NDCAD_SEARCH = "https://api.crossref.org/journals?query=New%20Directions%20for%20Child%20and%20Adolescent%20Development&rows=10";
const NDCAD = { title: "New Directions for Child and Adolescent Development", publisher: "Hindawi Limited", ISSN: ["1520-3247", "1534-8687"], "issn-type": [{ type: "print", value: "1520-3247" }, { type: "electronic", value: "1534-8687" }] };
const SWITCHED_OFF = `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" version="2.0"><channel><title>Wiley: New Directions for Child and Adolescent Development: Table of Contents</title><link>https://onlinelibrary.wiley.com/journal/cad?af=R</link><description>There is no RSS feed available for this content series: cad</description><prism:publicationName>New Directions for Child and Adolescent Development</prism:publicationName></channel></rss>`;

test("a Wiley journal whose feed is switched off: its Crossref feed is the choice, found by the name its empty feed still gives", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/cad";
  const wileyFeed = "https://onlinelibrary.wiley.com/feed/cad/most-recent";
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [wileyFeed]: fakeResponse(wileyFeed, SWITCHED_OFF, "application/xml;charset=UTF-8", 404),
    [NDCAD_SEARCH]: json(NDCAD_SEARCH, { message: { items: [NDCAD] } }),
  });
  const { bridge, asked } = crossrefRouter({ "15348687": NDCAD.title });
  const d = ok(await discover(pageUrl, { fetch, bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.origin, c.via, c.matchesPage, c.alternative]), [[NDCAD.title, "bridge:crossref/15348687", "Crossref", CROSSREF_VIA, true, undefined]]);
  assert.equal(d.candidates[0]!.note, CROSSREF_NOTE);
  assert.equal(d.candidates[0]!.siteUrl, "https://portal.issn.org/resource/ISSN/1534-8687");
  assert.deepEqual(asked, ["crossref/15348687"], "the electronic ISSN");
  // Without the bridge (or where it doesn't serve Crossref) the answer is what it was.
  assert.ok(!(await discover(pageUrl, { fetch, now: NOW })).ok);
  assert.ok(!(await discover(pageUrl, { fetch, bridge, bridgeServes: (s) => s.id !== "crossref", now: NOW })).ok);
});

test("a Wiley journal with a working feed: the publisher's feed first, Crossref after it as an alternative", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/18344461";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/18344461/most-recent";
  const { fetch } = stub({ [pageUrl]: forbidden(pageUrl), [feedUrl]: feed(feedUrl, "Wiley: Oceania: Table of Contents") });
  const { bridge, asked } = crossrefRouter({ "18344461": "Oceania" });
  const d = ok(await discover(pageUrl, { fetch, bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.alternative]), [["Oceania", feedUrl, undefined], ["Oceania", "bridge:crossref/18344461", true]]);
  assert.deepEqual(asked, ["crossref/18344461"], "the ISSN in the address, without asking Crossref's search");
});

test("a journal whose feed carries the same DOI links as Crossref keeps both choices", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/18344461";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/18344461/most-recent";
  const sameLinks = `<?xml version="1.0"?><rss version="2.0"><channel><title>Wiley: Oceania: Table of Contents</title><link>x</link><description>x</description><item><title>A</title><link>https://doi.org/10.1155/cad/8705978</link></item></channel></rss>`;
  const { fetch } = stub({ [pageUrl]: forbidden(pageUrl), [feedUrl]: fakeResponse(feedUrl, sameLinks, "application/rss+xml") });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "18344461": "Oceania" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), [feedUrl, "bridge:crossref/18344461"]);
});

test("a Taylor & Francis journal: Crossref found by the journal's name with Taylor & Francis as its publisher", async () => {
  const pageUrl = "https://www.tandfonline.com/journals/rhum20";
  const feedUrl = "https://www.tandfonline.com/feed/rss/rhum20";
  const search = "https://api.crossref.org/journals?query=Human%20Organization&rows=10";
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [feedUrl]: feed(feedUrl, "tandf: Human Organization: Table of Contents"),
    [search]: json(search, { message: { items: [{ title: "Human Organization", publisher: "Informa UK (Taylor & Francis)", ISSN: ["0018-7259", "1938-3525"], "issn-type": [{ type: "print", value: "0018-7259" }, { type: "electronic", value: "1938-3525" }] }] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "19383525": "Human Organization" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.alternative]), [[feedUrl, undefined], ["bridge:crossref/19383525", true]]);
});

test("Duke University Press: its journal through Crossref, found by the address's name; without it, the message as before", async () => {
  const pageUrl = "https://read.dukeupress.edu/public-culture";
  const search = "https://api.crossref.org/journals?query=public%20culture&rows=10";
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [search]: json(search, { message: { items: [{ title: "Public Culture", publisher: "Duke University Press", ISSN: ["0899-2363", "1527-8018"], "issn-type": [{ type: "print", value: "0899-2363" }, { type: "electronic", value: "1527-8018" }] }] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "15278018": "Public Culture" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.matchesPage]), [["Public Culture", "bridge:crossref/15278018", true]]);
  const missing = "https://read.dukeupress.edu/no-such-journal";
  const unknown = await discover(missing, { fetch: stub({ [missing]: forbidden(missing) }).fetch, bridge: crossrefRouter({}).bridge, now: NOW });
  assert.ok(!unknown.ok && unknown.message === DUKE_MESSAGE);
});

test("a bare DOI: the journal's own feed and its Crossref choice, from the ISSNs Crossref gave", async () => {
  const work = "https://api.crossref.org/works/10.1111%2Faman.70137";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
  const { fetch } = stub({
    [work]: json(work, { message: { publisher: "Wiley", "container-title": ["American Anthropologist"], "issn-type": [{ type: "print", value: "0002-7294" }, { type: "electronic", value: "1548-1433" }] } }),
    [feedUrl]: feed(feedUrl, "Wiley: American Anthropologist: Table of Contents"),
  });
  const d = ok(await discover("10.1111/aman.70137", { fetch, bridge: crossrefRouter({ "15481433": "American Anthropologist" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.alternative]), [[feedUrl, undefined], ["bridge:crossref/15481433", true]]);
});

test("an Open Journal Systems journal without a feed of its own: Crossref by the journal's name", async () => {
  const pageUrl = "https://journal.culanth.org/index.php/ca";
  const html = `<html><head><title>Cultural Anthropology</title><meta name="generator" content="Open Journal Systems 3.3.0.8"></head><body>Journal</body></html>`;
  const search = "https://api.crossref.org/journals?query=Cultural%20Anthropology&rows=10";
  const { fetch } = stub({
    [pageUrl]: fakeResponse(pageUrl, html, "text/html; charset=utf-8"),
    [search]: json(search, { message: { items: [{ title: "Cultural Anthropology", publisher: "American Anthropological Association", ISSN: ["0886-7356", "1548-1360"], "issn-type": [{ type: "print", value: "0886-7356" }, { type: "electronic", value: "1548-1360" }] }] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "15481360": "Cultural Anthropology" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.matchesPage]), [["Cultural Anthropology", "bridge:crossref/15481360", true]]);
  // An ordinary site whose name happens to be a journal's is not looked up.
  const blog = stub({ [pageUrl]: fakeResponse(pageUrl, html.replace(/<meta name="generator"[^>]*>/, ""), "text/html; charset=utf-8"), [search]: json(search, { message: { items: [] } }) });
  assert.ok(!(await discover(pageUrl, { fetch: blog.fetch, bridge: crossrefRouter({ "15481360": "Cultural Anthropology" }).bridge, now: NOW })).ok);
  assert.ok(!blog.calls.includes(search));
});

test("a pasted ISSN: the publisher's ISSN-made feed when there is one, and the Crossref choice", async () => {
  const record = "https://api.crossref.org/journals/1534-8687";
  const wileyFeed = "https://onlinelibrary.wiley.com/feed/15348687/most-recent";
  const { fetch } = stub({
    [record]: json(record, { message: { ...NDCAD, publisher: "Wiley" } }),
    [wileyFeed]: fakeResponse(wileyFeed, SWITCHED_OFF, "application/xml", 404),
  });
  const d = ok(await discover("ISSN 1534-8687", { fetch, bridge: crossrefRouter({ "15348687": NDCAD.title }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.matchesPage]), [["bridge:crossref/15348687", true]]);
  const unknown = await discover("1534-8687", { fetch: stub({}).fetch, bridge: crossrefRouter({}).bridge, now: NOW });
  assert.ok(!unknown.ok && unknown.reason === "nofeed");
});

test("Crossref not answering just now leaves the result as it was; the ISSN portal address and the descriptor name the Crossref source", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/18344461";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/18344461/most-recent";
  const { fetch } = stub({ [pageUrl]: forbidden(pageUrl), [feedUrl]: feed(feedUrl, "Wiley: Oceania: Table of Contents") });
  const down: BridgeClient = async () => ({ status: 503, body: Buffer.from("x") });
  assert.deepEqual(ok(await discover(pageUrl, { fetch, bridge: down, now: NOW })).candidates.map((c) => c.feedUrl), [feedUrl]);
  const { bridge } = crossrefRouter({ "18344461": "Oceania" });
  for (const input of ["https://portal.issn.org/resource/ISSN/1834-4461", "bridge:crossref/18344461"]) {
    const d = ok(await discover(input, { fetch: stub({}).fetch, bridge, now: NOW }));
    assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.via, c.note]), [["Oceania", "bridge:crossref/18344461", CROSSREF_VIA, CROSSREF_NOTE]], input);
  }
});

test("an installation without RSS-Bridge offers Crossref but not RSS-Bridge's services", async () => {
  const bridge: BridgeClient = async () => ({ status: 200, body: Buffer.from(rss("x", "https://t.me/durov/")) });
  const noRssBridge = { bridge, bridgeServes: (s: { backend: { kind: string } }) => s.backend.kind === "crossref", now: NOW, fetch: stub({}).fetch };
  const t = await discover("https://t.me/durov", noRssBridge);
  assert.ok(!t.ok || !t.candidates.some((c) => c.feedUrl.startsWith("bridge:")), "Telegram isn't offered through the bridge");
  const described = await discover("bridge:telegram/durov", noRssBridge);
  assert.ok(!described.ok && described.reason === "unsupported");
});

test("a Wiley journal named by a code whose feed works: that feed first, Crossref after it", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/aman";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/aman/most-recent";
  const search = "https://api.crossref.org/journals?query=American%20Anthropologist&rows=10";
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [feedUrl]: feed(feedUrl, "Wiley: American Anthropologist: Table of Contents"),
    [search]: json(search, { message: { items: [{ title: "American Anthropologist", publisher: "Wiley", ISSN: ["0002-7294", "1548-1433"], "issn-type": [{ type: "print", value: "0002-7294" }, { type: "electronic", value: "1548-1433" }] }] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "15481433": "American Anthropologist" }).bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.feedUrl, c.alternative]), [[feedUrl, undefined], ["bridge:crossref/15481433", true]]);
});

test("a journal with announcements but no articles feed of its own: Crossref first and chosen, the announcements after it", async () => {
  const pageUrl = "https://journal.example.org/index.php/jx";
  const ojsFeed = "https://journal.example.org/index.php/jx/gateway/plugin/WebFeedGatewayPlugin/rss2";
  const news = "https://journal.example.org/index.php/jx/gateway/plugin/AnnouncementFeedGatewayPlugin/atom";
  const html = `<html><head><title>Journal X</title><meta name="generator" content="Open Journal Systems 3.4"><link rel="alternate" type="application/rss+xml" href="${ojsFeed}"></head><body>x</body></html>`;
  const search = "https://api.crossref.org/journals?query=Journal%20X&rows=10";
  const { fetch } = stub({
    [pageUrl]: fakeResponse(pageUrl, html, "text/html; charset=utf-8"),
    [news]: fakeResponse(news, `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Journal X</title><entry><title>Call for papers</title><id>n1</id><link href="${news}/n1"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>`, "application/atom+xml"),
    [search]: json(search, { message: { items: [{ title: "Journal X", publisher: "Society", ISSN: ["1234-5679"], "issn-type": [{ type: "electronic", value: "1234-5679" }] }] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, bridge: crossrefRouter({ "12345679": "Journal X" }).bridge, now: NOW }));
  assert.equal(d.candidates[0]!.feedUrl, "bridge:crossref/12345679");
  assert.equal(d.candidates[0]!.matchesPage, true);
  assert.ok(d.candidates.some((c) => c.feedUrl === news), "the announcements are still offered");
});

test("an Elsevier DOI: ScienceDirect's feed takes the print ISSN, Crossref the electronic one", async () => {
  const work = "https://api.crossref.org/works/10.1016%2Fj.neuropsychologia.2026.1";
  const sdFeed = "https://rss.sciencedirect.com/publication/science/00283932";
  const { fetch } = stub({
    [work]: json(work, { message: { publisher: "Elsevier BV", "container-title": ["Neuropsychologia"], "issn-type": [{ type: "print", value: "0028-3932" }, { type: "electronic", value: "1873-3514" }] } }),
    [sdFeed]: feed(sdFeed, "ScienceDirect Publication: Neuropsychologia"),
  });
  const { bridge, asked } = crossrefRouter({ "18733514": "Neuropsychologia" });
  const d = ok(await discover("10.1016/j.neuropsychologia.2026.1", { fetch, bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), [sdFeed, "bridge:crossref/18733514"]);
  assert.deepEqual(asked, ["crossref/18733514"]);
});
