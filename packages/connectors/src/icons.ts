import { parseFeed } from "./feed.ts";
import { normalizeIcon } from "./image.ts";
import type { IconImage, IconRejection } from "./image.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { parseHtmlTree, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";
import { isYoutubeHost } from "./youtube.ts";

/**
 * Finds a source's own icon: the image its feed declares (podcast artwork, Atom logo,
 * JSON Feed icon), a YouTube channel's avatar, or the icons its website advertises
 * (apple-touch-icon, <link rel=icon>, the web app manifest, /favicon.ico). Every fetch
 * goes through the safe fetcher. Candidates are tried in that order. The first one
 * at least GOOD_SIDE pixels wide wins; otherwise the largest usable one does.
 */

export type IconSourceInput = {
  kind: string;
  /** Null for private sources: a secret feed link is never fetched for an icon. */
  feedUrl: string | null;
  siteUrl: string | null;
};

export type IconFound = IconImage & { from: string };
export type IconLookup = { ok: true; icon: IconFound; tried: number } | { ok: false; tried: number; reasons: string[] };

type FetchFn = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
export type ResolveIconOptions = { signal?: AbortSignal; fetch?: FetchFn };

/** Requests one lookup may make, pages and images together. */
const MAX_REQUESTS = 14;
const GOOD_SIDE = 64;
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const PAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/x-icon,image/vnd.microsoft.icon,image/webp,image/gif;q=0.8,*/*;q=0.1";

type Candidate = { url: string; size: number | null };

export async function resolveSourceIcon(input: IconSourceInput, opts: ResolveIconOptions = {}): Promise<IconLookup> {
  const fetch = opts.fetch ?? safeFetch;
  let requests = 0;
  const reasons: string[] = [];
  const get = async (url: string, o: SafeFetchOptions): Promise<SafeFetchResult | null> => {
    if (requests >= MAX_REQUESTS || opts.signal?.aborted) return null;
    requests++;
    return fetch(url, { timeoutMs: 15_000, ...o, signal: opts.signal });
  };
  const tried = new Set<string>();
  let best: IconFound | null = null;

  /** Fetch and normalize one candidate; true once a good enough icon is found. */
  const attempt = async (c: Candidate): Promise<boolean> => {
    if (tried.has(c.url)) return false;
    tried.add(c.url);
    const res = await get(c.url, { maxBytes: IMAGE_MAX_BYTES, accept: IMAGE_ACCEPT });
    if (!res) return false;
    if (!res.ok) { reasons.push(`${res.reason}`); return false; }
    if (res.response.status !== 200) { reasons.push(`http ${res.response.status}`); return false; }
    const n = await normalizeIcon(res.response.body);
    if (!n.ok) { reasons.push(rejection(n.reason)); return false; }
    const found: IconFound = { mime: n.mime, data: n.data, width: n.width, height: n.height, from: res.response.url };
    if (!best || found.width > best.width) best = found;
    return found.width >= GOOD_SIDE;
  };
  const tryAll = async (list: Candidate[]): Promise<boolean> => {
    for (const c of list) if (await attempt(c)) return true;
    return false;
  };
  const done = (): IconLookup => (best ? { ok: true, icon: best, tried: requests } : { ok: false, tried: requests, reasons });

  let siteUrl = httpUrl(input.siteUrl);

  if (input.feedUrl) {
    const res = await get(input.feedUrl, { maxBytes: 2 * 1024 * 1024, allowPartial: true });
    if (res?.ok && res.response.status === 200) {
      try {
        const feed = parseFeed(res.response.body, res.response.contentType);
        siteUrl ??= httpUrl(feed.siteUrl);
        const image = httpUrl(feed.imageUrl);
        if (image && (await attempt({ url: image, size: null }))) return done();
      } catch {
        reasons.push("feed unreadable");
      }
    } else if (res) {
      reasons.push(res.ok ? `feed http ${res.response.status}` : `feed ${res.reason}`);
    }
  }

  if (!siteUrl) return done();
  const site = new URL(siteUrl);

  if (isYoutubeHost(site.hostname)) {
    // A channel page's og:image is the channel avatar. YouTube's own favicon would make
    // every channel look the same, so a YouTube source never falls back to it.
    if (!/^\/(?:channel\/UC[\w-]{22}|@[^/]+|user\/[^/]+|c\/[^/]+)\/?$/.test(site.pathname)) return done();
    const page = await get(siteUrl, { maxBytes: 2 * 1024 * 1024, allowPartial: true, accept: "text/html" });
    if (page?.ok && page.response.status === 200 && !new URL(page.response.url).hostname.startsWith("consent.")) {
      const avatar = ogImage(page.response.body.toString("utf8"), page.response.url);
      if (avatar) await attempt({ url: avatar, size: null });
    }
    return done();
  }

  // The site's page, then its home page, then the home page of the feed's own host (a feed's
  // site link is sometimes a dead feeds.* address while www.* is fine). A podcast's feed host is
  // its hosting platform, and so is a site on that platform's domain: their icons are the
  // platform's logo, not the show's, so those are skipped.
  const podcast = input.kind === "podcast";
  const feedHost = input.feedUrl ? new URL(input.feedUrl).hostname : null;
  const onPlatform = (host: string) => podcast && feedHost !== null && baseDomain(host) === baseDomain(feedHost);
  const pages = [siteUrl, `${site.origin}/`, ...(feedHost && !podcast ? [`${new URL(input.feedUrl!).origin}/`] : [])]
    .filter((u, i, all) => all.indexOf(u) === i && !onPlatform(new URL(u).hostname));
  const refused = new Set<string>();
  for (const pageUrl of pages) {
    const origin = new URL(pageUrl).origin;
    if (refused.has(origin)) continue;
    const page = await get(pageUrl, { maxBytes: PAGE_MAX_BYTES, allowPartial: true, accept: "text/html,application/xhtml+xml" });
    if (!page) break;
    if (!page.ok || page.response.status !== 200 || !page.response.mediaType.includes("html")) {
      if (page.ok && [401, 403, 429].includes(page.response.status)) refused.add(origin);
      reasons.push(page.ok ? `page http ${page.response.status}` : `page ${page.reason}`);
      continue;
    }
    const at = page.response.url;
    const facts = pageIcons(page.response.body.toString("utf8"), at);
    if (await tryAll(facts.icons.slice(0, 3))) return done();
    if (facts.manifest) {
      const res = await get(facts.manifest, { maxBytes: 256 * 1024, accept: "application/manifest+json,application/json" });
      if (res?.ok && res.response.status === 200 && (await tryAll(manifestIcons(res.response.body.toString("utf8"), res.response.url).slice(0, 2)))) return done();
    }
    if (!onPlatform(new URL(at).hostname)) await attempt({ url: `${new URL(at).origin}/favicon.ico`, size: null });
    if (best) return done();
  }
  return done();
}

/** Registrable domain, near enough: the last two labels, or three under a two-letter country's com/co/org/... */
function baseDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  const n = labels.length >= 3 && labels.at(-1)!.length === 2 && /^(?:co|com|org|net|ac|gov|edu|or|ne)$/.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-n).join(".");
}

function rejection(r: IconRejection): string {
  return { format: "not an image", corrupt: "unreadable image", toolarge: "image too large", small: "image too small", shape: "not square", empty: "blank image" }[r];
}

function httpUrl(value: string | null | undefined, base?: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** Largest side from a sizes attribute ("32x32 180x180", "any" counts as big). */
function declaredSize(sizes: string | undefined): number | null {
  if (!sizes) return null;
  if (/\bany\b/i.test(sizes)) return 512;
  let max = 0;
  for (const m of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) max = Math.max(max, Number(m[1]));
  return max || null;
}

const isSvg = (url: string, type: string | undefined) => /svg/i.test(type ?? "") || /\.svgz?(?:$|[?#])/i.test(url);

/** Best first: big declared sizes, then apple-touch-icon (180 px by convention), then plain icons. */
function rank(list: (Candidate & { apple: boolean })[]): Candidate[] {
  const score = (c: Candidate & { apple: boolean }) => {
    const s = c.size ?? (c.apple ? 180 : 32);
    return s >= GOOD_SIDE ? 10_000 - Math.abs(s - 192) : s;
  };
  return list.sort((a, b) => score(b) - score(a)).map(({ url, size }) => ({ url, size }));
}

/** og:image by pattern: a YouTube page is too large and deep for the HTML tree parser. */
export function ogImage(html: string, pageUrl: string): string | null {
  const tag = html.match(/<meta\b[^>]*\bproperty=["']og:image["'][^>]*>/i)?.[0];
  const content = tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  return content ? httpUrl(content.replace(/&amp;/g, "&"), pageUrl) : null;
}

export function pageIcons(html: string, pageUrl: string): { icons: Candidate[]; manifest: string | null } {
  let root: XNode;
  try {
    root = parseHtmlTree(html);
  } catch (error) {
    if (error instanceof TooComplexError) return { icons: [], manifest: null };
    throw error;
  }
  let base = pageUrl;
  const found: (Candidate & { apple: boolean })[] = [];
  let manifest: string | null = null;
  const stack: XNode[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 200_000) {
    const node = stack.pop()!;
    if (node.type === "tag") {
      const name = (node.name ?? "").toLowerCase();
      const a = node.attribs ?? {};
      if (name === "base" && a.href) base = httpUrl(a.href, pageUrl) ?? base;
      else if (name === "link" && a.href) {
        const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
        const url = httpUrl(a.href, base);
        if (url && rel.includes("manifest")) manifest ??= url;
        else if (url && !isSvg(url, a.type) && (rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed"))) {
          found.push({ url, size: declaredSize(a.sizes), apple: rel.some((r) => r.startsWith("apple-touch-icon")) });
        }
      }
      // Icons live in <head>; once <body> starts there is nothing more to find.
      if (name === "body") break;
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return { icons: rank(found), manifest };
}

export function manifestIcons(json: string, manifestUrl: string): Candidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const icons = (parsed as { icons?: unknown })?.icons;
  if (!Array.isArray(icons)) return [];
  const list: (Candidate & { apple: boolean })[] = [];
  for (const i of icons.slice(0, 50)) {
    if (!i || typeof i !== "object") continue;
    const { src, sizes, type, purpose } = i as Record<string, unknown>;
    if (typeof src !== "string") continue;
    // Maskable icons carry a safe-zone margin meant to be cropped; prefer plain ones.
    if (typeof purpose === "string" && !/\bany\b/.test(purpose) && /maskable|monochrome/.test(purpose)) continue;
    const url = httpUrl(src, manifestUrl);
    if (!url || isSvg(url, typeof type === "string" ? type : undefined)) continue;
    list.push({ url, size: declaredSize(typeof sizes === "string" ? sizes : undefined), apple: false });
  }
  return rank(list);
}
