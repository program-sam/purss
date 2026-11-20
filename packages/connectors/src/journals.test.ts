import assert from "node:assert/strict";
import { test } from "node:test";
import { discover, LINKED_JOURNAL_NOTE, OJS_ANNOUNCEMENTS_NOTE } from "./discover.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./discover.ts";
import { WHOLE_SITE_NOTE } from "./feed-choice.ts";
import { doiFromArticleUrl, doiFromInput, DUKE_MESSAGE, EARLY_NOTE, ISSUES_NOTE, isPublisherHost, journalFromUrl, journalTitle, normalIssn, planJournal, readCrossrefJournalSearch, readCrossrefWork } from "./journals.ts";
import { crossrefJournalSearchUrl } from "./crossref.ts";
import { planKnownFeeds } from "./known-feeds.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeFailure, fakeResponse } from "./testing.ts";

const NOW = () => new Date("2026-11-14T12:00:00Z");
const feedUrls = (u: string): string[] | null => {
  const p = planKnownFeeds(new URL(u));
  return p && "feeds" in p ? p.feeds.map((f) => f.feedUrl) : null;
};
/** The journal's main feed: the first of its plan. */
const mainFeed = (u: string): string[] | null => feedUrls(u)?.slice(0, 1) ?? null;

function rss(title: string, link = "https://journal.example/", numbers = [1, 2, 3]): string {
  const items = numbers.map((i) => `<item><title>Article ${i} of ${title}</title><link>${link}a${i}</link><guid>${link}a${i}</guid><pubDate>Mon, ${String(i).padStart(2, "0")} Nov 2026 10:00:00 GMT</pubDate></item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>x</description>${items}</channel></rss>`;
}

type Route = SafeFetchResult | ((url: string, accept: string | undefined) => SafeFetchResult);

/** A fetcher answering from a table; everything else is a 404 page. Records each address asked for, with its Accept. */
function stub(routes: Record<string, Route>): { fetch: FetchFn; calls: { url: string; accept: string | undefined }[] } {
  const calls: { url: string; accept: string | undefined }[] = [];
  const fetch: FetchFn = async (url, opts) => {
    calls.push({ url, accept: opts?.accept });
    const route = routes[url];
    if (!route) return fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(url, opts?.accept) : route;
  };
  return { fetch, calls };
}

const forbidden = (url: string) => fakeResponse(url, "<html><body>Just a moment…</body></html>", "text/html", 403);
/** A feed whose entries are its own (two journals never share articles). */
const feed = (url: string, title: string) => fakeResponse(url, rss(title, `${url}/`), "application/rss+xml");
const rdfFeed = (url: string, title: string) => fakeResponse(url, `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="${url}"><title>${title}</title><link>${url}</link><description>Table of contents</description></channel><item rdf:about="${url}/article"><title>New article</title><link>${url}/article</link><dc:date>2026-11-19T12:00:00Z</dc:date></item></rdf:RDF>`, "application/xml;charset=UTF-8");
const json = (url: string, data: unknown) => fakeResponse(url, JSON.stringify(data), "application/json");
const page = (url: string, html: string) => fakeResponse(url, html, "text/html; charset=utf-8");

function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}

test("ISSNs: the check digit decides, with or without the hyphen, X as the last digit", () => {
  assert.equal(normalIssn("1548-1433"), "15481433");
  assert.equal(normalIssn("15481433"), "15481433");
  assert.equal(normalIssn("0000-006x"), "0000006X");
  assert.equal(normalIssn("1548-1434"), null, "wrong check digit");
  assert.equal(normalIssn("2026-1114"), null, "a date is not an ISSN");
  assert.equal(normalIssn("1548143"), null);
});

test("journal pages on the publishing platforms become their journal's feed address, without opening the page", () => {
  for (const u of [
    "https://onlinelibrary.wiley.com/journal/17576547",
    "https://onlinelibrary.wiley.com/toc/17576547/2026/37/3",
    "https://onlinelibrary.wiley.com/loi/17576547",
    "https://onlinelibrary.wiley.com/index/17576547",
    "https://onlinelibrary.wiley.com/page/journal/17576547/homepage/productinformation.html",
    "https://onlinelibrary.wiley.com/hub/journal/17576547/about/author-guidelines",
  ]) assert.deepEqual(mainFeed(u), ["https://onlinelibrary.wiley.com/feed/17576547/most-recent"], u);
  assert.deepEqual(mainFeed("https://onlinelibrary.wiley.com/index/cad"), ["https://onlinelibrary.wiley.com/feed/cad/most-recent"], "a journal named by its code");
  // A society's own address on Wiley: the feed lives on the platform's main host.
  assert.deepEqual(mainFeed("https://anthrosource.onlinelibrary.wiley.com/toc/15481433/current"), ["https://onlinelibrary.wiley.com/feed/15481433/most-recent"]);
  assert.deepEqual(mainFeed("https://www.tandfonline.com/journals/rhum20"), ["https://www.tandfonline.com/feed/rss/rhum20"]);
  assert.deepEqual(mainFeed("https://www.tandfonline.com/toc/rhum20/current"), ["https://www.tandfonline.com/feed/rss/rhum20"]);
  assert.deepEqual(mainFeed("https://www.journals.uchicago.edu/journals/ca/about"), ["https://www.journals.uchicago.edu/action/showFeed?type=etoc&feed=rss&jc=ca"]);
  assert.deepEqual(mainFeed("https://www.journals.uchicago.edu/toc/ca/current"), ["https://www.journals.uchicago.edu/action/showFeed?type=etoc&feed=rss&jc=ca"]);
  assert.deepEqual(mainFeed("https://journals.sagepub.com/home/chd"), ["https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd"]);
  assert.deepEqual(mainFeed("https://journals.sagepub.com/home/eth/"), ["https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=eth"]);
  assert.deepEqual(mainFeed("https://journals.sagepub.com/toc/chd/current"), ["https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd"], "an issue page");
  assert.deepEqual(mainFeed("https://journals.sagepub.com/loi/chd"), ["https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd"], "the issue list");
  // Berghahn's pages end in .xml without being feeds.
  for (const u of ["https://www.berghahnjournals.com/view/journals/ajec/ajec-overview.xml", "https://www.berghahnjournals.com/view/journals/ajec/34/2/ajec.34.issue-2.xml"]) {
    assert.deepEqual(feedUrls(u), ["https://www.berghahnjournals.com/journalissuetocrss/journals/ajec/ajec-overview.xml"], u);
  }
  assert.deepEqual(feedUrls("https://social-analysis.berghahnjournals.com/"), ["https://www.berghahnjournals.com/journalissuetocrss/journals/social-analysis/social-analysis-overview.xml"]);
  // Second feeds: the Atypon platforms' articles not yet in an issue; Project MUSE's issues next to its articles.
  assert.deepEqual(feedUrls("https://onlinelibrary.wiley.com/journal/15481433"), ["https://onlinelibrary.wiley.com/feed/15481433/most-recent", "https://onlinelibrary.wiley.com/action/showFeed?jc=15481433&type=axatoc&feed=rss"]);
  assert.deepEqual(feedUrls("https://www.tandfonline.com/journals/rhum20")?.[1], "https://www.tandfonline.com/action/showFeed?type=axatoc&feed=rss&jc=rhum20");
  assert.deepEqual(feedUrls("https://www.journals.uchicago.edu/journals/ca/about")?.[1], "https://www.journals.uchicago.edu/action/showFeed?type=axatoc&feed=rss&jc=ca");
  for (const u of ["https://muse.jhu.edu/journal/10", "https://muse.jhu.edu/pub/229/journal/10"]) {
    assert.deepEqual(feedUrls(u), ["https://muse.jhu.edu/feeds/latest_articles?jid=10", "https://muse.jhu.edu/feeds/latest_issues?jid=10"], u);
  }
  assert.equal(feedUrls("https://muse.jhu.edu/article/12345"), null);
});

test("SAGE journal pages refuse the page fetch but offer their RSS 1.0 table-of-contents feed", async () => {
  const pageUrl = "https://journals.sagepub.com/home/chd";
  const feedUrl = "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd";
  assert.deepEqual(journalFromUrl(new URL(pageUrl)), { platform: "sage", id: "chd" });
  assert.equal(isPublisherHost("journals.sagepub.com"), true);
  assert.equal(planJournal(new URL("https://journals.sagepub.com/")), null);
  assert.equal(journalFromUrl(new URL("https://journals.sagepub.com/home/not-a-code")), null);
  assert.equal(journalFromUrl(new URL("https://notjournals.sagepub.com/home/chd")), null);
  assert.equal(isPublisherHost("notjournals.sagepub.com"), false);
  assert.equal(journalFromUrl(new URL("https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd")), null, "the feed itself is not mistaken for a journal page");
  const { fetch, calls } = stub({ [feedUrl]: rdfFeed(feedUrl, "SAGE Publications Ltd: Childhood: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.via, c.origin]), [["Childhood", feedUrl, "Articles feed", "SAGE journal"]]);
  assert.deepEqual(calls.map((c) => c.url), [feedUrl], "derive and check the feed directly; don't fetch the page's 403 or guess generic paths");
});

test("a SAGE journal whose eTOC feed is unavailable doesn't guess at generic site feeds", async () => {
  const pageUrl = "https://journals.sagepub.com/home/chd";
  const feedUrl = "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd";
  const { fetch, calls } = stub({
    [pageUrl]: forbidden(pageUrl),
    [feedUrl]: fakeResponse(feedUrl, "Not found", "text/plain", 404),
  });
  const d = await discover(pageUrl, { fetch, now: NOW });
  assert.ok(!d.ok && d.reason === "unreachable" && d.message.includes("403"), JSON.stringify(d));
  assert.deepEqual(calls.map((c) => c.url).filter((u) => !u.startsWith("https://www.wikidata.org/")), [feedUrl, pageUrl, "https://www.journals.sagepub.com/home/chd"]);
});

test("a SAGE journal's Crossref feed is an alternative after its own table-of-contents feed", async () => {
  const pageUrl = "https://journals.sagepub.com/home/chd";
  const feedUrl = "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=chd";
  const crossrefUrl = crossrefJournalSearchUrl("Childhood");
  const { fetch, calls } = stub({
    [feedUrl]: rdfFeed(feedUrl, "SAGE Publications Ltd: Childhood: Table of Contents"),
    [crossrefUrl]: json(crossrefUrl, { message: { items: [{ title: "Childhood", publisher: "SAGE Publications", ISSN: ["0907-5682", "1461-7013"], "issn-type": [{ type: "print", value: "0907-5682" }, { type: null, value: "1461-7013" }] }] } }),
  });
  const asked: string[] = [];
  const bridge: BridgeClient = async (target) => {
    asked.push(`${target.service.id}/${target.key}`);
    return { status: 200, body: Buffer.from(rss("Childhood")) };
  };
  const d = ok(await discover(pageUrl, { fetch, bridge, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.alternative ?? false]), [
    ["Childhood", feedUrl, false],
    ["Childhood", "bridge:crossref/09075682", true],
  ]);
  assert.deepEqual(asked, ["crossref/09075682"]);
  assert.ok(calls.some((c) => c.url.startsWith("https://api.crossref.org/journals?query=Childhood")));
  const searchesBefore = calls.filter((c) => c.url.startsWith("https://api.crossref.org/")).length;
  const one = ok(await discover(pageUrl, { fetch, bridge, now: NOW, maxCandidates: 1 }));
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.crossref.org/")).length, searchesBefore, "nor its journal search");
  assert.deepEqual(one.candidates.map((c) => [c.title, c.feedUrl, c.alternative ?? false]), [["Childhood", feedUrl, false]], "when one choice fits, keep the journal's own feed ahead of Crossref");
  assert.deepEqual(asked, ["crossref/09075682"], "don't fetch an alternative that cannot fit in the caller's candidate limit");
});

test("journal rules take a code only from where the platform puts it, and leave feeds and other pages alone", () => {
  for (const u of [
    "https://onlinelibrary.wiley.com/journal/17576548", // check digit wrong
    "https://onlinelibrary.wiley.com/doi/10.1111/aman.70137", // an article: its DOI is read elsewhere
    "https://onlinelibrary.wiley.com/action/doSearch?q=15481433",
    "https://onlinelibrary.wiley.com/feed/15481433/most-recent", // already the feed
    "https://notwiley.com/journal/15481433",
    "https://www.tandfonline.com/doi/full/10.1080/00187259.2026.2739223",
    "https://www.tandfonline.com/feed/rss/rhum20",
    "https://www.berghahnjournals.com/journalissuetocrss/journals/ajec/ajec-overview.xml", // the feed itself
    "https://www.berghahnjournals.com/",
    "https://www.berghahnjournals.com/view/journals",
  ]) assert.equal(feedUrls(u), null, u);
});

test("journal names: the platform's decoration around the journal's name is dropped", () => {
  assert.equal(journalTitle("Wiley: American Anthropologist: Table of Contents"), "American Anthropologist");
  assert.equal(journalTitle("tandf: History and Anthropology: Table of Contents"), "History and Anthropology");
  assert.equal(journalTitle("The University of Chicago Press: Current Anthropology: Table of Contents"), "Current Anthropology");
  assert.equal(journalTitle("SAGE Publications Ltd: Childhood: Table of Contents"), "Childhood");
  assert.equal(journalTitle("Social Anthropology/Anthropologie sociale"), "Social Anthropology/Anthropologie sociale");
  assert.equal(journalTitle("Project MUSE®: Anthropological Quarterly - Latest Issues"), "Anthropological Quarterly");
  assert.equal(journalTitle("Wiley-Online-Library: Table of Contents"), null, "names only the platform");
  assert.equal(journalTitle(" "), null);
  for (const name of ["SAGE Publications Ltd: Childhood: Table of Contents", "SAGE Publications Inc: Childhood: Table of Contents", "SAGE Publications India Pvt Ltd: Childhood: Table of Contents"]) assert.equal(journalTitle(name), "Childhood", name);
  assert.equal(journalTitle("IEEE Transactions on Pattern Analysis and Machine Intelligence - new TOC"), "IEEE Transactions on Pattern Analysis and Machine Intelligence");
  assert.equal(journalTitle("Environmental Research Letters - latest papers"), "Environmental Research Letters");
  assert.equal(journalTitle("Frontiers in Psychology | New and Recent Articles"), "Frontiers in Psychology");
  assert.equal(journalTitle("Association for Computing Machinery: ACM Transactions on Database Systems: Table of Contents"), "ACM Transactions on Database Systems");
  assert.equal(journalTitle("tandf: Table of Contents"), null, "an early-articles feed that names no journal is named like the journal's main feed");
  assert.equal(journalTitle("Latest Results"), null, "Springer's search feed names no journal");
});

test("more platforms: IEEE, IOP, ACM, Springer, MDPI, PLOS and Frontiers journal, issue and article pages give the journal's feed", () => {
  const cases: [string, string][] = [
    ["https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=34", "https://ieeexplore.ieee.org/rss/TOC34.XML"],
    ["https://ieeexplore.ieee.org/xpl/tocresult.jsp?isnumber=11000001&punumber=6287639", "https://ieeexplore.ieee.org/rss/TOC6287639.XML"],
    ["https://iopscience.iop.org/journal/1748-9326", "https://iopscience.iop.org/journal/rss/1748-9326"],
    ["https://iopscience.iop.org/article/10.1088/1748-9326/aebe4d", "https://iopscience.iop.org/journal/rss/1748-9326"],
    ["https://dl.acm.org/journal/tods", "https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=tods"],
    ["https://dl.acm.org/toc/csur/current", "https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=csur"],
    ["https://link.springer.com/journal/10853", "https://link.springer.com/search.rss?facet-journal-id=10853&search-within=Journal&query="],
    ["https://link.springer.com/journal/10551/volumes-and-issues", "https://link.springer.com/search.rss?facet-journal-id=10551&search-within=Journal&query="],
    ["https://www.mdpi.com/journal/sensors", "https://www.mdpi.com/rss/journal/sensors"],
    ["https://www.mdpi.com/journal/nutrients/special_issues", "https://www.mdpi.com/rss/journal/nutrients"],
    ["https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.3004123", "https://journals.plos.org/plosbiology/feed/atom"],
    ["https://journals.plos.org/plosone/", "https://journals.plos.org/plosone/feed/atom"],
    ["https://www.frontiersin.org/journals/psychology", "https://www.frontiersin.org/journals/psychology/rss"],
    ["https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2026.1950288/full", "https://www.frontiersin.org/journals/psychology/rss"],
  ];
  for (const [page, feed] of cases) assert.deepEqual(mainFeed(page), [feed], page);
  for (const other of [
    "https://ieeexplore.ieee.org/document/11426947/", // an article: no publication number
    "https://iopscience.iop.org/journal/1748-9327", // a wrong check digit
    "https://link.springer.com/article/10.1007/s10551-026-06529-9",
    "https://www.mdpi.com/2072-6643/18/22/3854",
    "https://journals.plos.org/",
    "https://www.frontiersin.org/journals",
    "https://www.frontiersin.org/articles/10.3389/fpsyg.2026.1950288/full", // no journal name in the address
  ]) assert.equal(feedUrls(other), null, other);
});

test("a Springer journal's search feed is named after the journal its first article belongs to, as Crossref says", async () => {
  const pageUrl = "https://link.springer.com/journal/10853";
  const feedUrl = "https://link.springer.com/search.rss?facet-journal-id=10853&search-within=Journal&query=";
  const work = "https://api.crossref.org/works/10.1007%2Fs10853-026-12345-6";
  const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>Latest Results</title><link>https://link.springer.com</link><description>x</description><item><title>An article</title><link>https://link.springer.com/article/10.1007/s10853-026-12345-6</link></item></channel></rss>`;
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [feedUrl]: fakeResponse(feedUrl, body, "application/rss+xml"),
    [work]: json(work, { message: { publisher: "Springer Science and Business Media LLC", "container-title": ["Journal of Materials Science"], ISSN: ["0022-2461", "1573-4803"] } }),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.origin]), [["Journal of Materials Science", feedUrl, "Springer Nature journal"]]);
  // Linked from a society's page, the journal is named the same way.
  const society = "https://society.example.org/journal";
  const linked = stub({
    [society]: page(society, `<html><head><title>Our journal</title></head><body><a href="${pageUrl}">Journal of Materials Science</a></body></html>`),
    [feedUrl]: fakeResponse(feedUrl, body, "application/rss+xml"),
    [work]: json(work, { message: { publisher: "Springer Science and Business Media LLC", "container-title": ["Journal of Materials Science"], ISSN: ["0022-2461", "1573-4803"] } }),
  });
  assert.equal(ok(await discover(society, { fetch: linked.fetch, now: NOW })).candidates[0]!.title, "Journal of Materials Science");
  // Crossref not answering: named for what it is, never "Latest Results".
  const down = stub({ [pageUrl]: forbidden(pageUrl), [feedUrl]: fakeResponse(feedUrl, body, "application/rss+xml"), [work]: fakeResponse(work, "busy", "text/plain", 503) });
  assert.equal(ok(await discover(pageUrl, { fetch: down.fetch, now: NOW })).candidates[0]!.title, "Springer Nature journal");
  assert.equal(doiFromArticleUrl(new URL("https://www.journals.sagepub.com/doi/10.1177/09567976261490829")), "10.1177/09567976261490829");
});

test("DOIs: bare, doi:, doi.org and walled article addresses; nothing else", () => {
  assert.deepEqual(doiFromInput("10.1111/aman.70137"), { doi: "10.1111/aman.70137", viaResolver: false });
  assert.deepEqual(doiFromInput("doi:10.1111/aman.70137"), { doi: "10.1111/aman.70137", viaResolver: false });
  assert.deepEqual(doiFromInput("https://doi.org/10.1017/s0010417526100644"), { doi: "10.1017/s0010417526100644", viaResolver: true });
  assert.deepEqual(doiFromInput("http://dx.doi.org/10.1080%2F00187259.2026.2739223"), { doi: "10.1080/00187259.2026.2739223", viaResolver: true });
  assert.deepEqual(doiFromInput("https://doi.org/10.1111/aman.70137?utm_source=alert#top"), { doi: "10.1111/aman.70137", viaResolver: true }, "an alert's tracking parameters are not part of the DOI");
  for (const s of ["10.1.1.1", "10.0.0.1/admin", "https://example.com/10.1111/x", "doi.org", "10.1111/a b"]) assert.equal(doiFromInput(s), null, s);
  assert.equal(doiFromArticleUrl(new URL("https://www.tandfonline.com/doi/full/10.1080/00187259.2026.2739223")), "10.1080/00187259.2026.2739223");
  assert.equal(doiFromArticleUrl(new URL("https://anthrosource.onlinelibrary.wiley.com/doi/10.1111/aman.70137")), "10.1111/aman.70137");
  assert.equal(doiFromArticleUrl(new URL("https://example.com/doi/10.1111/aman.70137")), null, "only platforms whose article pages are walled");
});

test("Crossref: a work's journal with the ISSN its publisher's feed takes first; a journal search counts only when exactly one title matches", () => {
  const work = { message: { publisher: "Wiley", "container-title": ["American Anthropologist"], "issn-type": [{ type: "print", value: "0002-7294" }, { type: "electronic", value: "1548-1433" }] } };
  assert.deepEqual(readCrossrefWork(work), { title: "American Anthropologist", publisher: "Wiley", issns: ["1548-1433", "0002-7294"], electronic: "1548-1433" });
  const elsevier = { message: { publisher: "Elsevier BV", "container-title": ["Journal of Anthropological Archaeology"], "issn-type": [{ type: "electronic", value: "1090-2686" }, { type: "print", value: "0278-4165" }] } };
  assert.deepEqual(readCrossrefWork(elsevier)?.issns, ["0278-4165", "1090-2686"]);
  assert.equal(readCrossrefWork(elsevier)?.electronic, "1090-2686", "Crossref's own records are asked for under the electronic one");
  const item = (title: string, publisher = "Elsevier") => ({ title, publisher, "issn-type": [{ type: "print", value: "0278-4165" }] });
  const slug = "journal-of-anthropological-archaeology";
  assert.equal(readCrossrefJournalSearch({ message: { items: [item("Journal of Anthropological Archaeology"), item("Journal of Historical Archaeology & Anthropological Sciences")] } }, slug)?.title, "Journal of Anthropological Archaeology");
  assert.equal(readCrossrefJournalSearch({ message: { items: [item("Journal of Anthropological Archaeology Review")] } }, slug), null, "a near miss is another journal");
  assert.equal(readCrossrefJournalSearch({ message: { items: [item("Journal of Anthropological Archaeology"), item("Journal of Anthropological Archaeology")] } }, slug), null, "two matches: can't tell which");
  assert.equal(readCrossrefJournalSearch({ message: { items: [item("Journal of Anthropological Archaeology", "Springer")] } }, slug), null, "not on ScienceDirect");
});

test("a walled Wiley journal page: the journal's feed, named after the journal, and the page itself is never asked for", async () => {
  const pageUrl = "https://onlinelibrary.wiley.com/journal/18344461";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/18344461/most-recent";
  const { fetch, calls } = stub({ [pageUrl]: forbidden(pageUrl), [feedUrl]: feed(feedUrl, "Wiley: Oceania: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.via, c.origin]), [["Oceania", feedUrl, "Articles feed", "Wiley journal"]]);
  assert.deepEqual(calls.map((c) => c.url), [feedUrl, "https://onlinelibrary.wiley.com/action/showFeed?jc=18344461&type=axatoc&feed=rss"]);
});

test("a walled publisher page whose journal feed doesn't answer: no guessing at blog feed addresses", async () => {
  const pageUrl = "https://www.tandfonline.com/journals/zzzz20";
  const { fetch, calls } = stub({ [pageUrl]: forbidden(pageUrl) });
  const d = await discover(pageUrl, { fetch, now: NOW });
  assert.ok(!d.ok);
  const site = calls.map((c) => c.url).filter((u) => !u.startsWith("https://www.wikidata.org/"));
  assert.deepEqual(site, ["https://www.tandfonline.com/feed/rss/zzzz20", "https://www.tandfonline.com/action/showFeed?type=axatoc&feed=rss&jc=zzzz20", pageUrl]);
  assert.equal(calls.length - site.length, 1, "then Wikidata is asked what the walled page is");
});

test("a society's page for its journal: the journal's feed on the publisher's platform first, the society's own feed after it, labelled", async () => {
  const pageUrl = "https://society.example/social-anthropology/";
  const journalFeed = "https://www.berghahnjournals.com/journalissuetocrss/journals/saas/saas-overview.xml";
  const html = `<html><head><title>Social Anthropology/Anthropologie Sociale – Society</title><link rel="alternate" type="application/rss+xml" title="Society" href="/feed/"></head>
    <body><a href="https://www.berghahnjournals.com/view/journals/saas/34/2/saas.34.issue-2.xml">Latest issue</a>
    <a href="https://www.berghahnjournals.com/view/journals/saas/saas-overview.xml">Read the journal</a></body></html>`;
  const { fetch, calls } = stub({
    [pageUrl]: page(pageUrl, html),
    "https://society.example/feed/": fakeResponse("https://society.example/feed/", rss("Society", "https://society.example/"), "application/rss+xml"),
    [journalFeed]: feed(journalFeed, "Social Anthropology/Anthropologie sociale"),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.via, c.matchesPage, c.note ?? null]), [
    ["Social Anthropology/Anthropologie sociale", "Articles feed", true, null],
    ["Society", "Whole site feed", true, WHOLE_SITE_NOTE],
  ]);
  assert.equal(calls.filter((c) => c.url === journalFeed).length, 1, "two links to one journal: one probe");
});

test("a page linking to a journal that isn't shown to be its own: offered, not claimed, with a note saying where it came from", async () => {
  const pageUrl = "https://blog.example/reading-list";
  const journalFeed = "https://www.tandfonline.com/feed/rss/ghan20";
  const html = `<html><head><title>My reading list</title></head><body><a href="https://www.tandfonline.com/toc/ghan20/current">this issue</a></body></html>`;
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), [journalFeed]: feed(journalFeed, "tandf: History and Anthropology: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage, c.note]), [["History and Anthropology", false, LINKED_JOURNAL_NOTE]]);
});

test("an article page whose metadata names a Wiley journal: the journal's feed from its ISSN", async () => {
  const pageUrl = "https://mirror.example/article/1";
  const html = `<html><head><title>An article</title><meta name="citation_publisher" content="John Wiley &amp; Sons"><meta name="citation_issn" content="0002-7294"><meta name="citation_issn" content="1548-1433"></head><body></body></html>`;
  const right = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), [right]: feed(right, "Wiley: American Anthropologist: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.matchesPage]), [["American Anthropologist", right, true]]);
});

test("a bare DOI: Crossref names the Wiley journal and its feed answers", async () => {
  const work = "https://api.crossref.org/works/10.1111%2Faman.70137";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
  const { fetch } = stub({
    [work]: json(work, { message: { publisher: "Wiley", "container-title": ["American Anthropologist"], "issn-type": [{ type: "print", value: "0002-7294" }, { type: "electronic", value: "1548-1433" }] } }),
    [feedUrl]: feed(feedUrl, "Wiley: American Anthropologist: Table of Contents"),
  });
  for (const input of ["10.1111/aman.70137", "doi:10.1111/aman.70137"]) {
    const d = ok(await discover(input, { fetch, now: NOW }));
    assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl]), [["American Anthropologist", feedUrl]], input);
  }
});

test("a DOI whose journal has no feed rule: its doi.org page is asked for as a web page, and an empty result names the journal", async () => {
  const work = "https://api.crossref.org/works/10.1080%2F00187259.2026.2739223";
  const resolver = "https://doi.org/10.1080/00187259.2026.2739223";
  const { fetch, calls } = stub({
    [work]: json(work, { message: { publisher: "Informa UK Limited", "container-title": ["Human Organization"], "issn-type": [{ type: "print", value: "0018-7259" }] } }),
    // doi.org hands a feed reader's usual request to Crossref's metadata service, which refuses it.
    [resolver]: (url, accept) => (accept?.startsWith("text/html") ? page(url, "<html><head><title>Article</title></head><body>An article</body></html>") : fakeResponse(url, "", "text/plain", 406)),
  });
  const d = await discover("10.1080/00187259.2026.2739223", { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "nofeed");
  assert.match(d.message, /Human Organization \(Informa UK Limited\).*journal's own page/);
  assert.ok(calls.some((c) => c.url === resolver && c.accept?.startsWith("text/html")));
});

test("a doi.org address when Crossref fails: the address as given, asked for as a web page, and that page's feeds", async () => {
  const work = "https://api.crossref.org/works/10.5555%2Fx.1";
  const resolver = "https://doi.org/10.5555/x.1";
  const landing = "https://journal.example/article/1";
  const html = `<html><head><title>Article</title><link rel="alternate" type="application/rss+xml" title="Journal" href="https://journal.example/feed"></head></html>`;
  const { fetch } = stub({
    [work]: fakeResponse(work, "busy", "text/plain", 503),
    [resolver]: (_url, accept) => (accept?.startsWith("text/html") ? page(landing, html) : fakeResponse(resolver, "", "text/plain", 406)),
    "https://journal.example/feed": feed("https://journal.example/feed", "The Journal"),
  });
  const d = ok(await discover("https://doi.org/10.5555/x.1", { fetch, now: NOW }));
  assert.equal(d.url, resolver);
  assert.deepEqual(d.candidates.map((c) => c.title), ["The Journal"]);
});

test("a ScienceDirect journal: Crossref's one exact match gives the print ISSN its feed takes", async () => {
  const pageUrl = "https://www.sciencedirect.com/journal/journal-of-anthropological-archaeology";
  const search = "https://api.crossref.org/journals?query=journal%20of%20anthropological%20archaeology&rows=5";
  const feedUrl = "https://rss.sciencedirect.com/publication/science/02784165";
  const { fetch } = stub({
    [pageUrl]: forbidden(pageUrl),
    [search]: json(search, { message: { items: [{ title: "Journal of Anthropological Archaeology", publisher: "Elsevier BV", "issn-type": [{ type: "electronic", value: "1090-2686" }, { type: "print", value: "0278-4165" }] }] } }),
    [feedUrl]: feed(feedUrl, ""),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.origin]), [["Journal of Anthropological Archaeology", feedUrl, "Elsevier journal"]]);
});

test("Duke University Press: its walled pages get a message saying how to find the feed", async () => {
  const pageUrl = "https://read.dukeupress.edu/public-culture";
  const { fetch } = stub({ [pageUrl]: forbidden(pageUrl) });
  const d = await discover(pageUrl, { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.message, DUKE_MESSAGE);
});

const SD_SEARCH = "https://api.crossref.org/journals?query=journal%20of%20archaeological%20science&rows=5";
const SD_FEED = "https://rss.sciencedirect.com/publication/science/03054403";

test("a society's page linking to its journal on ScienceDirect: Crossref gives the ISSN, and the journal's feed is offered as the page's own", async () => {
  const pageUrl = "https://society.example/publications/jas.html";
  const html = `<html><head><title>Journal of Archaeological Science | Society</title></head><body><a href="https://www.sciencedirect.com/journal/journal-of-archaeological-science">Journal of Archaeological Science</a></body></html>`;
  const { fetch } = stub({
    [pageUrl]: page(pageUrl, html),
    [SD_SEARCH]: json(SD_SEARCH, { message: { items: [{ title: "Journal of Archaeological Science", publisher: "Elsevier BV", "issn-type": [{ type: "print", value: "0305-4403" }] }] } }),
    [SD_FEED]: feed(SD_FEED, ""),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.matchesPage]), [["Journal of Archaeological Science", SD_FEED, true]]);
});

test("a page's own journal from its metadata is still found when the page also links to another journal", async () => {
  const pageUrl = "https://mirror.example/article/2";
  const html = `<html><head><title>An article</title><meta name="citation_publisher" content="Wiley"><meta name="citation_issn" content="1548-1433"></head>
    <body><a href="https://www.tandfonline.com/toc/ghan20/current">see also</a></body></html>`;
  const wiley = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
  const tandf = "https://www.tandfonline.com/feed/rss/ghan20";
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), [wiley]: feed(wiley, "Wiley: American Anthropologist: Table of Contents"), [tandf]: feed(tandf, "tandf: History and Anthropology: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage]).sort(), [["American Anthropologist", true], ["History and Anthropology", false]]);
});

test("address words a page shares with a publisher's link (/journals) don't make the linked journal the page's own", async () => {
  const pageUrl = "https://library.example/journals";
  const tandf = "https://www.tandfonline.com/feed/rss/ghan20";
  const html = `<html><head><title>Our subscriptions</title></head><body><a href="https://www.tandfonline.com/journals/ghan20">one of many</a></body></html>`;
  const { fetch } = stub({ [pageUrl]: page(pageUrl, html), [tandf]: feed(tandf, "tandf: History and Anthropology: Table of Contents") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage, c.note]), [["History and Anthropology", false, LINKED_JOURNAL_NOTE]]);
});

test("a DOI whose journal feed times out and whose page is busy: a retryable answer, not \"no feed\"", async () => {
  const work = "https://api.crossref.org/works/10.1111%2Faman.70137";
  const resolver = "https://doi.org/10.1111/aman.70137";
  const { fetch } = stub({
    [work]: json(work, { message: { publisher: "Wiley", "container-title": ["American Anthropologist"], "issn-type": [{ type: "electronic", value: "1548-1433" }] } }),
    "https://onlinelibrary.wiley.com/feed/15481433/most-recent": fakeFailure("timeout"),
    [resolver]: fakeResponse(resolver, "busy", "text/plain", 503),
  });
  const d = await discover("10.1111/aman.70137", { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "timeout");
  const busy = stub({
    [work]: json(work, { message: { publisher: "Informa UK Limited", "container-title": ["Human Organization"], "issn-type": [{ type: "print", value: "0018-7259" }] } }),
    [resolver]: fakeResponse(resolver, "slow down", "text/plain", 429),
  });
  const b = await discover("10.1111/aman.70137", { fetch: busy.fetch, now: NOW });
  assert.ok(!b.ok);
  assert.equal(b.reason, "unreachable");
  assert.doesNotMatch(b.message, /can't be found/);
});

test("a journal the page links to and whose ISSN its metadata states is the page's own, once, and comes before journals it only links to", async () => {
  const pageUrl = "https://society.example/jas";
  const tandf = "https://www.tandfonline.com/feed/rss/ghan20";
  const html = `<html><head><title>Our journal</title><meta name="citation_publisher" content="Elsevier"><meta name="citation_issn" content="0305-4403"></head>
    <body><a href="https://www.tandfonline.com/toc/ghan20/current">see also</a> <a href="https://www.sciencedirect.com/journal/journal-of-archaeological-science">read it</a></body></html>`;
  const { fetch, calls } = stub({
    [pageUrl]: page(pageUrl, html),
    [SD_SEARCH]: json(SD_SEARCH, { message: { items: [{ title: "Journal of Archaeological Science", publisher: "Elsevier BV", "issn-type": [{ type: "print", value: "0305-4403" }] }] } }),
    [SD_FEED]: feed(SD_FEED, ""),
    [tandf]: feed(tandf, "tandf: History and Anthropology: Table of Contents"),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.matchesPage, c.note ?? null]), [["Journal of Archaeological Science", true, null], ["History and Anthropology", false, LINKED_JOURNAL_NOTE]]);
  assert.equal(calls.filter((c) => c.url === SD_FEED).length, 1);
  const one = ok(await discover(pageUrl, { fetch, now: NOW, maxCandidates: 1 }));
  assert.deepEqual(one.candidates.map((c) => c.title), ["Journal of Archaeological Science"]);
});

test("a DOI that lands on a walled journal page whose feed times out: a retryable answer, not \"no feed\"", async () => {
  const work = "https://api.crossref.org/works/10.1080%2F00187259.2026.1";
  const resolver = "https://doi.org/10.1080/00187259.2026.1";
  const landing = "https://www.tandfonline.com/toc/rhum20/current";
  const { fetch } = stub({
    [work]: json(work, { message: { publisher: "Informa UK Limited", "container-title": ["Human Organization"], "issn-type": [{ type: "print", value: "0018-7259" }] } }),
    [resolver]: forbidden(landing),
    "https://www.tandfonline.com/feed/rss/rhum20": fakeFailure("timeout"),
  });
  const d = await discover("10.1080/00187259.2026.1", { fetch, now: NOW });
  assert.ok(!d.ok);
  assert.equal(d.reason, "timeout");
});

const WILEY_MAIN = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
const WILEY_EARLY = "https://onlinelibrary.wiley.com/action/showFeed?jc=15481433&type=axatoc&feed=rss";
const wileyPage = "https://onlinelibrary.wiley.com/journal/15481433";

test("a journal with articles online that aren't in an issue yet: both feeds, each saying what it holds, the second named like the first", async () => {
  const { fetch } = stub({
    [WILEY_MAIN]: fakeResponse(WILEY_MAIN, rss("Wiley: American Anthropologist: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [1, 2, 3]), "application/rss+xml"),
    [WILEY_EARLY]: fakeResponse(WILEY_EARLY, rss("Wiley-Online-Library: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [7, 8]), "application/rss+xml"),
  });
  const d = ok(await discover(wileyPage, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.via, c.note ?? null]), [
    ["American Anthropologist", "Articles feed", null],
    ["American Anthropologist", "Early articles feed", EARLY_NOTE],
  ]);
});

test("a journal's second feed with the same articles as its main feed, or with none, is not offered as a choice", async () => {
  const same = rss("Wiley-Online-Library: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [3, 1, 2]);
  for (const early of [same, rss("Wiley-Online-Library: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [])]) {
    const { fetch } = stub({
      [WILEY_MAIN]: fakeResponse(WILEY_MAIN, rss("Wiley: American Anthropologist: Table of Contents", "https://onlinelibrary.wiley.com/doi/"), "application/rss+xml"),
      [WILEY_EARLY]: fakeResponse(WILEY_EARLY, early, "application/rss+xml"),
    });
    const d = ok(await discover(wileyPage, { fetch, now: NOW }));
    assert.deepEqual(d.candidates.map((c) => c.via), ["Articles feed"]);
  }
});

test("a subset is a choice of its own: an early-articles feed whose articles the main feed also carries is still offered", async () => {
  const { fetch } = stub({
    [WILEY_MAIN]: fakeResponse(WILEY_MAIN, rss("Wiley: Oceania: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [1, 2, 3]), "application/rss+xml"),
    [WILEY_EARLY]: fakeResponse(WILEY_EARLY, rss("Wiley-Online-Library: Table of Contents", "https://onlinelibrary.wiley.com/doi/", [2, 3]), "application/rss+xml"),
  });
  const d = ok(await discover(wileyPage, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.via), ["Articles feed", "Early articles feed"]);
});

test("a page's feeds in two formats with the same entries are one choice; feeds with the same name and newest entry but other entries are two", async () => {
  const pageUrl = "https://blog.example/";
  const html = `<html><head><title>Blog</title>
    <link rel="alternate" type="application/rss+xml" title="Blog" href="/rss">
    <link rel="alternate" type="application/atom+xml" title="Blog" href="/atom">
    <link rel="alternate" type="application/rss+xml" title="Blog" href="/everything"></head></html>`;
  const { fetch } = stub({
    [pageUrl]: page(pageUrl, html),
    "https://blog.example/rss": fakeResponse("https://blog.example/rss", rss("Blog", "https://blog.example/", [1, 2, 3]), "application/rss+xml"),
    "https://blog.example/atom": fakeResponse("https://blog.example/atom", rss("Blog", "https://blog.example/", [3, 2, 1]), "application/rss+xml"),
    "https://blog.example/everything": fakeResponse("https://blog.example/everything", rss("Blog", "https://blog.example/", [1, 2, 3, 4, 5]), "application/rss+xml"),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => c.feedUrl), ["https://blog.example/rss", "https://blog.example/everything"]);
});

test("an Open Journal Systems journal: its announcements are offered next to its articles, saying what they are", async () => {
  const pageUrl = "https://ojs.example/index.php/j/index";
  const articles = "https://ojs.example/index.php/j/gateway/plugin/WebFeedGatewayPlugin/atom";
  const news = "https://ojs.example/index.php/j/gateway/plugin/AnnouncementFeedGatewayPlugin/atom";
  const html = `<html><head><title>The Journal</title><link rel="alternate" type="application/atom+xml" href="${articles}"></head></html>`;
  const { fetch } = stub({
    [pageUrl]: page(pageUrl, html),
    [articles]: fakeResponse(articles, rss("The Journal", "https://ojs.example/index.php/j/article/view/"), "application/rss+xml"),
    [news]: fakeResponse(news, rss("The Journal: Announcements", "https://ojs.example/index.php/j/announcement/view/"), "application/rss+xml"),
  });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.via, c.note ?? null]), [["The Journal", "Posts feed", null], ["The Journal: Announcements", "Announcements feed", OJS_ANNOUNCEMENTS_NOTE]]);
});

test("Project MUSE: a journal's articles and its issues, two feeds with nothing in common", async () => {
  const articles = "https://muse.jhu.edu/feeds/latest_articles?jid=10";
  const issues = "https://muse.jhu.edu/feeds/latest_issues?jid=10";
  const { fetch } = stub({
    [articles]: fakeResponse(articles, rss("Project MUSE®: Anthropological Quarterly - Latest Articles", "https://muse.jhu.edu/article/"), "application/rss+xml"),
    [issues]: fakeResponse(issues, rss("Project MUSE®: Anthropological Quarterly - Latest Issues", "https://muse.jhu.edu/issue/"), "application/rss+xml"),
  });
  const d = ok(await discover("https://muse.jhu.edu/journal/10", { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.via, c.note ?? null]), [["Anthropological Quarterly", "Articles feed", null], ["Anthropological Quarterly", "Issues feed", ISSUES_NOTE]]);
});

test("an MDPI journal page: the journal's own feed, chosen, and MDPI's feed of all its journals after it, labelled as the whole site's", async () => {
  const pageUrl = "https://www.mdpi.com/journal/sensors";
  const journalFeedUrl = "https://www.mdpi.com/rss/journal/sensors";
  const all = "https://www.mdpi.com/rss";
  const { fetch } = stub({ [pageUrl]: forbidden(pageUrl), [journalFeedUrl]: feed(journalFeedUrl, "Sensors"), [all]: feed(all, "MDPI Publishing") });
  const d = ok(await discover(pageUrl, { fetch, now: NOW }));
  assert.deepEqual(d.candidates.map((c) => [c.title, c.feedUrl, c.via, c.note ?? null]), [
    ["Sensors", journalFeedUrl, "Articles feed", null],
    ["MDPI Publishing", all, "Whole site feed", WHOLE_SITE_NOTE],
  ]);
  assert.ok(d.candidates.every((c) => c.matchesPage === undefined), "nothing claims the page, so the first (the journal's own feed) starts out chosen");
});
