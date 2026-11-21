import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/copy/server";
import type { DraftCandidate } from "./discover.ts";
import { APPLE_NO_FEED, planKnownFeeds, resolveKnown } from "./known-feeds.ts";
import type { KnownDeps, KnownPlan, KnownProbe } from "./known-feeds.ts";
import type { ParsedFeed } from "./feed.ts";

const copy = server.sources.connectors;

const plan = (u: string) => planKnownFeeds(new URL(u));
const feedUrls = (u: string): string[] | null => {
  const p = plan(u);
  return p && "feeds" in p ? p.feeds.map((f) => f.feedUrl) : null;
};

test("Reddit is no known feed pattern: its feed addresses answer with nothing to follow", () => {
  for (const u of ["https://www.reddit.com/r/modeltrains/", "https://old.reddit.com/r/modeltrains", "https://www.reddit.com/user/spez/", "https://www.reddit.com/r/modeltrains/.rss"]) assert.equal(plan(u), null, u);
});

test("GitHub: a repository offers its Releases and Tags feeds, in that order", () => {
  for (const u of ["https://github.com/BurntSushi/ripgrep", "https://github.com/BurntSushi/ripgrep/", "https://github.com/BurntSushi/ripgrep/issues", "https://github.com/BurntSushi/ripgrep.git", "https://github.com/BurntSushi/ripgrep/tree/master/crates"]) {
    assert.deepEqual(feedUrls(u), ["https://github.com/BurntSushi/ripgrep/releases.atom", "https://github.com/BurntSushi/ripgrep/tags.atom"], u);
  }
  assert.equal(plan("https://github.com/orgs/foo/people"), null);
  assert.equal(plan("https://github.com/marketplace/actions"), null);
  assert.equal(plan("https://github.com/BurntSushi/ripgrep/releases.atom"), null, "a feed address is a feed");
});

test("GitHub: a user or organisation page offers its public activity; site pages are not accounts", () => {
  for (const u of ["https://github.com/torvalds", "https://github.com/torvalds/", "https://github.com/torvalds?tab=repositories", "https://www.github.com/vercel"]) {
    const p = plan(u);
    assert.ok(p && "feeds" in p, u);
    assert.deepEqual(p.feeds.map((f) => [f.feedUrl, f.title, f.via, f.origin]), [[`https://github.com/${/torvalds/.test(u) ? "torvalds" : "vercel"}.atom`, copy.known.activity(/torvalds/.test(u) ? "torvalds" : "vercel"), copy.labels.activityFeed, copy.known.githubActivity]], u);
  }
  for (const u of ["https://github.com/about", "https://github.com/settings", "https://github.com/search?q=x", "https://github.com/explore", "https://github.com/features", "https://github.com/pricing", "https://github.com/login", "https://github.com/torvalds.atom", "https://github.com/-bad", "https://github.com/"]) {
    assert.equal(plan(u), null, u);
  }
});

const only = (u: string) => {
  const p = plan(u);
  return p && "feeds" in p ? p.feeds.map((f) => [f.feedUrl, f.title ?? null, f.via ?? null, f.origin ?? null]) : null;
};

test("Steam, arXiv, Dailymotion, Odysee, DeviantArt, Behance: a profile or page address becomes the service's feed address", () => {
  assert.deepEqual(only("https://store.steampowered.com/app/730/CounterStrike_2/"), [["https://store.steampowered.com/feeds/news/app/730/", copy.services.steamNews("CounterStrike 2"), copy.labels.postsFeed, copy.services.steamOrigin]]);
  assert.deepEqual(only("https://store.steampowered.com/app/730"), [["https://store.steampowered.com/feeds/news/app/730/", copy.services.steamNews(copy.services.steamApp("730")), copy.labels.postsFeed, copy.services.steamOrigin]]);
  assert.deepEqual(only("https://arxiv.org/list/cs.LG/recent"), [["https://rss.arxiv.org/rss/cs.LG", null, copy.labels.postsFeed, copy.services.arxivOrigin]]);
  assert.deepEqual(only("https://arxiv.org/list/quant-ph/new"), [["https://rss.arxiv.org/rss/quant-ph", null, copy.labels.postsFeed, copy.services.arxivOrigin]]);
  assert.deepEqual(only("https://arxiv.org/list/cs/25"), [["https://rss.arxiv.org/rss/cs", null, copy.labels.postsFeed, copy.services.arxivOrigin]]);
  assert.deepEqual(only("https://www.dailymotion.com/dailymotion"), [["https://www.dailymotion.com/rss/user/dailymotion", copy.services.dailymotionTitle("dailymotion"), copy.labels.channelFeed, copy.services.dailymotionOrigin]]);
  assert.deepEqual(only("https://odysee.com/@veritasium:f"), [["https://odysee.com/$/rss/@veritasium:f", null, copy.labels.channelFeed, copy.services.odyseeOrigin]]);
  assert.deepEqual(only("https://odysee.com/@Odysee%3A8/some-video:3"), [["https://odysee.com/$/rss/@Odysee:8", null, copy.labels.channelFeed, copy.services.odyseeOrigin]]);
  assert.deepEqual(only("https://www.deviantart.com/spyed"), [["https://backend.deviantart.com/rss.xml?q=gallery:spyed", null, copy.labels.galleryFeed, copy.services.deviantartOrigin]]);
  assert.deepEqual(only("https://www.deviantart.com/spyed/gallery"), [["https://backend.deviantart.com/rss.xml?q=gallery:spyed", null, copy.labels.galleryFeed, copy.services.deviantartOrigin]]);
  assert.deepEqual(only("https://www.deviantart.com/spyed/gallery/all"), [["https://backend.deviantart.com/rss.xml?q=gallery:spyed", null, copy.labels.galleryFeed, copy.services.deviantartOrigin]]);
  assert.deepEqual(only("https://www.behance.net/behance"), [["https://www.behance.net/feeds/user?username=behance", null, copy.labels.projectsFeed, copy.services.behanceOrigin]]);
  assert.deepEqual(only("https://behance.net/adamthompson/"), [["https://www.behance.net/feeds/user?username=adamthompson", null, copy.labels.projectsFeed, copy.services.behanceOrigin]]);
});

test("NOS: its front, news and sport pages and their sections become the feeds on feeds.nos.nl, and nothing else on nos.nl is claimed", () => {
  const feed = (name: string, title: string) => [[`https://feeds.nos.nl/${name}`, title, copy.labels.postsFeed, "NOS"]];
  for (const u of ["https://nos.nl/", "https://nos.nl", "https://www.nos.nl/", "https://nos.nl/nieuws", "https://nos.nl/nieuws/", "https://nos.nl/nieuws/laatste"]) assert.deepEqual(only(u), feed("nosnieuwsalgemeen", "NOS Nieuws"), u);
  for (const u of ["https://nos.nl/sport", "https://nos.nl/sport/laatste"]) assert.deepEqual(only(u), feed("nossportalgemeen", "NOS Sport"), u);
  assert.deepEqual(only("https://nos.nl/sport/voetbal"), feed("nosvoetbal", "NOS Voetbal"));
  assert.deepEqual(only("https://nos.nl/nieuws/binnenland"), feed("nosnieuwsbinnenland", "NOS Binnenland"));
  assert.deepEqual(only("https://nos.nl/nieuws/economie"), feed("nosnieuwseconomie", "NOS Economie"));
  for (const u of ["https://nos.nl/artikel/2600000-een-verhaal", "https://nos.nl/video/2600000-een-filmpje", "https://nos.nl/zoeken?q=x", "https://nos.nl/sport/tennis", "https://nos.nl/over-nos", "https://nos.example/nieuws", "https://feeds.nos.nl/nosnieuwsalgemeen", "https://nos.nl/nieuws/laatste/extra"]) {
    assert.equal(plan(u), null, u);
  }
});

test("BBC: a news or sport section and a language service become their feed on feeds.bbci.co.uk; articles, live pages and the front page do not", () => {
  const feed = (path: string) => [[`https://feeds.bbci.co.uk/${path}/rss.xml`, null, copy.labels.postsFeed, "BBC"]];
  assert.deepEqual(only("https://www.bbc.com/news/technology"), feed("news/technology"));
  assert.deepEqual(only("https://www.bbc.co.uk/news/world/europe/"), feed("news/world/europe"));
  assert.deepEqual(only("https://bbc.com/sport/football"), feed("sport/football"));
  assert.deepEqual(only("https://www.bbc.com/News"), feed("news"));
  assert.deepEqual(only("https://www.bbc.com/mundo"), feed("mundo"));
  for (const u of ["https://www.bbc.com/", "https://www.bbc.com/news/articles/c4g0m2kn8w3o", "https://www.bbc.co.uk/news/technology-68623121", "https://www.bbc.com/news/live/c1abc", "https://www.bbc.co.uk/iplayer", "https://www.bbc.com/news/topics/c1234", "https://www.bbc.com/a/b/c/d/e", "https://bbc.example/news"]) {
    assert.equal(plan(u), null, u);
  }
});

test("the European Commission's Press Corner becomes the press releases feed its own script reads, in the address's language", () => {
  const feed = (language: string) => [[`https://ec.europa.eu/commission/presscorner/api/rss?language=${language}`, "European Commission Press Corner", copy.labels.postsFeed, "European Commission"]];
  assert.deepEqual(only("https://ec.europa.eu/commission/presscorner/home/en"), feed("en"));
  assert.deepEqual(only("https://ec.europa.eu/commission/presscorner/home/nl"), feed("nl"));
  assert.deepEqual(only("https://ec.europa.eu/commission/presscorner/detail/de/ip_26_1234"), feed("de"));
  assert.deepEqual(only("https://ec.europa.eu/commission/presscorner/"), feed("en"));
  for (const u of ["https://ec.europa.eu/", "https://ec.europa.eu/eurostat/news", "https://commission.europa.eu/commission/presscorner/home/en"]) assert.equal(plan(u), null, u);
});

test("Rijksoverheid: the front and news pages become the news search feed its RSS button makes", () => {
  const url = "https://www.rijksoverheid.nl/api/rss?query=%7B%22filters%22%3A%5B%7B%22field%22%3A%22content_type%22%2C%22values%22%3A%5B%22pro%3AnewsDocument%22%5D%2C%22type%22%3A%22all%22%7D%5D%2C%22resultSearchTerm%22%3A%22%22%2C%22pageTitle%22%3A%22Nieuws%22%7D";
  for (const u of ["https://www.rijksoverheid.nl/", "https://rijksoverheid.nl", "https://www.rijksoverheid.nl/actueel", "https://www.rijksoverheid.nl/actueel/nieuws"]) {
    assert.deepEqual(only(u), [[url, "Rijksoverheid Nieuws", copy.labels.postsFeed, "Rijksoverheid"]], u);
  }
  for (const u of ["https://www.rijksoverheid.nl/actueel/nieuws/2026/11/21/vogelgriep", "https://www.rijksoverheid.nl/onderwerpen/x", "https://www.rijksoverheid.nl/api/rss?query=x"]) assert.equal(plan(u), null, u);
});

test("those services' site pages, other pages and bare names are not turned into feeds", () => {
  for (const u of [
    "https://store.steampowered.com/", "https://store.steampowered.com/search/?term=x", "https://store.steampowered.com/app/abc/", "https://store.steampowered.com/news/app/730", "https://steamcommunity.com/app/730",
    "https://arxiv.org/abs/2511.00001", "https://arxiv.org/list/", "https://arxiv.org/list/cs.LG%2Fbad/new", "https://arxiv.org/",
    "https://www.dailymotion.com/", "https://www.dailymotion.com/video/x8abc", "https://www.dailymotion.com/playlist/x9abc", "https://www.dailymotion.com/search/cats", "https://www.dailymotion.com/fr", "https://www.dailymotion.com/dailymotion/videos",
    "https://odysee.com/", "https://odysee.com/@veritasium", "https://odysee.com/$/rss/@veritasium:f", "https://odysee.com/video-slug:3", "https://odysee.com/$/discover",
    "https://www.deviantart.com/", "https://www.deviantart.com/tag/cats", "https://www.deviantart.com/search?q=x", "https://www.deviantart.com/watch/deviations", "https://www.deviantart.com/about", "https://www.deviantart.com/spyed/art/Some-Work-123", "https://www.deviantart.com/spyed/gallery/12345/folder", "https://www.deviantart.com/spyed/favourites",
    "https://www.behance.net/", "https://www.behance.net/search/projects?search=x", "https://www.behance.net/gallery/123456/Some-Project", "https://www.behance.net/about", "https://www.behance.net/joblist", "https://www.behance.net/feeds/projects", "https://www.behance.net/behance/projects",
  ]) {
    assert.equal(plan(u), null, u);
  }
});

test("PeerTube: an account or channel page on any domain becomes that instance's feed for it; other /c/ and /a/ pages are not claimed", () => {
  assert.deepEqual(only("https://framatube.org/a/framasoft/video-channels"), [["https://framatube.org/feeds/videos.xml?accountName=framasoft", null, copy.labels.channelFeed, copy.services.peertubeAccountOrigin]]);
  assert.deepEqual(only("https://framatube.org/a/framasoft"), [["https://framatube.org/feeds/videos.xml?accountName=framasoft", null, copy.labels.channelFeed, copy.services.peertubeAccountOrigin]]);
  assert.deepEqual(only("https://video.blender.org/c/blender_open_movies/videos"), [["https://video.blender.org/feeds/videos.xml?videoChannelName=blender_open_movies", null, copy.labels.channelFeed, copy.services.peertubeChannelOrigin]]);
  assert.deepEqual(only("https://peertube.example.net:8443/c/Some.Chan"), [["https://peertube.example.net:8443/feeds/videos.xml?videoChannelName=Some.Chan", null, copy.labels.channelFeed, copy.services.peertubeChannelOrigin]]);
  assert.deepEqual(only("https://tilvids.com/c/news@other.example/video-playlists"), [["https://tilvids.com/feeds/videos.xml?videoChannelName=news%40other.example", null, copy.labels.channelFeed, copy.services.peertubeChannelOrigin]]);
  for (const u of ["https://meta.discourse.org/c/support/9", "https://example.com/c/", "https://example.com/a/", "https://example.com/a/x/y/z", "https://example.com/c/x/9", "https://example.com/blog/c/x", "https://example.com/feeds/videos.xml?accountName=x", "https://mastodon.social/@someone"]) {
    assert.equal(plan(u), null, u);
  }
});

test("a feed counts only if it is the one asked for: PeerTube's generator, a gallery that has entries, an empty arXiv day is still a feed", async () => {
  const withGenerator = (generator: string | null, items = 1) => ({ title: "T", generator, items: Array.from({ length: items }, () => ({})) }) as unknown as ParsedFeed;
  const peer = plan("https://framatube.org/a/framasoft") as Extract<KnownPlan, { feeds: unknown }>;
  const peerUrl = peer.feeds[0]!.feedUrl;
  const real = await resolveKnown(peer, deps({ [peerUrl]: { feedUrl: peerUrl, parsed: withGenerator("PeerTube - https://framatube.org") } }), PAGE);
  assert.ok(real && "candidates" in real);
  assert.equal(real.candidates[0]!.feedUrl, peerUrl);
  for (const generator of [null, "WordPress", "Not PeerTube"]) {
    assert.equal(await resolveKnown(peer, deps({ [peerUrl]: { feedUrl: peerUrl, parsed: withGenerator(generator) } }), PAGE), null, `generator ${generator}`);
  }
  const art = plan("https://www.deviantart.com/nobody-here") as Extract<KnownPlan, { feeds: unknown }>;
  const artUrl = art.feeds[0]!.feedUrl;
  assert.equal(await resolveKnown(art, deps({ [artUrl]: { feedUrl: artUrl, parsed: withGenerator("DeviantArt.com", 0) } }), PAGE), null, "an empty gallery is how an unknown name answers");
  const known = await resolveKnown(art, deps({ [artUrl]: { feedUrl: artUrl, parsed: withGenerator("DeviantArt.com", 3) } }), PAGE);
  assert.ok(known && "candidates" in known);
  const arxiv = plan("https://arxiv.org/list/cs.LG/recent") as Extract<KnownPlan, { feeds: unknown }>;
  const arxivUrl = arxiv.feeds[0]!.feedUrl;
  const sunday = await resolveKnown(arxiv, deps({ [arxivUrl]: { feedUrl: arxivUrl, parsed: withGenerator(null, 0) } }), PAGE);
  assert.ok(sunday && "candidates" in sunday);
  assert.equal(sunday.candidates[0]!.note, copy.services.arxivEmptyNote);
  const monday = await resolveKnown(arxiv, deps({ [arxivUrl]: { feedUrl: arxivUrl, parsed: withGenerator(null, 4) } }), PAGE);
  assert.ok(monday && "candidates" in monday);
  assert.equal(monday.candidates[0]!.note, undefined, "the note is only for an empty day");
});

test("Apple Podcasts: a show link is looked up by its id (and store), not scraped", () => {
  const p = plan("https://podcasts.apple.com/nl/podcast/de-dagelijkse-podcast/id1234567890?i=1000");
  assert.deepEqual(p, { service: "Apple Podcasts", lookup: { id: "1234567890", country: "nl" } });
  assert.deepEqual(plan("https://podcasts.apple.com/podcast/id1234567890"), { service: "Apple Podcasts", lookup: { id: "1234567890", country: null } });
  assert.equal(plan("https://podcasts.apple.com/us/browse"), null);
  assert.equal(plan("https://podcasts.apple.com/us/podcast/no-id"), null);
});

test("blog and publishing services map to their known feed paths", () => {
  const cases: [string, string][] = [
    ["https://astralcodexten.substack.com/", "https://astralcodexten.substack.com/feed"],
    ["https://astralcodexten.substack.com/p/some-post", "https://astralcodexten.substack.com/feed"],
    ["https://medium.com/@someone", "https://medium.com/feed/@someone"],
    ["https://medium.com/@someone/a-story-1a2b3c", "https://medium.com/feed/@someone"],
    ["https://medium.com/netflix-techblog", "https://medium.com/feed/netflix-techblog"],
    ["https://netflixtechblog.medium.com/", "https://netflixtechblog.medium.com/feed"],
    ["https://staff.tumblr.com/", "https://staff.tumblr.com/rss"],
    ["https://www.tumblr.com/staff", "https://staff.tumblr.com/rss"],
    ["https://buzz.blogspot.com/", "https://buzz.blogspot.com/feeds/posts/default"],
    ["https://buzz.blogspot.co.uk/2020/01/post.html", "https://buzz.blogspot.co.uk/feeds/posts/default"],
    ["https://en-blog.wordpress.com/", "https://en-blog.wordpress.com/feed/"],
    ["https://vimeo.com/staff", "https://vimeo.com/staff/videos/rss"],
    ["https://vimeo.com/channels/staffpicks", "https://vimeo.com/channels/staffpicks/videos/rss"],
    ["https://www.pinterest.com/someone/recipes/", "https://www.pinterest.com/someone/recipes.rss"],
    ["https://www.pinterest.com/someone/", "https://www.pinterest.com/someone/feed.rss"],
  ];
  for (const [page, feed] of cases) assert.deepEqual(feedUrls(page), [feed], page);
  // A category, tag, author or label page names its own feed first, then the whole blog's.
  assert.deepEqual(feedUrls("https://writer.wordpress.com/category/science/"), ["https://writer.wordpress.com/category/science/feed/", "https://writer.wordpress.com/feed/"]);
  assert.deepEqual(feedUrls("https://writer.wordpress.com/category/science/page/2/"), ["https://writer.wordpress.com/category/science/feed/", "https://writer.wordpress.com/feed/"]);
  assert.deepEqual(feedUrls("https://writer.wordpress.com/category/parent/child"), ["https://writer.wordpress.com/category/parent/child/feed/", "https://writer.wordpress.com/feed/"]);
  assert.deepEqual(feedUrls("https://writer.wordpress.com/tag/mud/"), ["https://writer.wordpress.com/tag/mud/feed/", "https://writer.wordpress.com/feed/"]);
  assert.deepEqual(feedUrls("https://writer.wordpress.com/author/jo/"), ["https://writer.wordpress.com/author/jo/feed/", "https://writer.wordpress.com/feed/"]);
  assert.deepEqual(feedUrls("https://writer.wordpress.com/category/"), ["https://writer.wordpress.com/feed/"], "no category named");
  assert.deepEqual(feedUrls("https://buzz.blogspot.com/search/label/Tips"), ["https://buzz.blogspot.com/feeds/posts/default/-/Tips", "https://buzz.blogspot.com/feeds/posts/default"]);
  for (const u of ["https://www.substack.com/", "https://substack.com/@someone", "https://medium.com/feed/@someone", "https://medium.com/", "https://www.tumblr.com/dashboard", "https://vimeo.com/123456789", "https://vimeo.com/watch", "https://www.pinterest.com/pin/123/"]) {
    assert.equal(plan(u), null, u);
  }
  // Mastodon and Bluesky belong to their own connector.
  for (const u of ["https://mastodon.social/@someone", "https://bsky.app/profile/someone.bsky.social"]) assert.equal(plan(u), null, u);
});

const PAGE = "https://example.org/";
const feed = { title: "T", items: [] } as unknown as ParsedFeed;
const draft = (feedUrl: string, extra: { title?: string; via?: string; origin?: string; note?: string } = {}): DraftCandidate => ({
  title: extra.title ?? "T", kind: "feed", origin: extra.origin ?? server.words.rssFeed, via: extra.via ?? copy.labels.postsFeed, feedUrl, siteUrl: null, cadence: null, samples: [], summariesOnly: false, alreadyFollowingSourceId: null, privateWarning: null,
  ...(extra.note ? { note: extra.note } : {}),
});
const deps = (probes: Record<string, KnownProbe>, json?: KnownDeps["json"]): KnownDeps => ({
  probe: async (u) => probes[u] ?? { failed: null, inconclusive: false },
  json: json ?? (async () => ({ ok: false, reason: "unreachable", message: "no" })),
  candidate: (u, _p, extra) => draft(u, extra),
});

test("a service that did not answer keeps its trouble for ordinary discovery; a missing feed falls through; a private one is refused", async () => {
  const p = plan("https://github.com/a/b") as Extract<KnownPlan, { feeds: unknown }>;
  const url = p.feeds[0]!.feedUrl;
  const blocked = await resolveKnown(p, deps({ [url]: { failed: { reason: "blocked", message: "private" }, inconclusive: false } }), PAGE);
  assert.deepEqual(blocked, { failure: { reason: "blocked", message: "private" } });
  const ok = await resolveKnown(p, deps({ [url]: { feedUrl: url, parsed: feed } }), PAGE);
  assert.ok(ok && "candidates" in ok);
  // Nothing is offered for feeds that did not answer, but the trouble is kept for ordinary discovery.
  assert.deepEqual(await resolveKnown(p, deps({ [p.feeds[0]!.feedUrl]: { failed: { reason: "timeout", message: "t" }, inconclusive: true } }), PAGE), { trouble: { timeout: true, busy: false } });
  assert.deepEqual(await resolveKnown(p, deps({ [p.feeds[1]!.feedUrl]: { failed: { reason: "unreachable", message: "429" }, inconclusive: true } }), PAGE), { trouble: { timeout: false, busy: true } });
  assert.equal(await resolveKnown(p, deps({ [p.feeds[0]!.feedUrl]: { failed: { reason: "unreachable", message: "404" }, inconclusive: false } }), PAGE), null, "a plain 404 is no trouble");
});

test("BBC: a section's feed is named by its description, since every section's feed is titled BBC News or BBC Sport", async () => {
  const p = plan("https://www.bbc.com/news/technology") as Extract<KnownPlan, { feeds: unknown }>;
  const url = p.feeds[0]!.feedUrl;
  const named = async (title: string, description: string | null) => {
    const r = await resolveKnown(p, deps({ [url]: { feedUrl: url, parsed: { ...feed, title, description } } }), PAGE);
    return r && "candidates" in r ? r.candidates[0]!.title : null;
  };
  assert.equal(await named("BBC News", "BBC News - Technology"), "BBC News – Technology");
  assert.equal(await named("BBC Mundo", "BBC Mundo - Noticias - BBC News Mundo"), "T", "left to the feed's own title");
  assert.equal(await named("BBC News", null), "T");
});

test("Apple Podcasts: the lookup's feed address is fetched like any feed; no public feed says so", async () => {
  const p = plan("https://podcasts.apple.com/nl/podcast/x/id1234567890")!;
  const seen: string[] = [];
  const json = async (u: string) => {
    seen.push(u);
    return { ok: true as const, data: { resultCount: 1, results: [{ feedUrl: "https://feeds.example.net/show.xml" }] } };
  };
  const ok = await resolveKnown(p, deps({ "https://feeds.example.net/show.xml": { feedUrl: "https://feeds.example.net/show.xml", parsed: feed } }, json), PAGE);
  assert.deepEqual(seen, ["https://itunes.apple.com/lookup?id=1234567890&entity=podcast&country=nl"]);
  assert.ok(ok && "candidates" in ok);
  assert.equal(ok.candidates[0]!.feedUrl, "https://feeds.example.net/show.xml");
  assert.equal(ok.candidates[0]!.via, copy.labels.podcastFeed);
  const none = await resolveKnown(p, deps({}, async () => ({ ok: true, data: { resultCount: 1, results: [{ collectionName: "x" }] } })), PAGE);
  assert.deepEqual(none, { failure: { reason: "unsupported", message: APPLE_NO_FEED } });
  const javascript = await resolveKnown(p, deps({}, async () => ({ ok: true, data: { results: [{ feedUrl: "javascript:alert(1)" }] } })), PAGE);
  assert.deepEqual(javascript, { failure: { reason: "unsupported", message: APPLE_NO_FEED } });
  const timeout = await resolveKnown(p, deps({}, async () => ({ ok: false, reason: "timeout", message: "slow" })), PAGE);
  assert.deepEqual(timeout, { failure: { reason: "timeout", message: "slow" } });
});
