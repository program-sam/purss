import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DISCOVERY_ROUTES, isDiscoveryRoute } from "@purss/domain";
import type { DiscoveryRoute } from "@purss/domain";
import { BRIDGE_SERVICES } from "./bridges.ts";
import { discover } from "./discover.ts";
import type { BridgeClient, DiscoveryDraft, FetchFn } from "./discover.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { fakeResponse } from "./testing.ts";
import { addressVariants, wikidataEntitiesUrl, wikidataSearchUrl } from "./wikidata.ts";

/*
 * Every candidate discovery produces carries exactly one route (domain/discovery-routes.ts), and each route of the list can be produced.
 * The table has an entry for every route: a route added to the list without a way to produce it does not compile.
 */

const NOW = () => new Date("2026-11-03T12:00:00Z");
const WEEKLY = ["Mon, 02 Nov 2026 10:00:00 GMT", "Mon, 26 Oct 2026 10:00:00 GMT", "Mon, 19 Oct 2026 10:00:00 GMT", "Mon, 12 Oct 2026 10:00:00 GMT"];
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A feed with a few dated entries, for whatever address is asked for; `PeerTube` is its generator, for the one service that wants it. */
function rss(title: string, link = "https://x.example"): string {
  const items = WEEKLY.map((d, i) => `<item><title>${title} ${i + 1}</title><link>${link}/p${i + 1}</link><guid>${link}-g${i + 1}</guid><pubDate>${d}</pubDate><description>A teaser</description></item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}/</link><description>x</description><generator>PeerTube</generator>${items}</channel></rss>`;
}
/** Each address has posts of its own, so two feeds on one site are never taken for one. */
const page_ = (url: string, html: string) => fakeResponse(url, html, "text/html; charset=utf-8");
/** A page that loads one script. */
const scriptsPage = (url: string, src: string) => page_(url, `<html><head><title>News</title><script src="${src}"></script></head><body><div id="root"></div></body></html>`);
const feedRes = (url: string, title = "A feed") => fakeResponse(url, rss(title, url.replace(/[?#].*$/, "").replace(/\/$/, "")), "application/rss+xml");
const page = (url: string, html: string) => fakeResponse(url, html, "text/html; charset=utf-8");
const json = (url: string, data: unknown) => fakeResponse(url, JSON.stringify(data), "application/json");

type Route = SafeFetchResult | ((url: string) => SafeFetchResult);
/** A site made of the routes given; every other address is a 404. */
const stub = (routes: Record<string, Route>): { fetch: FetchFn } => ({
  fetch: async (url) => {
    const route = routes[url];
    if (!route) return fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(url) : route;
  },
});
/** The web, where every address a service's pattern makes is a feed (and Apple's lookup names one). */
const everywhereAFeed: FetchFn = async (url) => {
  if (url.startsWith("https://itunes.apple.com/lookup")) return json(url, { results: [{ feedUrl: "https://feeds.example/show.xml" }] });
  return feedRes(url);
};
/** A router that reads any bridged source as a feed. */
const router: BridgeClient = async (target) => ({ status: 200, body: Buffer.from(rss(`${target.service.id} source`, "https://x.example")) });

/** A site with a page and what is at the addresses given. */
function site(pageUrl: string, html: string, feeds: string[] = []) {
  return stub({ [pageUrl]: page(pageUrl, html), ...Object.fromEntries(feeds.map((u) => [u, feedRes(u)])) });
}

const known = (url: string) => () => discover(url, { fetch: everywhereAFeed, now: NOW });
const bridged = (service: string) => () => {
  const s = BRIDGE_SERVICES.find((x) => x.id === service)!;
  return discover(`bridge:${service}/${s.example}`, { bridge: router, now: NOW });
};

/** The routes a case may leave out: those a table of cases elsewhere covers (this installation's own news is the API's, and is checked there). */
type Produced = Exclude<DiscoveryRoute, "installation-news">;

const CASES: Record<Produced, () => Promise<DiscoveryDraft>> = {
  "feed-address": () => discover("https://example.org/feed.xml", { fetch: stub({ "https://example.org/feed.xml": feedRes("https://example.org/feed.xml") }).fetch, now: NOW }),
  "alternate-link": () => discover("https://example.org/", { fetch: site("https://example.org/", `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`, ["https://example.org/feed.xml"]).fetch, now: NOW }),
  "page-anchor": () => discover("https://example.org/", { fetch: site("https://example.org/", `<html><body><a href="/posts/rss.xml">RSS</a></body></html>`, ["https://example.org/posts/rss.xml"]).fetch, now: NOW }),
  "copy-address": () => discover("https://example.org/", { fetch: site("https://example.org/", `<html><body><input readonly value="https://example.org/feeds/all.xml"></body></html>`, ["https://example.org/feeds/all.xml"]).fetch, now: NOW }),
  "listed-feed": () => {
    const home = "https://example.org/";
    const { fetch } = stub({
      [home]: page(home, `<html><body><a href="/rss-feeds">RSS feeds</a></body></html>`),
      "https://example.org/rss-feeds": page("https://example.org/rss-feeds", `<html><body><a href="/rss/news.xml">News</a></body></html>`),
      "https://example.org/rss/news.xml": feedRes("https://example.org/rss/news.xml"),
    });
    return discover(home, { fetch, now: NOW });
  },
  "section-path": () => discover("https://example.org/category/gardening/", { fetch: site("https://example.org/category/gardening/", `<html><body>Gardening</body></html>`, ["https://example.org/category/gardening/feed"]).fetch, now: NOW }),
  "conventional-path": () => discover("https://example.org/", { fetch: site("https://example.org/", `<html><body>Hi</body></html>`, ["https://example.org/feed"]).fetch, now: NOW }),
  "more-paths": () => discover("https://example.org/", { fetch: site("https://example.org/", `<html><body>Hi</body></html>`, ["https://example.org/rss.php"]).fetch, now: NOW }),
  "discourse-latest": () => discover("https://forum.example/", { fetch: site("https://forum.example/", `<html><head><meta name="generator" content="Discourse 3.3.0"></head></html>`, ["https://forum.example/latest.rss"]).fetch, now: NOW }),
  "known:github": known("https://github.com/nodejs/node"),
  "known:apple-podcasts": known("https://podcasts.apple.com/us/podcast/some-show/id1234567890"),
  "known:guardian": known("https://www.theguardian.com/football/series/footballweekly"),
  "known:substack": known("https://writer.substack.com/"),
  "known:medium": known("https://medium.com/@someone"),
  "known:tumblr": known("https://someone.tumblr.com/"),
  "known:blogger": known("https://someone.blogspot.com/"),
  "known:wordpress": known("https://someone.wordpress.com/"),
  "known:vimeo": known("https://vimeo.com/someone"),
  "known:pinterest": known("https://www.pinterest.com/someone/"),
  "known:steam": known("https://store.steampowered.com/app/440/Team_Fortress_2/"),
  "known:arxiv": known("https://arxiv.org/list/cs.LG/recent"),
  "known:dailymotion": known("https://www.dailymotion.com/someone"),
  "known:odysee": known("https://odysee.com/@someone:5"),
  "known:deviantart": known("https://www.deviantart.com/someone"),
  "known:peertube": known("https://peertube.example/c/channel"),
  "known:behance": known("https://www.behance.net/someone"),
  "known:nos": known("https://nos.nl/nieuws/tech"),
  "known:bbc": known("https://www.bbc.com/news/technology"),
  "known:presscorner": known("https://ec.europa.eu/commission/presscorner/home/en"),
  "known:rijksoverheid": known("https://www.rijksoverheid.nl/actueel/nieuws"),
  "journal-platform": () => discover("https://muse.jhu.edu/journal/10", { fetch: everywhereAFeed, now: NOW }),
  // The publisher's feed made from the ISSNs Crossref gave for a DOI; the same lookup offers Crossref's own list next to it.
  "journal-issn": () => doi(),
  "journal-ojs": () => {
    const pageUrl = "https://ojs.example/index.php/j/index";
    const articles = "https://ojs.example/index.php/j/gateway/plugin/WebFeedGatewayPlugin/atom";
    return discover(pageUrl, { fetch: site(pageUrl, `<html><head><title>The Journal</title><link rel="alternate" type="application/atom+xml" href="${articles}"></head></html>`, [articles, "https://ojs.example/index.php/j/gateway/plugin/AnnouncementFeedGatewayPlugin/atom"]).fetch, now: NOW });
  },
  wikidata: () => {
    const url = "https://blog.example.org/";
    const feed = "https://blog.example.org/odd/stream-9.rss";
    const search = wikidataSearchUrl(addressVariants(new URL(url)))!;
    const claim = (value: string) => ({ rank: "normal", mainsnak: { datavalue: { value } } });
    return discover(url, {
      fetch: stub({
        [url]: page(url, `<html><body>Nothing here</body></html>`),
        [search]: json(search, { query: { search: [{ title: "Q1" }] } }),
        [wikidataEntitiesUrl(["Q1"])]: json(wikidataEntitiesUrl(["Q1"]), { entities: { Q1: { claims: { P856: [claim(url)], P1019: [claim(feed)], P236: [] } } } }),
        [feed]: feedRes(feed),
      }).fetch,
      now: NOW,
    });
  },
  crossref: () => doi(),
  youtube: () => discover("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", { fetch: everywhereAFeed, now: NOW }),
  fediverse: () => {
    const wf = "https://mastodon.social/.well-known/webfinger?resource=acct%3AMastodon%40mastodon.social";
    return discover("@Mastodon@mastodon.social", {
      fetch: stub({
        [wf]: fakeResponse(wf, fixture("social/mastodon-webfinger.json"), "application/jrd+json"),
        "https://mastodon.social/@Mastodon": page("https://mastodon.social/@Mastodon", fixture("social/mastodon-profile.html")),
        "https://mastodon.social/@Mastodon.rss": fakeResponse("https://mastodon.social/@Mastodon.rss", fixture("social/mastodon.rss"), "application/rss+xml"),
      }).fetch,
      now: NOW,
    });
  },
  bluesky: () => discover("@bsky.app", { fetch: stub({ "https://bsky.app/profile/bsky.app/rss": fakeResponse("https://bsky.app/profile/bsky.app/rss", fixture("social/bluesky.rss"), "application/xml") }).fetch, now: NOW }),
  ...(Object.fromEntries(BRIDGE_SERVICES.map((s) => [`bridge:${s.id}`, bridged(s.id)])) as Record<Extract<Produced, `bridge:${string}`>, () => Promise<DiscoveryDraft>>),
  "script-feed": () => {
    const page = "https://www.rotterdam.nl/nieuws";
    return discover(page, { fetch: stub({ [page]: scriptsPage(page, "/_next/a.js"), "https://www.rotterdam.nl/_next/a.js": fakeResponse("x", `"/feed/rss/nieuws/"`, "application/javascript"), "https://www.rotterdam.nl/feed/rss/nieuws/": feedRes("https://www.rotterdam.nl/feed/rss/nieuws/") }).fetch, now: NOW });
  },
  "script-page": () => {
    const page = "https://www.rijksoverheid.nl/actueel/nieuws";
    const sibling = "https://www.rijksoverheid.nl/actueel";
    const listed = fixture("page-lists/anthropic-news.html");
    return discover(page, { fetch: stub({ [page]: page_(page, fixture("page-lists/rijksoverheid-nieuws.html").replace("<head>", `<head><script>window.__routes = { news: "/actueel/nieuws", overview: "/actueel", search: "/zoeken-nope" };</script>`)), [sibling]: page_(sibling, listed) }).fetch, now: NOW, bridge: router });
  },
  "page-list": () => {
    const url = "https://www.anthropic.com/news";
    const html = fixture("page-lists/anthropic-news.html");
    return discover(url, { fetch: site(url, html).fetch, now: NOW, bridge: router });
  },
};

/** A DOI whose journal is a Wiley one: the publisher's feed, and Crossref's own list through the router. */
function doi(): Promise<DiscoveryDraft> {
  const work = "https://api.crossref.org/works/10.1111%2Faman.70137";
  const feedUrl = "https://onlinelibrary.wiley.com/feed/15481433/most-recent";
  return discover("10.1111/aman.70137", {
    fetch: stub({
      [work]: json(work, { message: { publisher: "Wiley", "container-title": ["American Anthropologist"], "issn-type": [{ type: "print", value: "0002-7294" }, { type: "electronic", value: "1548-1433" }] } }),
      [feedUrl]: feedRes(feedUrl, "Wiley: American Anthropologist: Table of Contents"),
    }).fetch,
    bridge: router,
    now: NOW,
  });
}

test("every route of the list can be produced, and each candidate carries exactly the route that found it", async () => {
  assert.deepEqual(Object.keys(CASES).sort(), DISCOVERY_ROUTES.filter((r) => r !== "installation-news").sort(), "a case for each route of the list, and for no other");
  for (const [route, produce] of Object.entries(CASES)) {
    const found = await produce();
    assert.ok(found.ok, `${route}: ${JSON.stringify(found)}`);
    for (const c of found.candidates) assert.ok(isDiscoveryRoute(c.route), `${route}: ${JSON.stringify(c.route)} is no route`);
    assert.ok(found.candidates.some((c) => c.route === route), `${route}: the candidates came by ${found.candidates.map((c) => c.route).join(", ")}`);
  }
});

test("a route is one candidate's way and not the page's: the feeds found on one page by different ways each say theirs", async () => {
  const home = "https://example.org/";
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml"></head><body><a href="/podcast/rss.xml">Podcast RSS</a></body></html>`;
  const { fetch } = stub({
    [home]: page(home, html),
    "https://example.org/feed.xml": fakeResponse("https://example.org/feed.xml", rss("Posts", "https://example.org"), "application/rss+xml"),
    "https://example.org/podcast/rss.xml": fakeResponse("https://example.org/podcast/rss.xml", rss("Podcast", "https://example.org/pod"), "application/rss+xml"),
  });
  const found = await discover(home, { fetch, now: NOW });
  assert.ok(found.ok);
  assert.deepEqual(Object.fromEntries(found.candidates.map((c) => [c.feedUrl, c.route])), { "https://example.org/feed.xml": "alternate-link" });
  // The page advertises its own feed, so the link in the body is not asked for. Without the advertisement, the link is what found it.
  const bare = await discover(home, { fetch: stub({ [home]: page(home, `<html><body><a href="/podcast/rss.xml">Podcast RSS</a></body></html>`), "https://example.org/podcast/rss.xml": fakeResponse("https://example.org/podcast/rss.xml", rss("Podcast", "https://example.org/pod"), "application/rss+xml") }).fetch, now: NOW });
  assert.ok(bare.ok);
  assert.deepEqual(bare.candidates.map((c) => c.route), ["page-anchor"]);
});

test("the bridged routes are the catalogue's services, and an address that is a descriptor is found by its service's route", async () => {
  assert.deepEqual(DISCOVERY_ROUTES.filter((r) => r.startsWith("bridge:")).sort(), BRIDGE_SERVICES.map((s) => `bridge:${s.id}`).sort());
  const telegram = await discover("https://t.me/durov", { bridge: router, now: NOW });
  assert.ok(telegram.ok);
  assert.deepEqual(telegram.candidates.map((c) => [c.feedUrl, c.route]), [["bridge:telegram/durov", "bridge:telegram"]]);
});
