import { cleanLine, parseHtmlTree, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";

/** Feed-related facts found in an HTML page: advertised alternates and visible feed links. */

export type FoundLink = {
  url: string;
  title: string | null;
  /** MIME type declared in <link type=…>, lower-case. */
  type: string | null;
  source: "alternate" | "anchor";
};

export type PageFacts = {
  title: string | null;
  /** The site's own name when the page states it (`og:site_name`, the application name). */
  siteName: string | null;
  baseUrl: string;
  links: FoundLink[];
  canonicalUrl: string | null;
  /** An ActivityPub actor the page says it stands for (a fediverse profile or post). */
  actorUrl: string | null;
};

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json", "application/json", "application/rdf+xml", "application/xml", "text/xml", "application/x-rss+xml"]);
const FEED_PATH = /(?:^|\/)(?:feed|feeds|rss|atom|rss\.xml|atom\.xml|feed\.xml|index\.xml|rss2|rss\.php|feed\.rss|atom\.php)(?:\/|$)|\.(?:rss|atom)(?:$|\?)/i;
const FEED_HOST = /^https?:\/\/feeds?\.[a-z0-9-]+\./i;
const FEED_TEXT = /^\s*(?:rss|atom|feed|rss feed|atom feed|subscribe|subscribe via rss|rss 2\.0|news ?feed|xml)\s*$/i;

function resolve(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function textOf(node: XNode): string {
  const out: string[] = [];
  const stack: XNode[] = [...(node.children ?? [])].reverse();
  while (stack.length && out.join("").length < 300) {
    const n = stack.pop()!;
    if (n.type === "text") out.push(n.data ?? "");
    else for (let i = (n.children?.length ?? 0) - 1; i >= 0; i--) stack.push(n.children![i]!);
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

export function extractPageFacts(html: string, pageUrl: string): PageFacts {
  let root: XNode;
  try {
    root = parseHtmlTree(html);
  } catch (error) {
    if (error instanceof TooComplexError) return { title: null, siteName: null, baseUrl: pageUrl, links: [], canonicalUrl: null, actorUrl: null };
    throw error;
  }
  let base = pageUrl;
  let title: string | null = null;
  let siteName: string | null = null;
  let canonical: string | null = null;
  let actor: string | null = null;
  const alternates: FoundLink[] = [];
  const anchors: FoundLink[] = [];
  const stack: XNode[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 200_000) {
    const node = stack.pop()!;
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const name = (node.name ?? "").toLowerCase();
      const a = node.attribs ?? {};
      if (name === "base" && a.href) {
        const b = resolve(a.href, pageUrl);
        if (b) base = b;
      } else if (name === "title" && title === null) {
        title = cleanLine(textOf(node), 200);
      } else if (name === "meta") {
        const key = (a.property ?? a.name ?? "").toLowerCase();
        if (siteName === null && (key === "og:site_name" || key === "application-name")) siteName = cleanLine(a.content, 100);
      } else if (name === "link") {
        const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
        const type = (a.type ?? "").toLowerCase().split(";")[0]!.trim() || null;
        if (rel.includes("canonical")) canonical ??= resolve(a.href, base);
        if (rel.includes("alternate") && (type === "application/activity+json" || (type === "application/ld+json" && /activitystreams/i.test(a.type ?? "")))) actor ??= resolve(a.href, base);
        if (rel.includes("alternate") && type && FEED_TYPES.has(type)) {
          const url = resolve(a.href, base);
          if (url) alternates.push({ url, title: cleanLine(a.title, 120), type, source: "alternate" });
        } else if (rel.includes("alternate") && !type && a.href && FEED_PATH.test(a.href)) {
          const url = resolve(a.href, base);
          if (url) alternates.push({ url, title: cleanLine(a.title, 120), type: null, source: "alternate" });
        }
      } else if (name === "a" && a.href) {
        const label = textOf(node);
        const url = resolve(a.href, base);
        if (url) {
          let path = "";
          try {
            path = new URL(url).pathname + new URL(url).search;
          } catch {
            path = "";
          }
          const feedishText = FEED_TEXT.test(label) || /\b(?:rss|atom)\b/i.test(a.title ?? "") || /\b(?:rss|atom)\b/i.test(a["aria-label"] ?? "");
          // A link to a feeds.example.org host is a feed whatever its text says (NOS lists them that way).
          if (FEED_PATH.test(path) || FEED_HOST.test(url) || (feedishText && /\.(?:xml|rss|atom|json)(?:$|\?)|\/(?:feed|rss|atom)/i.test(path)) || (feedishText && /\bfeeds?\./i.test(url))) {
            anchors.push({ url, title: label ? cleanLine(label, 120) : cleanLine(a.title, 120), type: null, source: "anchor" });
          }
        }
      }
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  const seen = new Set<string>();
  const links: FoundLink[] = [];
  for (const l of [...alternates, ...anchors]) {
    const key = l.url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }
  return { title, siteName, baseUrl: base, links, canonicalUrl: canonical, actorUrl: actor };
}

/** Where a page's own address ends for a page that lists a site's feeds: `/rss-feeds`, `/feeds`, `/rss`. */
const DIRECTORY_PATH = /(?:^|\/)(?:rss-?feeds?|feeds?|rss|alle-feeds|rss-overzicht|syndication|abonneren|subscribe)\/?$/i;
const DIRECTORY_TEXT = /^\s*(?:rss(?:[ -]feeds?)?|feeds?|alle feeds|subscribe|abonneren)\s*$/i;

/**
 * Links on a page that lead to a page listing the site's feeds (a news site's "RSS feeds" page), same
 * site only, at most three. Those pages are looked at only when nothing else turned up.
 */
export function findDirectoryLinks(html: string, pageUrl: string): string[] {
  let root: XNode;
  try {
    root = parseHtmlTree(html);
  } catch (error) {
    if (error instanceof TooComplexError) return [];
    throw error;
  }
  const site = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  const out: string[] = [];
  const stack: XNode[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 200_000 && out.length < 3) {
    const node = stack.pop()!;
    if (node.type === "tag" && (node.name ?? "").toLowerCase() === "a" && node.attribs?.href) {
      const url = resolve(node.attribs.href, pageUrl);
      if (url) {
        const u = new URL(url);
        if (u.hostname.toLowerCase().replace(/^www\./, "") === site && u.href !== pageUrl && !out.includes(u.href) && (DIRECTORY_PATH.test(u.pathname) || DIRECTORY_TEXT.test(textOf(node)))) out.push(u.href);
      }
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}
