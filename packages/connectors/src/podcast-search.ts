import { decodeBody } from "./content-type.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { Resolver, SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";

/*
 * Searching podcasts by name. The one directory asked is Apple's podcast directory (the iTunes Search API): what the
 * person typed goes there, and nothing else. The request goes through safeFetch like every other lookup, so the same
 * address rules apply. A hit is only a name, an author, a picture and the show's own feed address; following it goes
 * through discovery, which fetches and previews that feed like any other.
 */

export const PODCAST_DIRECTORY = "Apple's podcast directory";
const SEARCH_URL = "https://itunes.apple.com/search";
const MAX_HITS = 10;

export type PodcastHit = {
  name: string;
  author: string | null;
  /** A picture of the show, https only. */
  artworkUrl: string | null;
  feedUrl: string;
  genre: string | null;
};

export type PodcastSearch =
  | { ok: true; hits: PodcastHit[] }
  | { ok: false; reason: "unreachable" | "timeout"; message: string };

export type PodcastSearchOptions = {
  signal?: AbortSignal;
  fetch?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** TEST ONLY, forwarded to safeFetch. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, forwarded to safeFetch. */
  resolver?: Resolver;
  /** TEST ONLY, forwarded to safeFetch. */
  testTlsCa?: string | Buffer;
  /** TEST ONLY: where the search is sent instead of Apple's. */
  endpoint?: string;
};

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const webUrl = (v: unknown, protocols: readonly string[]): string | null => {
  const u = text(v, 2000);
  if (!u) return null;
  try {
    return protocols.includes(new URL(u).protocol) ? u : null;
  } catch {
    return null;
  }
};

/** The shows whose name matches `query`, best match first. Shows without a public feed address are left out: there is nothing to follow. */
export async function searchPodcasts(query: string, opts: PodcastSearchOptions = {}): Promise<PodcastSearch> {
  const term = query.replace(/\s+/g, " ").trim().slice(0, 100);
  if (!term) return { ok: true, hits: [] };
  const url = `${opts.endpoint ?? SEARCH_URL}?${new URLSearchParams({ media: "podcast", entity: "podcast", limit: "20", term }).toString()}`;
  const fetcher = opts.fetch ?? safeFetch;
  const res = await fetcher(url, {
    signal: opts.signal,
    maxBytes: 512 * 1024,
    accept: "application/json",
    timeoutMs: 12_000,
    phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 6000 },
    testAllowAddress: opts.testAllowAddress,
    resolver: opts.resolver,
    testTlsCa: opts.testTlsCa,
  });
  if (!res.ok) {
    if (res.reason === "timeout" || res.reason === "aborted") return { ok: false, reason: "timeout", message: `${PODCAST_DIRECTORY} was slow to answer. Try again in a moment.` };
    return { ok: false, reason: "unreachable", message: `We couldn't reach ${PODCAST_DIRECTORY} just now. Try again later, or paste the show's website or feed address.` };
  }
  if (res.response.status === 429 || res.response.status >= 500) return { ok: false, reason: "unreachable", message: `${PODCAST_DIRECTORY} is busy or limiting searches. Try again in a few minutes.` };
  if (res.response.status !== 200) return { ok: false, reason: "unreachable", message: `${PODCAST_DIRECTORY} answered with an unexpected result (${res.response.status}). Try again later.` };
  let results: unknown;
  try {
    results = (JSON.parse(decodeBody(res.response.body, res.response.contentType)) as { results?: unknown }).results;
  } catch {
    return { ok: false, reason: "unreachable", message: `${PODCAST_DIRECTORY} sent something we couldn't read. Try again later.` };
  }
  const hits: PodcastHit[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(results) ? results : []) {
    const row = (r ?? {}) as Record<string, unknown>;
    const feedUrl = webUrl(row.feedUrl, ["https:", "http:"]);
    const name = text(row.collectionName, 200) ?? text(row.trackName, 200);
    if (!feedUrl || !name || seen.has(feedUrl)) continue;
    seen.add(feedUrl);
    hits.push({
      name,
      author: text(row.artistName, 200),
      artworkUrl: webUrl(row.artworkUrl100, ["https:"]) ?? webUrl(row.artworkUrl60, ["https:"]),
      feedUrl,
      genre: text(row.primaryGenreName, 80),
    });
    if (hits.length >= MAX_HITS) break;
  }
  return { ok: true, hits };
}
