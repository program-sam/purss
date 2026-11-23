import { server } from "@purss/translations/server";
import { decodeBody } from "./content-type.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { Resolver, SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { WIKIDATA_API } from "./wikidata.ts";

/*
 * Searching websites by name. Wikidata, the open knowledge base, is asked which items are called what the person typed
 * (`wbsearchentities`), then for those items' official websites (P856). What was typed goes there, and nothing else. A hit is
 * only a name, Wikidata's one-line description and a website; following it goes through discovery, which searches that
 * website like any pasted address (and, when the site has no feed, asks Wikidata again for a feed it records, P1019).
 */

export const SITE_DIRECTORY = server.sources.connectors.siteSearch.directory;
/** Items asked about per search: the first few matches are the ones a person means. */
const MAX_ITEMS = 10;
const MAX_HITS = 8;

export type SiteHit = {
  name: string;
  /** Wikidata's short description ("American technology news website"), when it has one. */
  description: string | null;
  /** The official website, http or https only. */
  siteUrl: string;
};

export type SiteSearch =
  | { ok: true; hits: SiteHit[] }
  /** `retryAfterMs`: Wikidata is limiting requests and said how long to wait (at least a minute is assumed when it didn't). */
  | { ok: false; reason: "unreachable" | "timeout"; message: string; retryAfterMs?: number };

export type SiteSearchOptions = {
  signal?: AbortSignal;
  fetch?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** TEST ONLY, forwarded to safeFetch. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, forwarded to safeFetch. */
  resolver?: Resolver;
  /** TEST ONLY, forwarded to safeFetch. */
  testTlsCa?: string | Buffer;
  /** TEST ONLY: where the search is sent instead of Wikidata's. */
  endpoint?: string;
};

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function website(v: unknown): string | null {
  const u = text(v, 2000);
  if (!u) return null;
  try {
    const url = new URL(u);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The same site written another way (`http`, `www.`, a trailing slash) is one hit. */
function siteKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
}

/** An item's official website, leaving out deprecated statements (Wikidata keeps a retired address that way); the preferred one first. */
function officialWebsite(claims: unknown): string | null {
  const list = Array.isArray((claims as Record<string, unknown> | null)?.P856) ? ((claims as Record<string, unknown>).P856 as { rank?: unknown; mainsnak?: { datavalue?: { value?: unknown } } }[]) : [];
  const ranked = [...list.filter((c) => c?.rank === "preferred"), ...list.filter((c) => c?.rank === "normal")];
  for (const c of ranked) {
    const site = website(c?.mainsnak?.datavalue?.value);
    if (site) return site;
  }
  return null;
}

type Asked = { ok: true; data: unknown } | { ok: false; failure: Extract<SiteSearch, { ok: false }> };

async function ask(url: string, opts: SiteSearchOptions): Promise<Asked> {
  const res = await (opts.fetch ?? safeFetch)(url, {
    signal: opts.signal,
    maxBytes: 512 * 1024,
    accept: "application/json",
    timeoutMs: 10_000,
    phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 6000 },
    testAllowAddress: opts.testAllowAddress,
    resolver: opts.resolver,
    testTlsCa: opts.testTlsCa,
  });
  const copy = server.sources.connectors.siteSearch;
  if (!res.ok) {
    if (res.reason === "timeout" || res.reason === "aborted") return { ok: false, failure: { ok: false, reason: "timeout", message: copy.slow(SITE_DIRECTORY) } };
    return { ok: false, failure: { ok: false, reason: "unreachable", message: copy.unreachable(SITE_DIRECTORY) } };
  }
  if (res.response.status === 429 || res.response.status >= 500) {
    const seconds = Number(res.response.headers["retry-after"]);
    const retryAfterMs = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 0, 60), 3600) * 1000;
    return { ok: false, failure: { ok: false, reason: "unreachable", message: copy.busy(SITE_DIRECTORY), ...(res.response.status === 429 ? { retryAfterMs } : {}) } };
  }
  if (res.response.status !== 200) return { ok: false, failure: { ok: false, reason: "unreachable", message: copy.unexpected(SITE_DIRECTORY, res.response.status) } };
  try {
    return { ok: true, data: JSON.parse(decodeBody(res.response.body, res.response.contentType)) };
  } catch {
    return { ok: false, failure: { ok: false, reason: "unreachable", message: copy.unreadable(SITE_DIRECTORY) } };
  }
}

/** Websites of the things called `query`, best match first. Things without an official website are left out: there is nothing to look at. */
export async function searchSites(query: string, opts: SiteSearchOptions = {}): Promise<SiteSearch> {
  const term = query.replace(/\s+/g, " ").trim().slice(0, 100);
  if (!term) return { ok: true, hits: [] };
  const api = opts.endpoint ?? WIKIDATA_API;
  const found = await ask(`${api}?${new URLSearchParams({ action: "wbsearchentities", format: "json", type: "item", language: "en", uselang: "en", limit: String(MAX_ITEMS), search: term }).toString()}`, opts);
  if (!found.ok) return found.failure;
  const matches: { id: string; name: string; description: string | null }[] = [];
  const raw = (found.data as { search?: unknown } | null)?.search;
  for (const m of Array.isArray(raw) ? raw : []) {
    const row = (m ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" && /^Q\d{1,12}$/.test(row.id) ? row.id : null;
    const name = text(row.label, 200) ?? text((row.match as Record<string, unknown> | undefined)?.text, 200);
    if (id && name && !matches.some((x) => x.id === id)) matches.push({ id, name, description: text(row.description, 200) });
  }
  if (!matches.length) return { ok: true, hits: [] };
  const described = await ask(`${api}?${new URLSearchParams({ action: "wbgetentities", format: "json", props: "claims", ids: matches.slice(0, MAX_ITEMS).map((m) => m.id).join("|") }).toString()}`, opts);
  if (!described.ok) return described.failure;
  const entities = ((described.data as { entities?: unknown } | null)?.entities ?? {}) as Record<string, { claims?: unknown } | undefined>;
  const hits: SiteHit[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const siteUrl = officialWebsite(entities[m.id]?.claims);
    if (!siteUrl || seen.has(siteKey(siteUrl))) continue;
    seen.add(siteKey(siteUrl));
    hits.push({ name: m.name, description: m.description, siteUrl });
    if (hits.length >= MAX_HITS) break;
  }
  return { ok: true, hits };
}
