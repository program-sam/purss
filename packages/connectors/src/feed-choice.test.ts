import assert from "node:assert/strict";
import { test } from "node:test";
import { coreName, isDiscourse, isGenericTitle, isSiteWideFeed, linkMatchesPage, nameFeed, orderByVia, probeLandedOnName, rankByPage, sameName, sectionFeedName, sectionFeedPaths, sectionPath, siteNameFor, tidyFeedName, withoutCommentFeeds } from "./feed-choice.ts";

test("a feed that calls itself 'Feed' or 'Nieuws' is named after the site", () => {
  const host = "rtvutrecht.nl";
  assert.equal(nameFeed({ feedTitle: "Nieuws", siteName: "RTV Utrecht", host }), "RTV Utrecht – Nieuws");
  assert.equal(nameFeed({ feedTitle: "News", siteName: "The Example", host }), "The Example – News");
  assert.equal(nameFeed({ feedTitle: "Posts", siteName: null, host }), "rtvutrecht.nl – Posts");
  assert.equal(nameFeed({ feedTitle: "Feed", siteName: "Dan's Blog", host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "» Feed", siteName: "Dan's Blog", host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "RSS", linkTitle: "Dan's Blog » Feed", siteName: null, host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "", linkTitle: "Dan's Blog - RSS", siteName: "Other", host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "Comments for Frontpage", siteName: "Site", host }), "Frontpage – comments");
  assert.equal(nameFeed({ feedTitle: "Comments on: Frontpage", siteName: "Site", host }), "Frontpage – comments");
  assert.equal(nameFeed({ feedTitle: "", siteName: null, host }), host);
  assert.equal(nameFeed({ feedTitle: "Dan Luu", siteName: "Other Site", host }), "Dan Luu");
  assert.equal(nameFeed({ feedTitle: "Nieuws", siteName: "RTV Utrecht Nieuws", host }), "RTV Utrecht Nieuws", "a name that already says it is not doubled");
  for (const t of ["Feed", "» Feed", "RSS", "Posts", "Nieuws", "News", "Blog", "RSS 2.0"]) assert.ok(isGenericTitle(t), t);
  for (const t of ["Dan Luu", "NOS Nieuws Algemeen", "The Feed Reader Blog"]) assert.ok(!isGenericTitle(t), t);
});

test("the site's name comes from what the page says about itself", () => {
  assert.equal(siteNameFor({ siteName: "NOS.nl", title: "NOS.nl - Nieuws, Sport en Evenementen | Nederlandse Omroep Stichting" }, "https://nos.nl/"), "NOS.nl");
  assert.equal(siteNameFor({ siteName: null, title: "Het laatste nieuws uit de regio - RTV Utrecht" }, "https://www.rtvutrecht.nl/"), "RTV Utrecht");
  assert.equal(siteNameFor({ siteName: null, title: "France | The Guardian" }, "https://www.theguardian.com/world/france"), "The Guardian");
  assert.equal(siteNameFor({ siteName: null, title: "Home" }, "https://example.org/"), null);
  assert.equal(siteNameFor({ siteName: null, title: null }, "https://example.org/"), null);
  assert.equal(siteNameFor({ siteName: null, title: "Brand | Some tagline here" }, "https://unrelated.example/"), "Brand", "a front page leads with its brand");
  assert.equal(siteNameFor({ siteName: null, title: "Some section | Brand" }, "https://unrelated.example/section/a"), "Brand", "a section page ends with it");
});

test("sections: which pages are one, where their own feed would be, and what counts as site-wide", () => {
  for (const u of ["https://x.example/", "https://x.example", "https://x.example/index.html", "https://x.example/nl/", "https://x.example/en-gb"]) assert.equal(sectionPath(u), null, u);
  assert.equal(sectionPath("https://www.theguardian.com/world/france"), "/world/france");
  assert.equal(sectionPath("https://x.example/news/story.html"), "/news/story");
  assert.deepEqual(sectionFeedPaths("/world/france").slice(0, 2), ["/world/france/rss", "/world/france/feed"]);

  const page = "https://www.theguardian.com/world/france";
  assert.ok(isSiteWideFeed("https://www.theguardian.com/rss", page));
  assert.ok(isSiteWideFeed("https://theguardian.com/feed/", page));
  assert.ok(isSiteWideFeed("https://www.theguardian.com/?feed=rss2", page));
  assert.ok(!isSiteWideFeed("https://www.theguardian.com/world/france/rss", page), "the section's own feed");
  assert.ok(!isSiteWideFeed("https://feeds.example.net/rss", page), "another host is the page's own say-so");
  assert.ok(!isSiteWideFeed("https://www.theguardian.com/rss", "https://www.theguardian.com/"), "on the front page the site feed is the page's feed");
});

test("comment feeds are dropped when anything else exists; the order puts posts first", () => {
  const c = (via: string) => ({ via });
  assert.deepEqual(withoutCommentFeeds([c("Posts feed"), c("Comments feed")]).map((x) => x.via), ["Posts feed"]);
  assert.deepEqual(withoutCommentFeeds([c("Comments feed")]).map((x) => x.via), ["Comments feed"]);
  assert.deepEqual(
    orderByVia([c("Comments feed"), c("Whole site feed"), c("Section feed"), c("All replies"), c("Posts feed"), c("Latest topics")]).map((x) => x.via),
    ["Latest topics", "Posts feed", "Section feed", "Whole site feed", "All replies", "Comments feed"],
  );
  assert.ok(isDiscourse(`<meta name="generator" content="Discourse 3.3.0.beta3 - https://github.com/discourse/discourse">`));
  assert.ok(isDiscourse(`<meta content="Discourse 3" name="generator">`));
  assert.ok(!isDiscourse(`<meta name="generator" content="WordPress 6.4">`));
});

test("machine titles lose the machine words: RSS and version tags, 'Subscribe via RSS', GitHub's 'Release notes from'", () => {
  const host = "example.org";
  for (const [raw, tidy] of [
    ["QC RSS v2", "QC"],
    ["BBC Sport RSS feed", "BBC Sport"],
    ["Nature - RSS 2.0", "Nature"],
    ["Foo (RSS)", "Foo"],
    ["Foo Atom feed", "Foo"],
    ["Subscribe via RSS", ""],
    ["Subscribe to Nature", "Nature"],
    ["RSS feed for Kottke", "Kottke"],
    ["Release notes from node", "node releases"],
    ["Tags from sqlite", "sqlite tags"],
  ] as const) assert.equal(tidyFeedName(raw), tidy, raw);
  // Names that merely contain the words, or end in them as part of the name, stay as they are.
  for (const keep of ["The Atom", "Atom Heart Mother", "Feed Me", "RSS Is Dead", "Release Notes", "Reader"]) assert.equal(tidyFeedName(keep), keep, keep);

  assert.equal(nameFeed({ feedTitle: "QC RSS v2", siteName: "Questionable Content", host }), "Questionable Content", "an abbreviation is replaced by the site's own name");
  assert.equal(nameFeed({ feedTitle: "QC RSS v2", siteName: null, host }), "QC", "without a better name, the tidied one");
  assert.equal(nameFeed({ feedTitle: "BBC Sport RSS feed", siteName: "BBC Sport", host }), "BBC Sport");
  assert.equal(nameFeed({ feedTitle: "Subscribe via RSS", siteName: "Dan's Blog", host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "Subscribe via RSS", linkTitle: "Dan's Blog", siteName: null, host }), "Dan's Blog");
  assert.equal(nameFeed({ feedTitle: "Subscribe via RSS", siteName: null, host }), host);
  assert.equal(nameFeed({ feedTitle: "Release notes from node", siteName: "GitHub", host: "github.com" }), "node releases");
});

test("a section's feed that is named after the site alone is named after the section too", () => {
  assert.equal(sectionFeedName("Liverpool - Football - BBC Sport", "BBC Sport"), "BBC Sport – Liverpool");
  assert.equal(sectionFeedName("France | The Guardian", "The Guardian"), "The Guardian – France");
  assert.equal(sectionFeedName("BBC Sport", "BBC Sport"), null);
  assert.equal(sectionFeedName("News - BBC Sport", "BBC Sport"), null, "a bare section word says nothing more");
  assert.equal(sectionFeedName(null, "BBC Sport"), null);
  assert.ok(sameName("BBC  Sport", "bbc-sport"));
  assert.ok(!sameName("", ""));
});

test("sources are compared by the part of the name that says what they are", () => {
  assert.equal(coreName("Football Weekly | The Guardian"), coreName("Football Weekly"));
  assert.equal(coreName("Football Weekly – podcast"), coreName("football weekly"));
  assert.notEqual(coreName("Football Weekly Extra"), coreName("Football Weekly"));
  assert.equal(coreName("r/modeltrains"), "rmodeltrains");
  assert.equal(coreName("  "), "");
});

test("which listed feed is the page's own: by its name, or by the last part of the page's address", () => {
  const page = { url: "https://journals.rcni.com/journal/ns", title: "Nursing Standard" };
  const feeds = [
    { url: "https://journals.rcni.com/feeds/cnp", title: "Cancer Nursing Practice" },
    { url: "https://journals.rcni.com/feeds/ns", title: "Nursing Standard" },
    { url: "https://journals.rcni.com/feeds/en", title: "Emergency Nurse" },
  ];
  assert.deepEqual(feeds.map((f) => linkMatchesPage(f, page)), [false, true, false]);
  assert.deepEqual(rankByPage(feeds, page).map((f) => f.title), ["Nursing Standard", "Cancer Nursing Practice", "Emergency Nurse"], "the page's own first, the rest in their order");
  // By address alone, when the feed names itself otherwise.
  assert.ok(linkMatchesPage({ url: "https://example.org/feeds/ns", title: "RCNi" }, page));
  // A front page has no part to match; a generic word is not a match.
  assert.ok(!linkMatchesPage({ url: "https://example.org/feeds/ns", title: null }, { url: "https://example.org/", title: "Example" }));
  assert.ok(!linkMatchesPage({ url: "https://example.org/rss.xml", title: null }, { url: "https://example.org/rss", title: null }));
  // Words of the feed's address must match whole, not as a piece of a longer word.
  assert.ok(!linkMatchesPage({ url: "https://example.org/feeds/cnsx", title: null }, page));
  assert.ok(linkMatchesPage({ url: "https://example.org/liverpool/rss.xml", title: null }, { url: "https://www.bbc.co.uk/sport/football/teams/liverpool", title: "Liverpool - BBC Sport" }));
});

test("a page whose address ends in a several-word slug matches the feed with the same words in its address", () => {
  const page = { url: "https://journals.example/journal/nursing-standard", title: "RCNi" };
  const feeds = [
    { url: "https://journals.example/feeds/cancer-nursing-practice", title: "Cancer Nursing Practice" },
    { url: "https://journals.example/feeds/nursing-standard", title: null },
    { url: "https://journals.example/rss?journal=nursing_standard", title: null },
    { url: "https://journals.example/feeds/standard", title: null },
    { url: "https://journals.example/feeds/nursing", title: null },
    { url: "https://journals.example/feeds/standard-nursing", title: null },
  ];
  assert.deepEqual(feeds.map((f) => linkMatchesPage(f, page)), [false, true, true, false, false, false], "the words in this order, whole, next to each other");
  assert.equal(rankByPage(feeds, page)[0]!.url, "https://journals.example/feeds/nursing-standard");
  // One word still matches as before; a slug of only generic words matches nothing.
  assert.ok(linkMatchesPage({ url: "https://example.org/feeds/ns", title: null }, { url: "https://example.org/journal/ns", title: null }));
  assert.ok(!linkMatchesPage({ url: "https://example.org/feeds/rss", title: null }, { url: "https://example.org/rss-feeds", title: null }));
});

test("PeerTube's feed of the whole instance is site-wide from a section page; an account's or channel's feed is not", () => {
  const page = "https://framatube.org/a/framasoft/video-channels";
  assert.ok(isSiteWideFeed("https://framatube.org/feeds/videos.xml", page));
  assert.ok(!isSiteWideFeed("https://framatube.org/feeds/videos.xml?accountName=framasoft", page));
  assert.ok(!isSiteWideFeed("https://framatube.org/feeds/videos.xml?videoChannelName=non_frama", page));
  assert.ok(!isSiteWideFeed("https://framatube.org/feeds/videos.xml", "https://framatube.org/"), "on the front page it is the page's feed");
});

test("a conventional address that ends at a thing the site looked up by that word is not the site's feed", () => {
  const lookup: [string, string][] = [
    ["https://www.behance.net/atom.xml", "https://www.behance.net/feeds/user?username=atom"],
    ["https://www.behance.net/feed.xml", "https://www.behance.net/feeds/user?username=feed"],
    ["https://www.behance.net/index.xml", "https://www.behance.net/feeds/user?username=index"],
    ["https://example.org/rss", "https://example.org/users/rss"],
    ["https://example.org/rss.xml", "https://example.org/people/rss/posts.xml"],
    ["https://example.org/atom", "https://example.org/@atom"],
    ["https://example.org/world/rss", "https://example.org/feeds/author?name=RSS"],
    ["https://www.behance.net/atom.xml", "https://www.behance.net/feeds/user?username=ATOM"],
  ];
  for (const [asked, landed] of lookup) assert.ok(probeLandedOnName(asked, landed), `${asked} → ${landed}`);
  const same: [string, string][] = [
    ["https://example.org/feed", "https://example.org/feed/"],
    ["https://example.org/feed", "http://example.org/feed"],
    ["https://example.org/feed", "https://www.example.org/feed"],
    ["https://www.nature.com/nature.rss", "https://www.nature.com/nature.rss?error=cookies_not_supported&code=abc"],
    ["https://example.org/rss", "https://example.org/feed/"],
    ["https://example.org/atom.xml", "https://example.org/feed.xml"],
    ["https://example.org/feed", "https://example.org/feed/atom/"],
    ["https://example.org/feed", "https://example.org/blog/feed/"],
    ["https://example.org/rss", "https://example.org/blog?format=rss"],
    ["https://example.org/rss", "https://example.org/?feed=rss"],
    ["https://example.org/feed", "https://example.org/en/rss/all.xml"],
    ["https://www.behance.net/rss", "https://www.behance.net/feeds/projects"],
    ["https://example.org/feed", "https://feeds.feedburner.com/example"],
    ["https://example.org/atom.xml", "https://feeds.feedburner.com/example/posts"],
    ["https://example.org/rss", "https://example.org/users/rss-fans"],
    ["https://example.org/", "https://example.org/feed"],
  ];
  for (const [asked, landed] of same) assert.ok(!probeLandedOnName(asked, landed), `${asked} → ${landed}`);
  assert.ok(!probeLandedOnName("not a url", "https://example.org/feed"));
});
