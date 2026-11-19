import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";

/*
 * Whether a page lets another site show it in a frame: the browser refuses to when the page's
 * response says so, in Content-Security-Policy `frame-ancestors` or, without that, X-Frame-Options. A refused
 * frame looks loaded to the page around it, so the reader asks the server first and frames only pages whose
 * headers allow its own origin. The rules below follow the browsers' (CSP Level 3 and the HTML standard).
 */

type Origin = { scheme: string; host: string; port: number | null };

function originOf(url: URL): Origin {
  return { scheme: url.protocol.slice(0, -1), host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : null };
}

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

/** A scheme in a source matches the same scheme, and http matches its upgrade to https. */
function schemeMatches(source: string, scheme: string): boolean {
  return source === scheme || (source === "http" && scheme === "https");
}

function sameOrigin(a: Origin, b: Origin): boolean {
  return a.scheme === b.scheme && a.host === b.host && (a.port ?? DEFAULT_PORT[a.scheme]) === (b.port ?? DEFAULT_PORT[b.scheme]);
}

/** One source expression of `frame-ancestors`, against the embedding page's origin. */
function sourceMatches(raw: string, embedder: Origin, page: Origin): boolean {
  const s = raw.toLowerCase();
  if (s === "*") return embedder.scheme === "http" || embedder.scheme === "https";
  if (s === "'self'") return sameOrigin(embedder, page) || (page.scheme === "http" && embedder.scheme === "https" && embedder.host === page.host && embedder.port === null && page.port === null);
  if (s.startsWith("'")) return false; // 'none' and keywords that mean nothing for frames
  const schemeOnly = /^([a-z][a-z0-9+.-]*):$/.exec(s);
  if (schemeOnly) return schemeMatches(schemeOnly[1]!, embedder.scheme);
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|\d+))?(\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  if (scheme ? !schemeMatches(scheme, embedder.scheme) : !schemeMatches(page.scheme, embedder.scheme)) return false;
  if (host !== "*" && (host!.startsWith("*.") ? !embedder.host.endsWith(host!.slice(1)) : host !== embedder.host)) return false;
  if (port !== "*") {
    const want = port ? Number(port) : null;
    const have = embedder.port ?? DEFAULT_PORT[embedder.scheme];
    if (want === null ? embedder.port !== null : want !== have) return false;
  }
  // The embedding page is compared as an origin, which has no path.
  return !path || path === "/";
}

/**
 * Whether a response with these headers (lower-cased names, repeated headers joined with ", ") may be shown
 * in a frame on `embedderOrigin`. `pageUrl` is the address that answered (after redirects): `'self'` and
 * SAMEORIGIN mean that page's own origin.
 */
export function framingAllowed(headers: Record<string, string>, pageUrl: string, embedderOrigin: string): boolean {
  const embedder = originOf(new URL(embedderOrigin));
  const page = originOf(new URL(pageUrl));
  // Each enforced policy that names frame-ancestors must allow the frame; a policy names it once (the first counts).
  const lists = (headers["content-security-policy"] ?? "").split(",").flatMap((policy) => {
    const directive = policy.split(";").map((d) => d.trim().split(/\s+/)).find(([name]) => name?.toLowerCase() === "frame-ancestors");
    return directive ? [directive.slice(1).filter(Boolean)] : [];
  });
  if (lists.length) return lists.every((sources) => sources.some((s) => sourceMatches(s, embedder, page)));
  // X-Frame-Options counts only without frame-ancestors. Values the browsers don't know (ALLOW-FROM) allow framing.
  const xfo = (headers["x-frame-options"] ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (xfo.includes("deny")) return false;
  if (xfo.includes("sameorigin")) return sameOrigin(embedder, page);
  return true;
}

export type FrameCheck = { frame: true; url: string } | { frame: false };

export type FrameCheckOptions = {
  signal?: AbortSignal;
  /** Replacement fetcher (tests); defaults to safeFetch. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
};

/**
 * Whether the page at `url` can be shown in a frame on `embedderOrigin`, and the address to frame (where its
 * redirects end). Only the headers count, so only the start of the page is read. A page that doesn't answer
 * with success (a bot wall, an error) is never framed: its real headers are unknown. Nor is a download.
 */
export async function checkFraming(url: string, embedderOrigin: string, opts: FrameCheckOptions = {}): Promise<FrameCheck> {
  const fetcher = opts.fetch ?? safeFetch;
  const res = await fetcher(url, {
    signal: opts.signal,
    maxBytes: 16 * 1024,
    allowPartial: true,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    timeoutMs: 8000,
    phaseTimeoutsMs: { firstByteMs: 6000, idleMs: 4000 },
  });
  if (!res.ok || res.response.status < 200 || res.response.status > 299) return { frame: false };
  // A file to save keeps its behaviour: a frame (sandboxed without downloads) would swallow it.
  if (/^\s*attachment\b/i.test(res.response.headers["content-disposition"] ?? "")) return { frame: false };
  const final = res.response.url;
  // A secure page can't frame a plain one: the browser blocks it as mixed content.
  if (new URL(embedderOrigin).protocol === "https:" && !final.startsWith("https:")) return { frame: false };
  return framingAllowed(res.response.headers, final, embedderOrigin) ? { frame: true, url: final } : { frame: false };
}
