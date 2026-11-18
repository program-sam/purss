import { crossrefWorksToRss, crossrefWorksUrl, safeFetch } from "@purss/connectors";
import type { FetchFn } from "@purss/connectors";
import type { BridgeBackend } from "./router.ts";

/*
 * Crossref as a bridge backend (plan/45): a journal's newest registered articles from Crossref's public API, turned into
 * RSS for the router. Crossref's public pool allows one request at a time and five a second, for everyone sharing this
 * server's address, so the backend asks one journal at a time, a little apart, and after Crossref says "too many" (429)
 * or "unavailable" (503) it asks nothing for any journal until the wait Crossref names is over. The router meanwhile
 * serves each journal's last good answer, or its usual failure.
 *
 * The address is made here from a constant origin and the source's ISSN (checked against the service's key pattern
 * before it gets here); safeFetch's address rules apply, and no redirect is followed.
 */

export type CrossrefLimits = {
  /** Time between the start of one request and the next. */
  spacingMs: number;
  /** The shortest wait after a 429 or 503, whatever Retry-After says. */
  minCooldownMs: number;
  /** The longest: a Retry-After further off than this is taken as a mistake. */
  maxCooldownMs: number;
  timeoutMs: number;
  maxBytes: number;
};

export const DEFAULT_CROSSREF_LIMITS: CrossrefLimits = {
  spacingMs: 250,
  minCooldownMs: 60_000,
  maxCooldownMs: 24 * 60 * 60_000,
  timeoutMs: 30_000,
  maxBytes: 4 * 1024 * 1024,
};

/** Retry-After as a delay in seconds or an HTTP date, in milliseconds from `now`; 0 when absent or unreadable. */
function retryAfterMs(value: string | undefined, now: number): number {
  const v = value?.trim() ?? "";
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

export function crossrefBackend(opts: { fetch?: FetchFn; now?: () => number; sleep?: (ms: number) => Promise<void>; limits?: Partial<CrossrefLimits>; testAllowAddress?: (ip: string) => boolean } = {}): BridgeBackend {
  const fetcher = opts.fetch ?? safeFetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const limits = { ...DEFAULT_CROSSREF_LIMITS, ...opts.limits };
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  let coolUntil = 0;

  const ask = async (key: string): Promise<Awaited<ReturnType<BridgeBackend["fetch"]>>> => {
    if (now() < coolUntil) return { status: 429, body: Buffer.alloc(0) };
    const wait = lastStart + limits.spacingMs - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const r = await fetcher(crossrefWorksUrl(key), {
      maxRedirects: 0,
      timeoutMs: limits.timeoutMs,
      maxBytes: limits.maxBytes,
      accept: "application/json",
      testAllowAddress: opts.testAllowAddress,
    });
    if (!r.ok) return { failed: r.reason === "timeout" ? "timeout" : r.reason === "toolarge" ? "too_large" : "unreachable" };
    const { status, headers, body } = r.response;
    if (status === 429 || status === 503) {
      coolUntil = now() + Math.min(Math.max(retryAfterMs(headers["retry-after"], now()), limits.minCooldownMs), limits.maxCooldownMs);
      return { status, body: Buffer.alloc(0) };
    }
    if (status !== 200) return { status, body: Buffer.alloc(0) };
    try {
      return { status: 200, body: Buffer.from(crossrefWorksToRss(JSON.parse(body.toString("utf8")), key)) };
    } catch {
      // Not Crossref's list of works: the router logs it as a parse failure, never as an empty feed.
      return { status: 200, body: Buffer.from("not a feed") };
    }
  };

  return {
    name: "crossref",
    kind: "crossref",
    fetch(_service, key) {
      // One request at a time, in the order asked.
      const run = chain.then(() => ask(key));
      chain = run.catch(() => {});
      return run;
    },
  };
}
