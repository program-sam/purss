/*
 * What a page offers to follow, read from the page the person has open (a content script, plan/32):
 * the feeds it advertises with <link rel="alternate">, or the YouTube channel it belongs to. Only
 * addresses leave the page, and only into the PURSS's own Add source, which looks them up through
 * its usual safe fetching when the person presses Find. The extension never reads a feed itself.
 */

export type FeedHint = { url: string; title: string | null };
export type YouTubeHint = { url: string; name: string | null; exact: boolean };
export type PageInfo = { feeds: FeedHint[]; youtube: YouTubeHint | null };

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json", "application/rdf+xml"]);
const MAX_FEEDS = 8;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

const webUrl = (href: string | null | undefined, base: string): string | null => {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

const clean = (t: string | null | undefined, max = 200): string | null => {
  const s = (t ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
};

/**
 * The YouTube channel a page belongs to. Channel pages are read from the address (YouTube changes pages
 * without reloading, so the page's head can still describe the previous one). A video names its
 * channel in its microdata; that is used only when the microdata is about this video, otherwise the
 * video's own address is handed over and the PURSS finds the channel from it.
 */
function youtubeOf(doc: Document, page: URL): YouTubeHint | null {
  const path = page.pathname;
  const channel = /^\/(@[^/]+|channel\/UC[\w-]{10,40}|c\/[^/]+|user\/[^/]+)(?:\/|$)/.exec(path);
  if (channel) return { url: `https://www.youtube.com/${channel[1]}`, name: clean(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")), exact: true };
  const video = path === "/watch" ? page.searchParams.get("v") : /^\/(?:shorts|live)\/([\w-]{6,20})/.exec(path)?.[1] ?? null;
  if (!video) return null;
  const about = doc.querySelector('meta[itemprop="identifier"]')?.getAttribute("content") ?? doc.querySelector('meta[itemprop="videoId"]')?.getAttribute("content");
  const author = doc.querySelector('[itemprop="author"] link[itemprop="url"]')?.getAttribute("href");
  const ownerUrl = webUrl(author, page.href);
  if (about === video && ownerUrl && YOUTUBE_HOSTS.has(new URL(ownerUrl).hostname)) {
    const owner = /^\/(@[^/]+|channel\/UC[\w-]{10,40})/.exec(new URL(ownerUrl).pathname);
    if (owner) return { url: `https://www.youtube.com/${owner[1]}`, name: clean(doc.querySelector('[itemprop="author"] link[itemprop="name"]')?.getAttribute("content")), exact: true };
  }
  return { url: `https://www.youtube.com/watch?v=${encodeURIComponent(video)}`, name: null, exact: false };
}

export function collectPageInfo(doc: Document, pageUrl: string): PageInfo {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return { feeds: [], youtube: null }; }
  if (YOUTUBE_HOSTS.has(page.hostname)) return { feeds: [], youtube: youtubeOf(doc, page) };
  const base = webUrl(doc.querySelector("base[href]")?.getAttribute("href"), page.href) ?? page.href;
  const feeds: FeedHint[] = [];
  const seen = new Set<string>();
  for (const link of Array.from(doc.querySelectorAll("link[rel][href]"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (link.getAttribute("type") ?? "").toLowerCase().split(";")[0]!.trim();
    if (!rel.includes("alternate") || !FEED_TYPES.has(type)) continue;
    const url = webUrl(link.getAttribute("href"), base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    feeds.push({ url, title: clean(link.getAttribute("title")) });
    if (feeds.length >= MAX_FEEDS) break;
  }
  return { feeds, youtube: null };
}
