import { decodeBody, sniffContent } from "./content-type.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { cleanLine, parseHtmlTree, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";
import { classifyYoutubeUrl, isYoutubeHost, parseOembed } from "./youtube.ts";

/*
 * What a page says about itself, for a link that is kept rather than followed: its title, the site's
 * name, a picture and (for a video) the channel. Taken from Open Graph tags and oEmbed, which pages
 * publish for exactly this purpose. Every request goes through safeFetch; failing to learn anything is a
 * normal outcome (the caller then keeps the bare address), never an error.
 */

export type LinkMetadata = { kind: "video" | "link"; title: string | null; siteName: string | null; author: string | null; imageUrl: string | null };

const HTML_MAX_BYTES = 768 * 1024;
const JSON_MAX_BYTES = 64 * 1024;

function absoluteHttp(value: string | undefined | null, base: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim(), base);
    u.hash = "";
    return (u.protocol === "https:" || u.protocol === "http:") && u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

/** Title, site name, author, picture and oEmbed address from a page's markup. */
export function parsePageMetadata(html: string, pageUrl: string): Omit<LinkMetadata, "kind"> & { oembedUrl: string | null } {
  let root: XNode;
  try {
    root = parseHtmlTree(html);
  } catch (error) {
    if (error instanceof TooComplexError) return { title: null, siteName: null, author: null, imageUrl: null, oembedUrl: null };
    throw error;
  }
  const meta = new Map<string, string>();
  let title: string | null = null;
  let oembedUrl: string | null = null;
  const stack: XNode[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 100_000) {
    const node = stack.pop()!;
    const name = node.type === "tag" ? (node.name ?? "").toLowerCase() : "";
    if (name === "body") continue; // everything wanted is in the head
    if (name === "meta") {
      const key = (node.attribs?.property ?? node.attribs?.name ?? "").toLowerCase();
      const content = node.attribs?.content;
      if (key && content && !meta.has(key)) meta.set(key, content);
    } else if (name === "title" && title === null) {
      const text = (node.children ?? []).map((c) => (c.type === "text" ? c.data ?? "" : "")).join("");
      title = cleanLine(text, 300);
    } else if (name === "link") {
      const rel = (node.attribs?.rel ?? "").toLowerCase().split(/\s+/);
      const type = (node.attribs?.type ?? "").toLowerCase();
      if (!oembedUrl && rel.includes("alternate") && type === "application/json+oembed") oembedUrl = absoluteHttp(node.attribs?.href, pageUrl);
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  const author = first("author", "article:author", "twitter:creator");
  return {
    title: cleanLine(first("og:title", "twitter:title") ?? null, 300) ?? title,
    siteName: cleanLine(first("og:site_name", "application-name") ?? null, 100),
    // A person's name only: article:author is often a profile address.
    author: author && !/^[a-z]+:\/\//i.test(author.trim()) && !author.startsWith("@") ? cleanLine(author, 120) : null,
    imageUrl: absoluteHttp(first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"), pageUrl),
    oembedUrl,
  };
}

export type MetadataOptions = {
  signal?: AbortSignal;
  /** Replacement fetcher (tests); defaults to safeFetch with the options below. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** TEST ONLY, forwarded to safeFetch. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, forwarded to safeFetch. */
  resolver?: SafeFetchOptions["resolver"];
};

async function get(url: string, opts: MetadataOptions, maxBytes: number, accept: string): Promise<SafeFetchResult> {
  const fetcher = opts.fetch ?? safeFetch;
  return fetcher(url, {
    signal: opts.signal,
    maxBytes,
    allowPartial: true,
    accept,
    timeoutMs: 10_000,
    phaseTimeoutsMs: { firstByteMs: 7000, idleMs: 5000 },
    testAllowAddress: opts.testAllowAddress,
    resolver: opts.resolver,
  });
}

async function oembed(url: string, opts: MetadataOptions): Promise<ReturnType<typeof parseOembed> | null> {
  const res = await get(url, opts, JSON_MAX_BYTES, "application/json");
  if (!res.ok || res.response.status !== 200) return null;
  const data = parseOembed(decodeBody(res.response.body, res.response.contentType));
  return data.title || data.thumbnailUrl ? data : null;
}

/** Titles of the pages bot-protection services show instead of the real page; such a page says nothing about the link. */
const BOT_WALL = /^(?:radware page|just a moment|attention required|access denied|403 forbidden|forbidden|are you a robot|are you human|security check|one moment, please|please wait|ddos-guard|request rejected|captcha)(?:\.{0,3}|…|\?)?(?:\s*[|!:–-].*)?$|^checking your browser\b/i;

export function isBotWall(title: string | null): boolean {
  return title !== null && BOT_WALL.test(title.trim());
}

/**
 * What can be learned about a link, or null when nothing could (the site did not answer, is not a web page,
 * or says nothing about itself). A YouTube video link asks YouTube's oEmbed; any other page is read for
 * Open Graph tags, falling back to the oEmbed address the page advertises.
 */
export async function fetchLinkMetadata(url: string, opts: MetadataOptions = {}): Promise<LinkMetadata | null> {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  if (isYoutubeHost(target.hostname)) {
    const yt = classifyYoutubeUrl(target);
    if (yt.kind !== "video") return null;
    const data = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt.videoId}`)}`, opts);
    return data?.title ? { kind: "video", title: data.title, siteName: "YouTube", author: data.authorName, imageUrl: data.thumbnailUrl } : null;
  }
  const page = await get(url, opts, HTML_MAX_BYTES, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
  if (!page.ok || page.response.status >= 400 || sniffContent(page.response.body, page.response.contentType) !== "html") return null;
  const found = parsePageMetadata(decodeBody(page.response.body, page.response.contentType), page.response.url);
  if (isBotWall(found.title)) return null;
  let { title, siteName, author, imageUrl } = found;
  if ((!title || !imageUrl) && found.oembedUrl) {
    const data = await oembed(found.oembedUrl, opts);
    if (data) {
      title ||= data.title;
      siteName ||= data.providerName;
      author ||= data.authorName;
      imageUrl ||= data.thumbnailUrl;
    }
  }
  if (!title && !imageUrl) return null;
  return { kind: "link", title, siteName, author, imageUrl };
}
