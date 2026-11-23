#!/usr/bin/env node
/**
 * Do the publisher journal rules still find each journal's feed on the live sites? Runs source discovery, as Add source
 * does, on journal pages, society pages and article links of the publishing platforms in
 * packages/connectors/src/journals.ts, and checks that each finds the expected feed (or the expected honest failure).
 * Run by hand after changing discovery or when a publisher changes its site; it needs the network, so it is not part of
 * `npm test`. Lookups run a few at a time: Crossref limits bursts. Exit 0: every case as expected; 1: some differ.
 *
 *   node scripts/journal-feeds-check.ts
 */
import { lookupLink } from "../packages/connectors/src/link-lookup.ts";

type Case = { url: string; feed: string } | { url: string; fails: RegExp };

const CASES: Case[] = [
  // Wiley: walled pages, feed from the electronic ISSN; a society's own Wiley address; an article.
  { url: "https://onlinelibrary.wiley.com/journal/18344461", feed: "https://onlinelibrary.wiley.com/feed/18344461/most-recent" },
  { url: "https://anthrosource.onlinelibrary.wiley.com/toc/15481433/current", feed: "https://onlinelibrary.wiley.com/feed/15481433/most-recent" },
  { url: "https://anthrosource.onlinelibrary.wiley.com/doi/10.1111/aman.70137", feed: "https://onlinelibrary.wiley.com/feed/15481433/most-recent" },
  // Taylor & Francis and the University of Chicago Press: feed from the journal code.
  { url: "https://www.tandfonline.com/journals/rhum20", feed: "https://www.tandfonline.com/feed/rss/rhum20" },
  { url: "https://www.journals.uchicago.edu/journals/ca/about", feed: "https://www.journals.uchicago.edu/action/showFeed?type=etoc&feed=rss&jc=ca" },
  // Berghahn: script-drawn pages; the feed redirects to an internal address, so only its journal path is checked.
  { url: "https://www.berghahnjournals.com/view/journals/ajec/ajec-overview.xml", feed: "/journals/ajec/ajec-overview.xml" },
  { url: "https://social-analysis.berghahnjournals.com/", feed: "/journals/social-analysis/social-analysis-overview.xml" },
  // Project MUSE: articles and issues; an Open Journal Systems journal's announcements next to its articles.
  { url: "https://muse.jhu.edu/journal/10", feed: "https://muse.jhu.edu/feeds/latest_issues?jid=10" },
  { url: "https://www.haujournal.org/index.php/hau/index", feed: "https://www.haujournal.org/index.php/hau/gateway/plugin/AnnouncementFeedGatewayPlugin/atom" },
  // ScienceDirect: the print ISSN from Crossref's journal list.
  { url: "https://www.sciencedirect.com/journal/journal-of-anthropological-archaeology", feed: "https://rss.sciencedirect.com/publication/science/02784165" },
  // Society pages linking to their journal on a platform.
  { url: "https://www.americananthropologist.org/", feed: "https://onlinelibrary.wiley.com/feed/15481433/most-recent" },
  { url: "https://easaonline.org/social-anthropology-anthropologie-sociale/", feed: "/journals/saas/saas-overview.xml" },
  { url: "https://socarchsci.org/publications/journal-of-archaeological-science.html", feed: "https://rss.sciencedirect.com/publication/science/03054403" },
  // DOIs: bare, with an alert's tracking parameters, and one whose publisher's feed can't be made from it.
  { url: "10.1111/aman.70137", feed: "https://onlinelibrary.wiley.com/feed/15481433/most-recent" },
  { url: "https://doi.org/10.1111/aman.70137?utm_source=alert", feed: "https://onlinelibrary.wiley.com/feed/15481433/most-recent" },
  { url: "https://doi.org/10.1080/00187259.2026.2739223", fails: /That article is in Human Organization/ },
  // Duke University Press: walled, feed addresses not derivable.
  { url: "https://www.dukeupress.edu/public-culture", fails: /Duke University Press/ },
];

let differ = 0;
for (let i = 0; i < CASES.length; i += 3) {
  const batch = CASES.slice(i, i + 3);
  const results = await Promise.all(batch.map((c) => lookupLink(c.url)));
  batch.forEach((c, k) => {
    const r = results[k]!;
    const got = r.ok ? r.candidates.map((x) => x.feedUrl).join(", ") || "(no feeds)" : `${r.reason}: ${r.message}`;
    const fine = "feed" in c ? r.ok && r.candidates.some((x) => (c.feed.startsWith("/") ? x.feedUrl.endsWith(c.feed) : x.feedUrl === c.feed)) : !r.ok && c.fails.test(r.message);
    if (!fine) differ++;
    console.log(`${fine ? "ok  " : "DIFF"} ${c.url}\n     ${got}`);
  });
}
console.log(differ ? `${differ} of ${CASES.length} differ.` : `All ${CASES.length} as expected.`);
process.exit(differ ? 1 : 0);
