import { server } from "@purss/copy/server";
import type { KnownFeed, KnownPlan } from "./known-feeds.ts";
import { hostOf, isHostOrSub, segmentsOf } from "./services.ts";

const feedLabels = server.sources.connectors.labels;

/*
 * Scholarly journals on the large publishing platforms. Their pages refuse automated readers (Wiley, Taylor & Francis,
 * SAGE, the University of Chicago Press, ScienceDirect) or are drawn by script (Berghahn), but each journal's feed answers at an
 * address made from the journal's code or ISSN. A pasted journal, issue or article page is turned into that address
 * without opening the page, and the feed is then fetched and checked like any other (known-feeds.ts). Where the address
 * needs an ISSN that the page address doesn't carry (ScienceDirect, a DOI), Crossref's public metadata supplies it.
 *
 * A journal's feeds are offered as separate choices only when they carry different articles: Wiley's "most recent" and
 * "current issue" feeds are one feed under two addresses, while its Early View (articles online before they are in an
 * issue) is a choice of its own. Copies are dropped after fetching, by their entries (known-feeds.ts).
 */

export type Platform = "wiley" | "tandf" | "sage" | "uchicago" | "berghahn" | "muse" | "sciencedirect";

/** A journal named by a page address: its platform and the code the feed address is made from. */
export type JournalRef = { platform: Exclude<Platform, "sciencedirect">; id: string } | { platform: "sciencedirect"; slug: string };

const PUBLISHER: Record<Platform, string> = {
  wiley: "Wiley",
  tandf: "Taylor & Francis",
  sage: "SAGE",
  uchicago: "University of Chicago Press",
  berghahn: "Berghahn",
  muse: "Project MUSE",
  sciencedirect: "Elsevier",
};

/** An ISSN without its hyphen (`15481433`, `0000000X`) when its check digit is right, else null. */
export function normalIssn(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/^(\d{4})-(\d{3}[\dX])$/, "$1$2");
  if (!/^\d{7}[\dX]$/.test(s)) return null;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? "X" : String(check)) === s[7] ? s : null;
}

const TANDF_CODE = /^[a-z]{2,8}\d{2}$/i;
const SAGE_CODE = /^[a-z][a-z0-9]{1,11}$/i;
const WILEY_CODE = /^[a-z][a-z0-9]{1,11}$/i;
const UCHICAGO_CODE = /^[a-z]{1,12}$/i;
const BERGHAHN_CODE = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const RESERVED_BERGHAHN = new Set(["www", "api", "static", "assets", "cdn", "mail"]);

/** The journal code after `/journal/`, `/journals/`, `/toc/` or `/loi/`, the positions these platforms put it in. */
function codeAfterPrefix(s: string[], prefixes: readonly string[]): string | null {
  return prefixes.includes((s[0] ?? "").toLowerCase()) && s[1] ? s[1] : null;
}

/** The journal a page address on one of these platforms belongs to, or null. */
export function journalFromUrl(url: URL): JournalRef | null {
  const h = hostOf(url);
  const s = segmentsOf(url);
  if (isHostOrSub(h, "onlinelibrary.wiley.com")) {
    // The code in a Wiley journal address is the journal's electronic ISSN, or for some journals (the former Hindawi
    // ones) a short name; both make its feed address.
    // /journal/<code>, its issues and issue list, its article index (/index/<code>), and its information pages (/page/journal/<code>/…).
    const code = codeAfterPrefix(s, ["journal", "toc", "loi", "index"]) ?? ((s[0] === "page" || s[0] === "hub") && s[1] === "journal" ? (s[2] ?? null) : null);
    const issn = code ? normalIssn(code) : null;
    if (issn) return { platform: "wiley", id: issn };
    return code && WILEY_CODE.test(code) ? { platform: "wiley", id: code.toLowerCase() } : null;
  }
  if (h === "tandfonline.com" || h === "www.tandfonline.com") {
    const code = codeAfterPrefix(s, ["journals", "journal", "toc", "loi"]);
    return code && TANDF_CODE.test(code) ? { platform: "tandf", id: code.toLowerCase() } : null;
  }
  if (h === "journals.sagepub.com" || h === "www.journals.sagepub.com") {
    // The journal's home page, its issues and its issue list (/home/<code>, /toc/<code>/…, /loi/<code>).
    const code = codeAfterPrefix(s, ["home", "toc", "loi"]);
    return code && SAGE_CODE.test(code) ? { platform: "sage", id: code.toLowerCase() } : null;
  }
  if (h === "journals.uchicago.edu" || h === "www.journals.uchicago.edu") {
    const code = codeAfterPrefix(s, ["journals", "toc", "loi"]);
    return code && UCHICAGO_CODE.test(code) ? { platform: "uchicago", id: code.toLowerCase() } : null;
  }
  if (h === "berghahnjournals.com" || h === "www.berghahnjournals.com") {
    // /view/journals/<code>/<code>-overview.xml, and the issue and article pages under /view/journals/<code>/.
    const code = s[0] === "view" && s[1] === "journals" && s.length >= 4 ? s[2]! : null;
    return code && BERGHAHN_CODE.test(code) ? { platform: "berghahn", id: code.toLowerCase() } : null;
  }
  if (h.endsWith(".berghahnjournals.com")) {
    // A journal's own site: social-analysis.berghahnjournals.com.
    const label = h.slice(0, -".berghahnjournals.com".length);
    return BERGHAHN_CODE.test(label) && !label.includes(".") && !RESERVED_BERGHAHN.has(label) ? { platform: "berghahn", id: label } : null;
  }
  if (h === "muse.jhu.edu") {
    // /journal/<number>, also under a publisher: /pub/<number>/journal/<number>.
    const at = s[0] === "pub" && /^\d{1,6}$/.test(s[1] ?? "") ? 2 : 0;
    const id = s[at] === "journal" ? (s[at + 1] ?? "") : "";
    return /^\d{1,6}$/.test(id) ? { platform: "muse", id } : null;
  }
  if (h === "sciencedirect.com" || h === "www.sciencedirect.com") {
    const slug = s[0] === "journal" ? (s[1] ?? "") : "";
    return /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/.test(slug) ? { platform: "sciencedirect", slug } : null;
  }
  return null;
}

/** Journal feeds name themselves after the platform as well ("Wiley: Oceania: Table of Contents"); the journal's name is the middle. */
export function journalTitle(feedTitle: string | null | undefined): string | null {
  const t = (feedTitle ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:Wiley|tandf|Taylor (?:and|&) Francis|SAGE Publications(?: (?:Ltd|Inc|India Pvt Ltd)\.?)?|SAGE Journals|The University of Chicago Press|ScienceDirect Publication|Project MUSE\s*®?)\s*:\s*/i, "")
    .replace(/\s*:\s*Table of Contents$/i, "")
    .replace(/\s+-\s+Latest (?:Articles|Issues)$/i, "")
    .trim();
  // A feed that names only the platform ("Wiley-Online-Library: Table of Contents") says nothing about the journal.
  return t && !PLATFORM_ONLY.test(t) ? t : null;
}

const PLATFORM_ONLY = /^(?:Wiley-Online-Library|Taylor and Francis|University of Chicago Press|Sage Journals)$/i;

export const EARLY_NOTE = server.sources.connectors.journals.earlyNote;
export const ISSUES_NOTE = server.sources.connectors.journals.issuesNote;

function journalFeed(platform: Platform, feedUrl: string, title?: string): KnownFeed {
  return { feedUrl, via: feedLabels.articlesFeed, origin: server.sources.connectors.journals.origin(PUBLISHER[platform]), retitle: journalTitle, ...(title ? { title } : {}) };
}

/** A journal's second feed: offered only with entries, and named like its main feed. */
function alsoFeed(main: KnownFeed, feedUrl: string, via: string, note: string): KnownFeed {
  return { feedUrl, via, origin: main.origin, retitle: journalTitle, note, needsItems: true, nameLike: main.feedUrl };
}

/**
 * The feeds of a journal on a platform whose feed addresses are made from a code the page address carries, its main feed
 * first. On the Atypon platforms (Wiley, Taylor & Francis, Chicago) the `axatoc` feed holds the articles published online
 * that aren't in an issue yet: Wiley's main feed leaves them out, the others' include them.
 */
export function journalFeedsFor(ref: Exclude<JournalRef, { platform: "sciencedirect" }>): KnownFeed[] {
  switch (ref.platform) {
    case "wiley": {
      const main = journalFeed("wiley", `https://onlinelibrary.wiley.com/feed/${ref.id}/most-recent`);
      return [main, alsoFeed(main, `https://onlinelibrary.wiley.com/action/showFeed?jc=${ref.id}&type=axatoc&feed=rss`, feedLabels.earlyArticlesFeed, EARLY_NOTE)];
    }
    case "tandf": {
      const main = journalFeed("tandf", `https://www.tandfonline.com/feed/rss/${ref.id}`);
      return [main, alsoFeed(main, `https://www.tandfonline.com/action/showFeed?type=axatoc&feed=rss&jc=${ref.id}`, feedLabels.earlyArticlesFeed, EARLY_NOTE)];
    }
    case "sage":
      return [journalFeed("sage", `https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=${ref.id}`)];
    case "uchicago": {
      const main = journalFeed("uchicago", `https://www.journals.uchicago.edu/action/showFeed?type=etoc&feed=rss&jc=${ref.id}`);
      return [main, alsoFeed(main, `https://www.journals.uchicago.edu/action/showFeed?type=axatoc&feed=rss&jc=${ref.id}`, feedLabels.earlyArticlesFeed, EARLY_NOTE)];
    }
    case "berghahn":
      return [journalFeed("berghahn", `https://www.berghahnjournals.com/journalissuetocrss/journals/${ref.id}/${ref.id}-overview.xml`)];
    case "muse": {
      const main = journalFeed("muse", `https://muse.jhu.edu/feeds/latest_articles?jid=${ref.id}`);
      return [main, alsoFeed(main, `https://muse.jhu.edu/feeds/latest_issues?jid=${ref.id}`, feedLabels.issuesFeed, ISSUES_NOTE)];
    }
  }
}

/** The plan for a journal page whose address alone gives the feeds; null for others (ScienceDirect needs a lookup). */
export function planJournal(url: URL): KnownPlan | null {
  const ref = journalFromUrl(url);
  if (!ref || ref.platform === "sciencedirect") return null;
  return { service: PUBLISHER[ref.platform], feeds: journalFeedsFor(ref) };
}

/** True for hosts of these platforms, and of other publishers whose pages hold no feed at the usual blog addresses. */
export function isPublisherHost(h: string): boolean {
  return (
    isHostOrSub(h, "onlinelibrary.wiley.com") ||
    isHostOrSub(h, "tandfonline.com") ||
    h === "journals.sagepub.com" ||
    h === "www.journals.sagepub.com" ||
    isHostOrSub(h, "journals.uchicago.edu") ||
    isHostOrSub(h, "sciencedirect.com") ||
    isHostOrSub(h, "berghahnjournals.com") ||
    isHostOrSub(h, "dukeupress.edu") ||
    h === "muse.jhu.edu" ||
    h === "www.cambridge.org" ||
    h === "cambridge.org"
  );
}

export const DUKE_MESSAGE =
  server.sources.connectors.journals.dukeMessage;

// ---------- ISSNs and DOIs ----------

/** Which ISSN-made feed a publisher offers, by the publisher's name as Crossref or a page's metadata states it. */
function issnPlatform(publisher: string | null | undefined): "wiley" | "sciencedirect" | null {
  if (!publisher) return null;
  if (/\bwiley\b/i.test(publisher)) return "wiley";
  if (/\belsevier\b/i.test(publisher)) return "sciencedirect";
  return null;
}

/**
 * The feeds to try for a journal known by its ISSNs and publisher. Wiley's feed takes the electronic ISSN and
 * ScienceDirect's the print one; a page's metadata doesn't say which is which, so each (at most two) is tried and only
 * the right one answers. `typed` ISSNs (from Crossref) are tried in that order, most likely first.
 */
export function planFromIssns(publisher: string | null | undefined, issns: readonly string[], title?: string | null): KnownPlan | null {
  const platform = issnPlatform(publisher);
  if (!platform) return null;
  const valid = [...new Set(issns.map(normalIssn).filter((v): v is string => !!v))].slice(0, 2);
  if (!valid.length) return null;
  const make = (issn: string) =>
    platform === "wiley"
      ? journalFeed("wiley", `https://onlinelibrary.wiley.com/feed/${issn}/most-recent`, title ?? undefined)
      : journalFeed("sciencedirect", `https://rss.sciencedirect.com/publication/science/${issn}`, title ?? undefined);
  return { service: PUBLISHER[platform], feeds: valid.map(make), firstAnswer: true };
}

/** A DOI as written in a bare identifier, a `doi:` reference or a doi.org address; null for anything else. */
export function doiFromInput(raw: string): { doi: string; viaResolver: boolean } | null {
  const s = raw.trim();
  if (s.length > 500 || /\s/.test(s)) return null;
  const resolver = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/(.+)$/i.exec(s);
  // A doi.org link from an alert e-mail carries tracking parameters that are not part of the DOI.
  const body = resolver ? safeDecode(resolver[1]!.replace(/[?#].*$/, "")) : s.replace(/^doi:\s*/i, "");
  const doi = /^(10\.\d{4,9}\/[^\s]+)$/.exec(body)?.[1];
  return doi ? { doi: doi.replace(/[.,;]+$/, ""), viaResolver: !!resolver } : null;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** The DOI in an article address on a platform whose article pages refuse automated readers (`/doi/full/10.1080/…`). */
export function doiFromArticleUrl(url: URL): string | null {
  const h = hostOf(url);
  if (!isHostOrSub(h, "onlinelibrary.wiley.com") && !isHostOrSub(h, "tandfonline.com") && !isHostOrSub(h, "journals.uchicago.edu")) return null;
  const m = /^\/doi\/(?:(?:abs|full|pdf|epdf|pdfdirect|epub|reader|figure|suppl|book)\/)?(10\.\d{4,9}\/[^?#]+)$/i.exec(url.pathname);
  return m ? safeDecode(m[1]!) : null;
}

/** The doi.org address of a DOI, each part of it escaped. */
export function resolverUrl(doi: string): string {
  return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

export function crossrefWorkUrl(doi: string): string {
  return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
}

/** What Crossref says about the journal a work appeared in. */
export type CrossrefJournal = { title: string | null; publisher: string | null; issns: string[]; electronic: string | null };

/** Read a Crossref work record; electronic ISSNs first, then print, then any untyped ones. */
export function readCrossrefWork(data: unknown): CrossrefJournal | null {
  const m = (data as { message?: Record<string, unknown> } | null)?.message;
  if (!m || typeof m !== "object") return null;
  const titles = Array.isArray(m["container-title"]) ? m["container-title"] : [];
  const title = typeof titles[0] === "string" ? titles[0].slice(0, 300) : null;
  const publisher = typeof m.publisher === "string" ? m.publisher.slice(0, 200) : null;
  const typed = Array.isArray(m["issn-type"]) ? (m["issn-type"] as { type?: unknown; value?: unknown }[]) : [];
  const byType = (t: string) => typed.filter((x) => x?.type === t && typeof x.value === "string").map((x) => x.value as string);
  const plain = Array.isArray(m.ISSN) ? (m.ISSN as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const platform = issnPlatform(publisher);
  const ordered = platform === "sciencedirect" ? [...byType("print"), ...byType("electronic"), ...plain] : [...byType("electronic"), ...byType("print"), ...plain];
  return { title, publisher, issns: [...new Set(ordered)].slice(0, 4), electronic: byType("electronic")[0] ?? null };
}

/** Crossref's journal search for a ScienceDirect address's name. */
export function crossrefJournalQueryUrl(slug: string): string {
  return `https://api.crossref.org/journals?query=${encodeURIComponent(slug.replace(/-/g, " "))}&rows=5`;
}

const letters = (v: string) => v.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The one Elsevier journal whose title is exactly the ScienceDirect address's name, with its print ISSN first. Nothing
 * when none or several match: a near miss would be another journal.
 */
export function readCrossrefJournalSearch(data: unknown, slug: string): CrossrefJournal | null {
  const items = (data as { message?: { items?: unknown } } | null)?.message?.items;
  if (!Array.isArray(items)) return null;
  const want = letters(slug);
  const matches = items.filter((i) => {
    const it = i as { title?: unknown; publisher?: unknown };
    return typeof it?.title === "string" && letters(it.title) === want && typeof it.publisher === "string" && issnPlatform(it.publisher) === "sciencedirect";
  }) as { title: string; publisher: string; "issn-type"?: { type?: unknown; value?: unknown }[]; ISSN?: unknown }[];
  if (matches.length !== 1) return null;
  const m = matches[0]!;
  return readCrossrefWork({ message: { "container-title": [m.title], publisher: m.publisher, "issn-type": m["issn-type"], ISSN: m.ISSN } });
}
