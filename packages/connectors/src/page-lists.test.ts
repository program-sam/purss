import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalUrl } from "./page-context.ts";
import { MAX_PAGE_BYTES, detectPageLists, markupDeclaresCharset, validateRecipe } from "./page-lists.ts";
import type { PageListCandidate, PageListResult } from "./page-lists.ts";
import { parseExpr, toXPath } from "./page-xpath.ts";

// The date every expectation is read at: relative dates and years left out of a date are worked out from it.
const NOW = new Date("2026-11-21T13:00:00Z");

/*
 * Recorded pages (packages/connectors/src/fixtures/page-lists): public list pages saved on 2026-11-21 and trimmed to
 * their structure and text. `links` and `dates` are what a person reads off the right list: its first five items.
 */
type Labelled = { url: string; links: string[]; dates: (string | null)[] };
const LABELS: Record<string, Labelled> = {
  "anthropic-research": {
    url: "https://www.anthropic.com/research",
    links: ["claude-black-hole-physics", "coordinated-vulnerability-disclosure-timelines", "building-strong-safety-evaluations", "claude-electronics-design", "teaching-ai-to-build-scientific-models"].map((s) => `https://www.anthropic.com/research/${s}`),
    dates: ["2026-11-17", "2026-11-16", "2026-11-13", "2026-11-09", "2026-11-06"],
  },
  "anthropic-news": {
    url: "https://www.anthropic.com/news",
    links: ["https://www.anthropic.com/claude-fable-and-mythos-5-2", "https://www.anthropic.com/news/public-benefit-fund", "https://www.anthropic.com/news/s1-sec", "https://www.anthropic.com/research/early-progress-drug-development", "https://www.anthropic.com/claude-haiku-5-5"],
    dates: ["2026-11-09", "2026-10-18", "2026-10-26", "2026-10-27", "2026-10-07"],
  },
  "stripe-blog": {
    url: "https://stripe.com/blog",
    links: [
      "give-your-agents-controlled-access-to-analyze-your-data-and-move-funds",
      "analyze-your-stripe-data-directly-with-your-agent",
      "stripe-on-stripe-what-we-learned-moving-1b-in-vendor-payments-to-global-payouts",
      "how-the-fastest-growing-enterprises-on-stripe-scale-globally",
      "trends-from-money20-20-2026-the-rise-of-hidden-financial-services",
    ].map((s) => `https://stripe.com/blog/${s}`),
    dates: ["2026-11-19", "2026-11-05", "2026-10-30", "2026-10-27", "2026-10-22"],
  },
  paulgraham: {
    url: "https://paulgraham.com/articles.html",
    links: ["powerful", "prepare", "earn", "winc", "brandage"].map((s) => `https://paulgraham.com/${s}.html`),
    dates: [null, null, null, null, null],
  },
  "h-tk-kamernieuws": {
    url: "https://www.tweedekamer.nl/nieuws/kamernieuws",
    links: ["koninklijke-onderscheiding-voor-khadija-arib", "debatten-over-drie-begrotingen-24-25-26-november", "debatten-over-drie-begrotingen", "debat-over-veiligheidssituatie-de-wereld", "debat-over-ontstane-politieke-situatie"].map((s) => `https://www.tweedekamer.nl/nieuws/kamernieuws/${s}`),
    dates: ["2026-11-20", "2026-11-20", "2026-11-18", "2026-11-17", "2026-11-17"],
  },
  "go-release": {
    url: "https://go.dev/doc/devel/release",
    links: ["go1.27.0", "go1.26.0", "go1.25.0", "go1.24.0", "go1.23.0"].map((s) => `https://go.dev/doc/devel/release#${s}`),
    dates: ["2026-08-19", "2026-02-10", "2025-08-12", "2025-02-11", "2024-08-13"],
  },
  "hn-front": {
    url: "https://news.ycombinator.com/",
    links: ["https://math216.wordpress.com/2026/11/20/hurried-announcement-alessandro-masullo-grh/", "https://alpo.ge/remark.pdf", "https://thinkingmachines.ai/news/inkling-2-mini/", "https://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html", "http://ricapar.net/ClawDOS/"],
    dates: ["2026-11-20T18:33", "2026-11-20T14:16", "2026-11-20T20:12", "2026-11-21T08:32", "2026-11-21T05:38"],
  },
  "hn-jobs": {
    url: "https://news.ycombinator.com/jobs",
    links: ["https://www.ycombinator.com/companies/evidence/jobs/1xb9PpP-founding-gtm-lead", "https://news.ycombinator.com/item?id=50534429", "https://atg.science/careers", "https://news.ycombinator.com/item?id=50452404", "https://www.ycombinator.com/companies/yn/jobs/TjDn3YZ-founding-growth-marketer"],
    dates: ["2026-11-18T12:00", "2026-11-17T17:00", "2026-11-13T21:01", "2026-11-11T12:00", "2026-11-09T17:00"],
  },
  melkweg: {
    url: "https://www.melkweg.nl/nl/agenda/",
    links: ["no-need-to-pretend-11-10-2026", "finale-amsterdamse-popprijs-2026-21-11-2026", "hilight-tribe-21-11-2026", "kd-soundsystem-21-11-2026", "the-commitments-1991-21-11-2026"].map((s) => `https://www.melkweg.nl/nl/agenda/${s}/`),
    dates: [null, "2026-11-21", "2026-11-21", "2026-11-21", "2026-11-21"],
  },
  "nos-nieuws": {
    url: "https://nos.nl/nieuws/laatste",
    links: [
      "2640407-na-duitsland-is-nu-zwitserland-in-trek-bij-nederlandse-plofkrakers",
      "2640403-gaat-een-unieke-gebeurtenis-hoog-boven-de-polen-ons-winterweer-bezorgen",
      "2640396-universiteit-leiden-stopt-samenwerking-met-chinese-universiteit-na-zorgen-over-lekken-data",
      "2640394-grote-politieactie-bij-motorclub-in-rijswijk-leden-verdacht-van-wapenhandel",
      "2640381-wekdienst-21-11-klimaattop-turkije-loopt-uit-groot-dictee-op-npo-radio-1",
    ].map((s) => `https://nos.nl/artikel/${s}`),
    dates: ["2026-11-21T12:02", "2026-11-21T11:30", "2026-11-21T10:20", "2026-11-21T10:07", "2026-11-21T07:53"],
  },
  "govuk-news": {
    url: "https://www.gov.uk/search/news-and-communications",
    links: [
      "speeches/chief-of-defence-intelligence-speech-at-cambridge-intelligence-seminar-20-november-2026",
      "news/uk-and-us-deepen-transport-partnership-to-boost-growth-strengthen-aviation-and-back-next-generation-technology",
      "news/environment-agency-grants-cloughton-gas-exploration-proposal",
      "news/the-aaib-has-deployed-a-team-to-loch-leven-near-kinross-fife",
      "news/change-of-his-majestys-ambassador-to-mali",
    ].map((s) => `https://www.gov.uk/government/${s}`),
    dates: ["2026-11-21", "2026-11-20", "2026-11-20", "2026-11-20", "2026-11-20"],
  },
};
const OTHER_PAGES: Record<string, string> = {
  "firefox-releases": "https://www.firefox.com/en-US/releases/",
  "rijksoverheid-nieuws": "https://www.rijksoverheid.nl/actueel/nieuws",
  "ec-presscorner": "https://ec.europa.eu/commission/presscorner/home/en",
};

const results = new Map<string, PageListResult>();
function run(id: string): PageListResult {
  let r = results.get(id);
  if (!r) {
    const url = LABELS[id]?.url ?? OTHER_PAGES[id]!;
    r = detectPageLists(readFileSync(new URL(`./fixtures/page-lists/${id}.html`, import.meta.url), "utf8"), url, NOW, { samples: 60 });
    results.set(id, r);
  }
  return r;
}
const top = (id: string): PageListCandidate => run(id).candidates[0]!;
const ids = (c: PageListCandidate) => c.samples.map((s) => s.id);
const canon = (links: string[]) => links.map((l) => (l.includes("#") ? `${canonicalUrl(l)}#${l.split("#")[1]}` : canonicalUrl(l)));
/** How many of the labelled links are among the first ten items. */
const hits = (c: PageListCandidate, links: string[]) => canon(links).filter((l) => ids(c).slice(0, 10).includes(l)).length;
/** A date matches a label when it starts with it: a label for the day is also right about a date with a time. */
const matches = (date: string | null, label: string | null) => (label === null ? date === null : date !== null && date.startsWith(label));

const FIXTURES = [...Object.keys(LABELS), ...Object.keys(OTHER_PAGES)];

test("the first list on each page is the one a person would pick, in the order they would read it", () => {
  for (const [id, lab] of Object.entries(LABELS)) {
    if (id === "anthropic-news" || id === "paulgraham" || id === "stripe-blog") continue; // the pages below read the list differently, on purpose
    assert.deepEqual(ids(top(id)).slice(0, 5), canon(lab.links), id);
  }
});

test("dates read from the page are the dates a person reads off it", () => {
  for (const [id, lab] of Object.entries(LABELS)) {
    if (id === "anthropic-news" || id === "paulgraham" || id === "stripe-blog" || id === "melkweg") continue;
    top(id).samples.slice(0, 5).forEach((s, i) => assert.ok(matches(s.date, lab.dates[i]!), `${id} ${i}: ${s.date} for ${lab.dates[i]}`));
  }
  // The first event of the day-grouped agenda borrows the date of a heading further up the page.
  top("melkweg").samples.slice(1, 5).forEach((s, i) => assert.ok(matches(s.date, LABELS.melkweg!.dates[i + 1]!), `melkweg ${i + 1}`));
});

test("a blog index with a pinned post and dates in <time>: confident, dated, and the recipe carries the dates", () => {
  const c = top("anthropic-research");
  assert.equal(c.confidence, "high");
  assert.equal(c.itemCount, 24);
  assert.equal(c.rank, 1);
  assert.ok(c.recipe);
  assert.ok(c.recipe.date, "the dates are carried");
  assert.equal(c.datesInRecipe, true);
  assert.ok(c.reasons.includes("dated") && c.reasons.includes("inMain") && !c.reasons.includes("undated"));
  assert.ok(c.samples.every((s) => s.datePrecision === "day"));
  assert.equal(c.samples.length, 24);
  assert.equal(run("anthropic-research").diagnosis, null);
});

test("the full dated list beats the curated block above it", () => {
  const [full, ...others] = run("anthropic-news").candidates;
  assert.equal(full!.confidence, "high");
  assert.equal(full!.itemCount, 24);
  assert.ok(full!.samples.every((s) => s.date !== null));
  assert.equal(full!.samples[0]!.id, "https://anthropic.com/news/ipo-close");
  // The five-item block people see first is still offered, further down.
  assert.ok(others.some((c) => hits(c, LABELS["anthropic-news"]!.links) >= 4));
  assert.ok(hits(full!, LABELS["anthropic-news"]!.links) < 4);
});

test("two lists nearly as good as each other are never called confident", () => {
  const { candidates } = run("stripe-blog");
  assert.equal(candidates[0]!.itemCount, 20);
  assert.ok(candidates[0]!.score - candidates[1]!.score < 3, "a close call");
  assert.equal(candidates[0]!.confidence, "medium");
  assert.ok(hits(candidates[0]!, LABELS["stripe-blog"]!.links) >= 4);
  assert.ok(candidates.every((c) => c.confidence !== "high"));
});

test("a page with several plausible lists gives none of them as confident", () => {
  const { candidates } = run("firefox-releases");
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((c) => c.confidence === "medium"));
  assert.deepEqual(candidates.map((c) => c.itemCount), [61, 301, 657]);
  assert.ok(candidates[0]!.reasons.includes("brittle"), "its best recipe leans on positions");
  assert.ok(candidates.every((c) => !c.datesInRecipe && c.reasons.includes("undated")));
});

test("a page of bare links gets a list with no dates and says its recipe is approximate", () => {
  const { candidates } = run("paulgraham");
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.confidence, "medium");
  assert.ok(hits(c, LABELS.paulgraham!.links) >= 4);
  assert.ok(c.reasons.includes("approximate") && c.reasons.includes("undated"));
  assert.equal(c.datesInRecipe, false);
  assert.equal(c.recipe!.date, undefined);
  assert.ok(c.samples.every((s) => s.date === null && s.datePrecision === null));
  assert.ok(c.samples.some((s) => s.title === "How to Do Great Work"));
});

test("a Dutch page with Dutch dates: its <time> attributes are read, and the recipe carries them", () => {
  const c = top("h-tk-kamernieuws");
  assert.equal(c.confidence, "high");
  assert.equal(c.itemCount, 15);
  assert.equal(c.recipe!.date, ".//time/@datetime");
  assert.ok(c.samples.every((s) => /^2026-11-\d\d$/.test(s.date!.slice(0, 10)) && s.datePrecision === "time"));
  assert.match(c.samples[0]!.title, /onderscheiding/);
});

test("a changelog on one page: the entries are its headings, linked by their ids", () => {
  const c = top("go-release");
  assert.equal(c.confidence, "high");
  assert.equal(c.itemCount, 28);
  assert.ok(c.reasons.includes("changelog"));
  assert.equal(c.recipe!.link, "concat('https://go.dev/doc/devel/release#', ./@id)");
  assert.equal(c.recipe!.title, ".");
  assert.equal(c.samples[0]!.url, "https://go.dev/doc/devel/release#go1.27.0");
  assert.equal(c.samples[0]!.title, "go1.27.0 (released 2026-08-19)");
  // The date sits in the heading's text among other words, which PHP's strtotime would not read.
  assert.equal(c.datesInRecipe, false);
  assert.ok(c.reasons.includes("undated"));
});

test("Hacker News dates come from the @title attribute, and the recipe reads that attribute", () => {
  const c = top("hn-front");
  assert.equal(c.confidence, "medium");
  assert.equal(c.itemCount, 30);
  assert.match(c.recipe!.date!, /\/@title$/);
  assert.equal(c.datesInRecipe, true);
  assert.ok(c.samples.every((s) => s.datePrecision === "time"));
  assert.equal(c.samples[1]!.title, "Levent Alpöge claims proof of the Generalized Riemann Hypothesis [pdf]");
});

test("a job board: titles and links from each posting", () => {
  const c = top("hn-jobs");
  assert.equal(c.confidence, "high");
  assert.equal(c.itemCount, 30);
  assert.equal(c.samples[0]!.title, "Evidence (YC S21) Is Hiring");
});

test("an agenda grouped by day takes each event's date from the heading above it", () => {
  const c = top("melkweg");
  assert.equal(c.confidence, "high");
  assert.match(c.recipe!.date!, /^preceding::time\[contains\(@class, 'styles_date'\)\]\[1\]\/@datetime$/);
  assert.equal(c.samples[1]!.title, "Finale Amsterdamse Popprijs 2026");
});

test("Dutch news and government pages", () => {
  const nos = top("nos-nieuws");
  assert.equal(nos.confidence, "high");
  assert.ok(nos.reasons.includes("slugUrls") && nos.reasons.includes("dated"));
  assert.equal(nos.samples[0]!.title, "Na Duitsland is nu Zwitserland in trek bij Nederlandse plofkrakers");
  assert.equal(top("govuk-news").confidence, "high");
  assert.equal(top("govuk-news").itemCount, 20);
});

test("a page whose list is drawn by script gives no list better than a guess, and says why", () => {
  const empty = run("rijksoverheid-nieuws");
  assert.ok(empty.candidates.length > 0);
  assert.ok(empty.candidates.every((c) => c.confidence === "low"));
  assert.equal(empty.diagnosis, "emptyMain");
  assert.ok(empty.candidates.every((c) => c.reasons.some((r) => r === "inFooter" || r === "inNav")));
  const shell = run("ec-presscorner");
  assert.deepEqual(shell.candidates, []);
  assert.equal(shell.diagnosis, "appShell");
});

test("a confident list is only ever the first, and every recipe passes the validator and reads back as written", () => {
  for (const id of FIXTURES) {
    const r = run(id);
    assert.ok(r.candidates.length <= 3, id);
    r.candidates.forEach((c, i) => {
      assert.equal(c.rank, i + 1);
      if (i > 0) {
        assert.notEqual(c.confidence, "high", `${id}#${c.rank}`);
        assert.ok(c.score <= r.candidates[i - 1]!.score, id);
      }
      assert.equal(c.portable, c.recipe !== null);
      if (!c.recipe) return;
      assert.deepEqual(validateRecipe(c.recipe), { ok: true }, `${id}#${c.rank} ${JSON.stringify(c.recipe)}`);
      for (const field of ["item", "title", "link", "date"] as const) {
        const text: string | undefined = c.recipe[field];
        if (text === undefined) continue;
        assert.ok(text.length <= 200, `${id}#${c.rank} ${field}`);
        assert.equal(toXPath(parseExpr(text, field)!), text, `${id}#${c.rank} ${field}`);
      }
      assert.equal(c.datesInRecipe, c.recipe.date !== undefined);
      assert.equal(c.reasons.includes("undated"), c.recipe.date === undefined, `${id}#${c.rank}`);
      assert.equal(new Set(c.reasons).size, c.reasons.length);
    });
    assert.equal(r.diagnosis === null, r.candidates.length > 0 && r.candidates[0]!.confidence !== "low", id);
  }
});

// ---- pages made for the test

const list = (n: number, date: (i: number) => string, lang = "en") =>
  `<!DOCTYPE html><html lang="${lang}"><body><header><nav><a href="/">Home</a><a href="/about">About</a></nav></header><main><ul>${Array.from(
    { length: n },
    (_, k) => `<li class="post"><a href="/p/${k + 1}-garden-notes-${k + 1}">Garden notes number ${k + 1}</a> <span class="date">${date(k + 1)}</span></li>`,
  ).join("\n")}</ul></main></body></html>`;
const detect = (html: string, url = "https://example.com/blog/", samples = 3) => detectPageLists(html, url, NOW, { samples });

test("English dates in the text are read, and the recipe carries them because PHP reads them the same way", () => {
  const c = detect(list(6, (i) => `Nov ${i}, 2026`)).candidates[0]!;
  assert.equal(c.confidence, "high");
  assert.deepEqual(c.samples.map((s) => s.date), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.equal(c.recipe!.date, ".//span");
  assert.equal(c.datesInRecipe, true);
});

test("dates PHP would misread are shown but not put in the recipe, so the feed dates the posts by first sight", () => {
  const cases: [string, (i: number) => string, string][] = [
    ["Dutch month names", (i) => `${i + 5} oktober 2026`, "nl"],
    ["relative dates", (i) => `${i} hours ago`, "en"],
    ["a weekday that is not that day's", (i) => `Tue, ${i + 14} Nov 2026`, "en"],
    ["no-break spaces", (i) => `Nov&nbsp;${i},&nbsp;2026`, "en"],
    ["a day without a year", (i) => `Nov ${i + 10}`, "en"],
  ];
  for (const [label, date, lang] of cases) {
    const c = detect(list(6, date, lang)).candidates[0]!;
    assert.ok(c.samples.every((s) => s.date !== null), label);
    assert.equal(c.datesInRecipe, false, label);
    assert.equal(c.recipe!.date, undefined, label);
    assert.ok(c.reasons.includes("undated") && !c.reasons.includes("dated"), label);
  }
  const relative = detect(list(6, (i) => `${i} hours ago`)).candidates[0]!;
  assert.deepEqual(relative.samples.map((s) => [s.date, s.datePrecision]), [["2026-11-21T12:00", "relative"], ["2026-11-21T11:00", "relative"], ["2026-11-21T10:00", "relative"]]);
  const noYear = detect(list(6, (i) => `Nov ${i + 10}`)).candidates[0]!;
  assert.equal(noYear.samples[0]!.datePrecision, "noYear");
});

test("the author's own markup is trusted: h-entry and microdata lists, and what the list's items say about themselves", () => {
  const hentry = `<html lang="en"><body><main>${Array.from({ length: 4 }, (_, i) => `<article class="h-entry"><h2 class="p-name"><a class="u-url" href="/p/${i + 1}">Entry ${i + 1} about gardens</a></h2><time class="dt-published" datetime="2026-11-0${i + 1}">Nov ${i + 1}, 2026</time></article>`).join("")}</main></body></html>`;
  const a = detect(hentry).candidates[0]!;
  assert.ok(a.reasons.includes("microformats"));
  assert.equal(a.recipe!.date, ".//time/@datetime");
  assert.deepEqual(a.samples.map((s) => s.title), ["Entry 1 about gardens", "Entry 2 about gardens", "Entry 3 about gardens"]);
  const micro = `<html lang="en"><body><main>${Array.from({ length: 4 }, (_, i) => `<div itemscope itemtype="https://schema.org/BlogPosting"><h2 itemprop="headline"><a itemprop="url" href="/p/${i + 1}">Entry ${i + 1} about gardens</a></h2><meta itemprop="datePublished" content="2026-11-0${i + 1}"></div>`).join("")}</main></body></html>`;
  const b = detect(micro).candidates[0]!;
  assert.ok(b.reasons.includes("microdata"));
  assert.deepEqual(b.samples.map((s) => s.date), ["2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("structured data with no list on the page to match is offered, but is not a recipe", () => {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: Array.from({ length: 4 }, (_, i) => ({ "@type": "ListItem", position: i + 1, url: `https://example.com/p/${i + 1}`, name: `Data post ${i + 1}`, datePublished: `2026-11-0${i + 1}` })) });
  const html = `<html lang="en"><head><script type="application/ld+json">${ld}</script></head><body><nav><a href="/a">A</a><a href="/b">B</a></nav><main><p>App</p></main></body></html>`;
  const { candidates, diagnosis } = detect(html);
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.portable, false);
  assert.equal(c.recipe, null);
  assert.equal(c.datesInRecipe, false);
  assert.equal(c.confidence, "medium");
  assert.deepEqual(c.reasons, ["dataOnly"]);
  assert.equal(c.itemCount, 4);
  assert.equal(c.samples[0]!.title, "Data post 1");
  assert.equal(diagnosis, null);
});

test("structured data that matches a list on the page backs it up", () => {
  const html = list(6, (i) => `Nov ${i}, 2026`);
  const ld = JSON.stringify({ "@type": "ItemList", itemListElement: Array.from({ length: 6 }, (_, i) => ({ "@type": "ListItem", url: `https://example.com/p/${i + 1}-garden-notes-${i + 1}`, name: `Garden notes number ${i + 1}` })) });
  const plain = detect(html).candidates[0]!;
  const backed = detect(html.replace("</body>", `<script type="application/ld+json">${ld}</script></body>`)).candidates[0]!;
  assert.ok(backed.reasons.includes("structuredData"));
  assert.ok(backed.score > plain.score + 8);
  assert.equal(detect(html.replace("</body>", `<script type="application/ld+json">{not json</script></body>`)).candidates[0]!.score, plain.score);
});

test("a list grouped by day takes dates from the headings above", () => {
  const html = `<html lang="en"><body><main>${["Nov 20, 2026", "Nov 19, 2026", "Nov 18, 2026"].map((d, j) => `<h2 class="day">${d}</h2><ul>${[1, 2, 3].map((k) => `<li><a href="/e/${j}-${k}-event-name">Event ${j}${k} with a long name</a></li>`).join("")}</ul>`).join("")}</main></body></html>`;
  const c = detect(html, "https://example.com/events", 9).candidates[0]!;
  assert.equal(c.recipe!.date, "preceding::h2[contains(concat(' ', normalize-space(@class), ' '), ' day ')][1]");
  assert.deepEqual(c.samples.map((s) => s.date), ["2026-11-20", "2026-11-20", "2026-11-20", "2026-11-19", "2026-11-19", "2026-11-19", "2026-11-18", "2026-11-18", "2026-11-18"]);
});

test("an item's identity is its canonical address; its link is the page's own", () => {
  const html = `<html lang="en"><body><main><ul>${Array.from({ length: 5 }, (_, i) => `<li class="post"><a href="https://www.example.com/p/${i + 1}-nice-post-title/?utm_source=x&amp;ref=y&amp;page=2#c">Nice post title ${i + 1}</a></li>`).join("")}</ul></main></body></html>`;
  const c = detect(html).candidates[0]!;
  assert.equal(c.samples[0]!.id, "https://example.com/p/1-nice-post-title?page=2");
  assert.equal(c.samples[0]!.url, "https://www.example.com/p/1-nice-post-title/?utm_source=x&ref=y&page=2#c");
});

test("links resolve against the page's <base>, and titles lose their line breaks", () => {
  const html = `<html><head><base href="https://cdn.example.org/site/"></head><body><main><ul>${Array.from({ length: 4 }, (_, i) => `<li class="post"><a href="posts/${i + 1}-nice-post-title">Nice   post\n   title ${i + 1}</a></li>`).join("")}</ul></main></body></html>`;
  const c = detect(html).candidates[0]!;
  assert.equal(c.samples[0]!.url, "https://cdn.example.org/site/posts/1-nice-post-title");
  assert.equal(c.samples[0]!.title, "Nice post title 1");
});

test("a changelog's headings link to the address of the page they are on", () => {
  const html = `<html lang="en"><body><main>${Array.from({ length: 5 }, (_, i) => `<h2 id="v1.${i}.0">v1.${i}.0</h2><p>Notes for the release</p>`).join("")}</main></body></html>`;
  const c = detect(html, "https://example.com/changelog?x=1#top").candidates[0]!;
  assert.equal(c.recipe!.link, "concat('https://example.com/changelog?x=1#', ./@id)");
  assert.equal(c.samples[0]!.url, "https://example.com/changelog?x=1#v1.0.0");
  assert.equal(c.samples[0]!.id, "https://example.com/changelog?x=1#v1.0.0");
  // A page address that holds a quote or a dollar sign cannot spoil the recipe.
  const odd = detect(html, "https://example.com/it's/$x/changelog").candidates[0]!;
  assert.deepEqual(validateRecipe(odd.recipe), { ok: true });
  assert.equal(odd.recipe!.link, "concat('https://example.com/it%27s/%24x/changelog#', ./@id)");
});

test("two equal lists are both medium; one list in a navigation bar is a weak guess", () => {
  const two = detect(`<html lang="en"><body><main><section>${list(6, (i) => `Nov ${i}, 2026`).match(/<ul>[\s\S]*<\/ul>/)![0]}</section><section>${list(6, (i) => `Nov ${i}, 2026`).replace(/\/p\//g, "/q/").match(/<ul>[\s\S]*<\/ul>/)![0]}</section></main></body></html>`);
  assert.deepEqual(two.candidates.map((c) => c.confidence), ["medium", "medium", "medium"]);
  assert.equal(two.candidates[0]!.score, two.candidates[1]!.score);
  const nav = detect(`<html lang="en"><body><nav><ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="/s/${i}">Section ${i}</a></li>`).join("")}</ul></nav></body></html>`);
  assert.equal(nav.candidates[0]!.confidence, "low");
  assert.ok(nav.candidates[0]!.reasons.includes("inNav"));
  assert.equal(nav.diagnosis, "noRepeatedLinks");
  assert.equal(detect(`<html lang="en"><body><div id="root"></div><noscript>You need JavaScript</noscript></body></html>`).diagnosis, "appShell");
  assert.equal(detect(`<html lang="en"><body><main></main><p>${"words ".repeat(80)}</p></body></html>`).diagnosis, "emptyMain");
});

test("how many items are described is the caller's choice", () => {
  const html = list(12, (i) => `Nov ${i}, 2026`);
  assert.equal(detectPageLists(html, "https://example.com/", NOW).candidates[0]!.samples.length, 8);
  assert.equal(detectPageLists(html, "https://example.com/", NOW, { samples: 3 }).candidates[0]!.samples.length, 3);
  const all = detectPageLists(html, "https://example.com/", NOW, { samples: 100 }).candidates[0]!;
  assert.equal(all.samples.length, 12);
  assert.equal(all.itemCount, 12);
});

// ---- what it refuses to read

test("what is not a web page gives nothing", () => {
  for (const body of ["", "   ", "plain words", `{"items": [1, 2, 3]}`, "[1, 2, 3]", "\u0000\u0001\u0002<<<>>>", `<?xml version="1.0"?><rss version="2.0"><channel><item><link>https://example.com/a</link></item></channel></rss>`, `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`]) {
    assert.deepEqual(detectPageLists(body, "https://example.com/", NOW), { candidates: [], diagnosis: "notHtml" }, JSON.stringify(body.slice(0, 30)));
  }
});

test("a page over two mebibytes is refused unread, as is markup too large or too deep to read safely", () => {
  assert.deepEqual(detectPageLists(`<html><body>${"<a href='/a'>x</a>".repeat(130_000)}</body></html>`, "https://example.com/", NOW), { candidates: [], diagnosis: "tooLarge" });
  assert.equal(MAX_PAGE_BYTES, 2 * 1024 * 1024);
  // Multi-byte text counts in bytes.
  assert.equal(detectPageLists(`<html><body>${"é".repeat(MAX_PAGE_BYTES / 2 + 100)}</body></html>`, "https://example.com/", NOW).diagnosis, "tooLarge");
  assert.deepEqual(detectPageLists(`<html><body>${"<b></b>".repeat(130_000)}</body></html>`, "https://example.com/", NOW), { candidates: [], diagnosis: "tooComplex" });
  assert.deepEqual(detectPageLists(`<html><body>${"<div>".repeat(5000)}x</body></html>`, "https://example.com/", NOW), { candidates: [], diagnosis: "tooComplex" });
});

test("a large list is still read in time", () => {
  const started = performance.now();
  const c = detect(list(4000, (i) => `Nov ${(i % 28) + 1}, 2026`), "https://example.com/blog/", 5).candidates[0]!;
  assert.equal(c.itemCount, 4000);
  assert.ok(performance.now() - started < 20_000, "a few seconds at most");
});

test("a page cut off anywhere, or full of junk, never makes it throw", () => {
  const html = readFileSync(new URL("./fixtures/page-lists/hn-front.html", import.meta.url), "utf8");
  for (let at = 0; at < html.length; at += Math.ceil(html.length / 23)) {
    const r = detectPageLists(html.slice(0, at), "https://news.ycombinator.com/", NOW);
    assert.ok(r.candidates.length <= 3);
  }
  for (const junk of ["<a href=", "<ul><li><a href='/x'>a</a><li><a href='/y'>b</a><li><a href='/z'>c", "<table><tr><td><a href='/1'>one</a><tr><td><a href='/2'>two</a><tr><td><a href='/3'>three", "<a href='http://[::1'>x</a>".repeat(10), "<h2 id=a>1.2.3<h2 id=a>1.2.4<h2 id=a>1.2.5<h2 id=a>1.2.6", "<html><body><a href='javascript:x'>a</a><a href='mailto:b@c.d'>b</a><a href='#c'>c</a>"]) {
    assert.ok(detectPageLists(junk, "https://example.com/", NOW).candidates.length <= 3, junk);
  }
  assert.doesNotThrow(() => detectPageLists("<html><body><a href='/a'>a</a></body></html>", "not a url", NOW));
});

test("whether a page names its character set is read the way PHP's HTML loader reads it", () => {
  assert.equal(markupDeclaresCharset(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body></body></html>`), true);
  assert.equal(markupDeclaresCharset(`<html><head><meta charset=utf-8></head></html>`), true);
  assert.equal(markupDeclaresCharset(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head></html>`), true);
  assert.equal(markupDeclaresCharset(`<?xml version="1.0" encoding="utf-8"?><html></html>`), true);
  assert.equal(markupDeclaresCharset(`<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>charset=utf-8</body></html>`), false);
  assert.equal(markupDeclaresCharset(`<html><head><meta name="viewport" content="width=device-width"></head></html>`), false);
});
