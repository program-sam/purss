import { server } from "@purss/translations/server";
import { normalIssn, resolverUrl } from "./journals.ts";
import { escapeXml } from "./text.ts";

/*
 * Journals followed through Crossref, the open registry where publishers register every article's DOI. The
 * bridge router's Crossref backend asks for a journal's newest registered works and turns Crossref's JSON into RSS here,
 * so the router re-serves it like any backend's output; discovery uses the same addresses to preview a journal and to
 * find a journal by its ISSN or name. Pure functions: every rule is tested on recorded answers.
 */

export const CROSSREF_API = "https://api.crossref.org";

/** `15348687` → `1534-8687`, the form Crossref's addresses use. */
export function hyphenIssn(issn: string): string {
  return `${issn.slice(0, 4)}-${issn.slice(4)}`;
}

const WORK_FIELDS = "DOI,title,subtitle,author,abstract,created,published-online,type,container-title";
/** Entries asked for: enough to cover a busy journal's week, most of which the engine has already seen. */
const ROWS = 40;

/**
 * A journal's newest works, ordered by when their DOI was registered: an old article whose record is corrected later
 * doesn't come back to the top, as it would by the record's last update.
 */
export function crossrefWorksUrl(issn: string): string {
  return `${CROSSREF_API}/journals/${hyphenIssn(issn)}/works?sort=created&order=desc&rows=${ROWS}&select=${WORK_FIELDS}`;
}

/** Crossref's record of one journal (its title, publisher and ISSNs). */
export function crossrefJournalUrl(issn: string): string {
  return `${CROSSREF_API}/journals/${hyphenIssn(issn)}`;
}

/** Crossref's journal search for a name. */
export function crossrefJournalSearchUrl(name: string): string {
  return `${CROSSREF_API}/journals?query=${encodeURIComponent(name)}&rows=10`;
}

/** The journal's own pages that are not articles: one per issue, and nothing to read. */
const FRONT_MATTER = /^(?:issue information(?:\s*[-–—:]\s*.*)?|cover image|cover|masthead|editorial board|table of contents|front matter|back matter|front cover|back cover|issue cover|ifc|ibc|obc|toc)$/i;

type Person = { given?: unknown; family?: unknown; name?: unknown };
type DateParts = { "date-parts"?: unknown; "date-time"?: unknown };
type Work = {
  DOI?: unknown;
  title?: unknown;
  subtitle?: unknown;
  author?: unknown;
  abstract?: unknown;
  created?: DateParts;
  "published-online"?: DateParts;
  type?: unknown;
  "container-title"?: unknown;
};

const firstText = (v: unknown): string => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : typeof v === "string" ? v : "").replace(/\s+/g, " ").trim();

/** Crossref titles carry inline JATS and HTML (`<i>`, `<sub>`); a title is plain text. */
function plainTitle(v: unknown): string {
  return decodeEntities(firstText(v).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function authors(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const names = (v as Person[])
    .map((p) => (typeof p?.name === "string" ? p.name : [p?.given, p?.family].filter((x): x is string => typeof x === "string").join(" ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!names.length) return null;
  return names.length > 10 ? `${names.slice(0, 10).join(", ")} et al.` : names.join(", ");
}

/**
 * An abstract's JATS as paragraphs of plain text: `<jats:p>` (or `<p>`) is a paragraph, a heading ("Abstract",
 * "Background") stays as its words, every other tag goes. The router sanitises the HTML again when it re-serves it.
 */
function abstractHtml(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const paragraphs = v
    .replace(/<(?:jats:)?title[^>]*>[\s\S]*?<\/(?:jats:)?title>/gi, (m) => (/^\s*<[^>]*>\s*abstract\s*<\/[^>]*>\s*$/i.test(m) ? "" : `${m}\n\n`))
    .split(/<\/(?:jats:)?p\s*>|<\/(?:jats:)?title\s*>/i)
    .map((p) => decodeEntities(p.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join("") : null;
}

/** `published-online` when it names a day, else when the DOI was registered. */
function publishedAt(w: Work): string | null {
  const parts = (w["published-online"]?.["date-parts"] as unknown[][] | undefined)?.[0];
  if (Array.isArray(parts) && parts.length === 3 && parts.every((n) => typeof n === "number")) {
    const [y, m, d] = parts as number[];
    const t = Date.UTC(y!, m! - 1, d!);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const created = w.created?.["date-time"];
  return typeof created === "string" && !Number.isNaN(Date.parse(created)) ? new Date(Date.parse(created)).toISOString() : null;
}

function rfc822(iso: string | null): string | null {
  return iso ? new Date(iso).toUTCString() : null;
}

/**
 * A journal's works as RSS: one item per article, linked to its DOI at doi.org (`resolverUrl`, so a DOI with `#` or `<`
 * stays one address). Entries that aren't journal articles and the journal's own front matter are left out. The channel
 * is named after the journal, else after its ISSN.
 */
export function crossrefWorksToRss(data: unknown, issn: string): string {
  const items = (data as { message?: { items?: unknown } } | null)?.message?.items;
  if (!Array.isArray(items)) throw new Error("Crossref answered without a list of works.");
  let journal = "";
  const out: string[] = [];
  for (const raw of items as Work[]) {
    if (!journal) journal = plainTitle(raw?.["container-title"]);
    if (raw?.type !== "journal-article" || typeof raw.DOI !== "string" || !/^10\.\d{4,9}\/\S+$/.test(raw.DOI)) continue;
    const title = plainTitle(raw.title);
    if (!title || FRONT_MATTER.test(title)) continue;
    const subtitle = plainTitle(raw.subtitle);
    const parts = [`<title>${escapeXml(subtitle && !title.toLowerCase().includes(subtitle.toLowerCase()) ? `${title}: ${subtitle}` : title)}</title>`];
    const link = resolverUrl(raw.DOI);
    parts.push(`<link>${escapeXml(link)}</link>`, `<guid isPermaLink="false">${escapeXml(`doi:${raw.DOI.toLowerCase()}`)}</guid>`);
    const who = authors(raw.author);
    if (who) parts.push(`<dc:creator>${escapeXml(who)}</dc:creator>`);
    const date = rfc822(publishedAt(raw));
    if (date) parts.push(`<pubDate>${date}</pubDate>`);
    const summary = abstractHtml(raw.abstract);
    if (summary) parts.push(`<description>${escapeXml(summary)}</description>`);
    out.push(`<item>${parts.join("")}</item>`);
  }
  const name = journal || server.sources.connectors.crossref.issnTitle(hyphenIssn(issn));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>',
    `<title>${escapeXml(name)}</title>`,
    `<link>${escapeXml(issnPortalUrl(issn))}</link>`,
    `<description>${escapeXml(server.sources.connectors.crossref.description(hyphenIssn(issn)))}</description>`,
    ...out,
    "</channel></rss>",
  ].join("");
}

/** The ISSN portal's page of a journal: a Crossref source's site address, and what OPML exports. */
export function issnPortalUrl(issn: string): string {
  return `https://portal.issn.org/resource/ISSN/${hyphenIssn(issn)}`;
}

/** The ISSN an ISSN portal address names, or null. */
export function issnFromPortalUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "portal.issn.org") return null;
  const m = /^\/resource\/issn(?:-l)?\/([0-9]{4}-?[0-9]{3}[0-9xX])\/?$/i.exec(url.pathname);
  return m ? normalIssn(m[1]!) : null;
}

/** A bare ISSN as pasted (`1534-8687`, `ISSN 1534-8687`, `eISSN: 15348687`), or null. Eight digits alone are a number, not an ISSN. */
export function issnFromInput(raw: string): string | null {
  const t = raw.trim();
  const m = /^(?:(?:e-?|p-?)?issn\s*:?\s*([0-9]{4}-?[0-9]{3}[0-9xX])|([0-9]{4}-[0-9]{3}[0-9xX]))$/i.exec(t);
  return m ? normalIssn((m[1] ?? m[2])!) : null;
}

/** What Crossref says about one journal: its title, publisher and ISSNs, electronic first. */
export type CrossrefJournalRecord = { title: string | null; publisher: string | null; issns: string[] };

function journalRecord(m: Record<string, unknown>): CrossrefJournalRecord {
  const typed = Array.isArray(m["issn-type"]) ? (m["issn-type"] as { type?: unknown; value?: unknown }[]) : [];
  const byType = (t: string) => typed.filter((x) => x?.type === t && typeof x.value === "string").map((x) => x.value as string);
  const plain = Array.isArray(m.ISSN) ? (m.ISSN as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const issns = [...new Set([...byType("electronic"), ...byType("print"), ...plain].map(normalIssn).filter((v): v is string => !!v))].slice(0, 4);
  return {
    title: typeof m.title === "string" ? m.title.replace(/\s+/g, " ").trim().slice(0, 300) || null : null,
    publisher: typeof m.publisher === "string" ? m.publisher.slice(0, 200) : null,
    issns,
  };
}

/** Read Crossref's record of one journal (`/journals/<issn>`). */
export function readCrossrefJournal(data: unknown): CrossrefJournalRecord | null {
  const m = (data as { message?: unknown } | null)?.message;
  return m && typeof m === "object" ? journalRecord(m as Record<string, unknown>) : null;
}

const letters = (v: string) => v.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The one journal in a Crossref search whose title is exactly `name` (letters compared, so "Social Anthropology/
 * Anthropologie sociale" and "Social Anthropology / Anthropologie Sociale" are one), from a publisher `publisher`
 * matches when given. Nothing when none or several match: a near miss would be another journal.
 */
export function findCrossrefJournal(data: unknown, name: string, publisher?: RegExp): CrossrefJournalRecord | null {
  const items = (data as { message?: { items?: unknown } } | null)?.message?.items;
  if (!Array.isArray(items)) return null;
  const want = letters(name);
  if (!want) return null;
  const matches = items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map(journalRecord)
    .filter((j) => j.title && letters(j.title) === want && j.issns.length && (!publisher || (j.publisher && publisher.test(j.publisher))));
  // Crossref lists one journal more than once when its records came in under different titles or publishers.
  const distinct = new Map(matches.map((j) => [j.issns.slice().sort().join(","), j]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}
