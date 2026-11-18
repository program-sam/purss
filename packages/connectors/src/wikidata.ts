/*
 * Wikidata as discovery's last resort (plan/46): which item has a page as its official website (P856), and what Wikidata
 * says about it: its feeds (P1019) and, for a journal or newspaper, its ISSNs (P236). Asked through the Action API with an
 * exact statement search over the page address's spellings, then the matching items' claims. Pure functions: the
 * requests are made by discovery's own fetcher.
 */

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

/** Items looked at per lookup: an address is rarely the official website of more than a few. */
const MAX_ITEMS = 5;

/**
 * The spellings under which Wikidata may record a page as an official website: `http` and `https`, with and without
 * `www.`, with and without a trailing slash. Never a query string or fragment.
 */
export function addressVariants(url: URL): string[] {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const hosts = host.startsWith("www.") ? [host, host.slice(4)] : [host, `www.${host}`];
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  const paths = path ? [path, `${path}/`] : ["", "/"];
  const out: string[] = [];
  for (const scheme of ["https", "http"]) for (const h of hosts) for (const p of paths) out.push(`${scheme}://${h}${port}${p}`);
  return out;
}

/** Longest request address sent: safeFetch refuses addresses over 2,048 characters. */
const MAX_URL = 2000;

/**
 * The search for items whose official website is one of `addresses`; addresses the search syntax can't hold are left out.
 * Null when there is nothing to ask, or when the search would be too long an address to send.
 */
export function wikidataSearchUrl(addresses: readonly string[]): string | null {
  const usable = addresses.filter((a) => /^https?:\/\/[^\s|"]+$/.test(a));
  if (!usable.length) return null;
  const query = `haswbstatement:${usable.map((a) => `P856=${a}`).join("|")}`;
  const url = `${WIKIDATA_API}?action=query&list=search&format=json&srlimit=${MAX_ITEMS}&srsearch=${encodeURIComponent(query)}`;
  return url.length <= MAX_URL ? url : null;
}

/** The item ids a search found. */
export function readWikidataSearch(data: unknown): string[] {
  const hits = (data as { query?: { search?: unknown } } | null)?.query?.search;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => (h as { title?: unknown })?.title).filter((t): t is string => typeof t === "string" && /^Q\d{1,12}$/.test(t)).slice(0, MAX_ITEMS);
}

export function wikidataEntitiesUrl(ids: readonly string[]): string {
  return `${WIKIDATA_API}?action=wbgetentities&format=json&props=claims&ids=${ids.slice(0, MAX_ITEMS).join("|")}`;
}

export type WikidataItem = { id: string; websites: string[]; feeds: string[]; issns: string[] };

/** A claim's string values, leaving out deprecated ones (Wikidata keeps a retired address or feed that way). */
function values(claims: Record<string, unknown>, property: string): string[] {
  const list = Array.isArray(claims[property]) ? (claims[property] as { rank?: unknown; mainsnak?: { datavalue?: { value?: unknown } } }[]) : [];
  return list.filter((c) => c?.rank !== "deprecated").map((c) => c?.mainsnak?.datavalue?.value).filter((v): v is string => typeof v === "string");
}

/** The items as Wikidata describes them, with their websites, feeds (web addresses only) and ISSNs. */
export function readWikidataEntities(data: unknown): WikidataItem[] {
  const entities = (data as { entities?: unknown } | null)?.entities;
  if (!entities || typeof entities !== "object") return [];
  const out: WikidataItem[] = [];
  for (const [id, raw] of Object.entries(entities as Record<string, unknown>)) {
    const claims = (raw as { claims?: unknown } | null)?.claims;
    if (!/^Q\d{1,12}$/.test(id) || !claims || typeof claims !== "object") continue;
    const c = claims as Record<string, unknown>;
    out.push({
      id,
      websites: values(c, "P856"),
      feeds: [...new Set(values(c, "P1019").filter((f) => /^https?:\/\/\S+$/i.test(f)))].slice(0, 8),
      issns: [...new Set(values(c, "P236"))].slice(0, 4),
    });
  }
  return out;
}
