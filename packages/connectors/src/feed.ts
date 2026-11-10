import { decodeBody } from "./content-type.ts";
import { clip, cleanLine, escapeHtml, htmlToText, parseXml, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";

/*
 * Feed parsing for RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed into one normalised
 * shape. The parser is forgiving about malformed markup, never executes anything,
 * keeps all field sizes and the item count bounded, and walks the tree without
 * recursion over untrusted depth.
 */

export type FeedEnclosure = { url: string; type: string | null; length: number | null };

export type FeedItem = {
  guid: string | null;
  url: string | null;
  title: string | null;
  author: string | null;
  /** ISO 8601 (UTC) or null when the feed gives no usable date. */
  publishedAt: string | null;
  summaryHtml: string | null;
  contentHtml: string | null;
  imageUrl: string | null;
  enclosures: FeedEnclosure[];
  durationSeconds: number | null;
  /** YouTube video id when the entry carries one. */
  videoId: string | null;
};

export type FeedFormat = "rss" | "rdf" | "atom" | "jsonfeed";

export type ParsedFeed = {
  format: FeedFormat;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  language: string | null;
  imageUrl: string | null;
  /** The software that wrote the feed, as it names itself (e.g. "Mastodon v4.5.0"). */
  generator: string | null;
  items: FeedItem[];
  /** True when the feed had more items than `maxItems`. */
  truncated: boolean;
  /** Audio/podcast feed: iTunes tags or mostly audio enclosures. */
  isPodcast: boolean;
  /** YouTube official feed identity, when the feed carries it. */
  youtube: { channelId: string | null; playlistId: string | null } | null;
  /** The feed provides only short excerpts, so reading the full text needs the original page. */
  summariesOnly: boolean;
  warnings: string[];
};

export class FeedParseError extends Error {
  code: "empty" | "notfeed" | "toolarge";
  constructor(code: "empty" | "notfeed" | "toolarge", message: string) {
    super(message);
    this.code = code;
  }
}

export type ParseFeedOptions = {
  /** Used to absolutise relative links when the feed itself gives no xml:base. */
  baseUrl?: string;
  maxItems?: number;
};

export const DEFAULT_MAX_ITEMS = 200;
const HARD_MAX_ITEMS = 1000;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_SUMMARY = 200_000;
const MAX_CONTENT = 2_000_000;
const MAX_ENCLOSURES = 10;

// ---------- small helpers ----------

function lower(node: XNode): string {
  return (node.name ?? "").toLowerCase();
}

function kids(node: XNode | undefined): XNode[] {
  return node?.children ?? [];
}

function elements(node: XNode | undefined, ...names: string[]): XNode[] {
  const want = names.map((n) => n.toLowerCase());
  return kids(node).filter((c) => (c.type === "tag" || c.type === "script" || c.type === "style") && want.includes(lower(c)));
}

function firstEl(node: XNode | undefined, ...names: string[]): XNode | undefined {
  return elements(node, ...names)[0];
}

/** Text content (text + CDATA) without recursion. */
function textOf(node: XNode | undefined): string {
  if (!node) return "";
  const out: string[] = [];
  const stack: XNode[] = [...kids(node)].reverse();
  let size = 0;
  while (stack.length && size < 4_000_000) {
    const n = stack.pop()!;
    if (n.type === "text") {
      out.push(n.data ?? "");
      size += n.data?.length ?? 0;
    } else if (n.type === "cdata" || n.type === "tag") {
      for (let i = kids(n).length - 1; i >= 0; i--) stack.push(kids(n)[i]!);
    }
  }
  return out.join("");
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

/** Serialise the child markup of an XHTML element, bounded in depth and size. */
function innerMarkup(node: XNode | undefined): string {
  if (!node) return "";
  const out: string[] = [];
  let size = 0;
  type Step = { node: XNode } | { close: string };
  const stack: Step[] = [];
  const push = (list: XNode[]) => {
    for (let i = list.length - 1; i >= 0; i--) stack.push({ node: list[i]! });
  };
  push(kids(node));
  let depth = 0;
  while (stack.length && size < MAX_CONTENT) {
    const step = stack.pop()!;
    if ("close" in step) {
      out.push(step.close);
      depth--;
      continue;
    }
    const n = step.node;
    if (n.type === "text") {
      const t = escapeHtml(n.data ?? "");
      out.push(t);
      size += t.length;
    } else if (n.type === "cdata") {
      push(kids(n));
    } else if (n.type === "tag" && n.name) {
      const name = n.name.toLowerCase();
      if (!/^[a-z][a-z0-9:-]*$/.test(name)) continue;
      const attrs = Object.entries(n.attribs ?? {})
        .filter(([k]) => /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(k))
        .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
        .join("");
      if (VOID.has(name)) {
        out.push(`<${name}${attrs}>`);
      } else if (depth < 64) {
        out.push(`<${name}${attrs}>`);
        depth++;
        stack.push({ close: `</${name}>` });
        push(kids(n));
      } else {
        push(kids(n)); // too deep to keep as markup: keep the text, drop the wrapper
      }
    }
  }
  return out.join("");
}

function absUrl(value: string | null | undefined, base: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v || v.length > 4000) return null;
  try {
    const url = new URL(v, base || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Parse the many date spellings feeds use; null when unusable. */
export function parseFeedDate(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  let t = Date.parse(v);
  if (Number.isNaN(t)) {
    // "2026-11-03 10:00:00 +0100", "Mon, 3 Nov 2026 10:00 CET", "2026-11-03T10:00:00.000+0100"
    const fixed = v.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/, "$1T$2").replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/\s+(?=[+-]\d{2}:?\d{2}$)/, "");
    t = Date.parse(fixed);
  }
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const year = d.getUTCFullYear();
  if (year < 1980 || year > 2200) return null;
  return d.toISOString();
}

/** iTunes / media durations: seconds, MM:SS, HH:MM:SS or ISO 8601 (PT1H2M3S). */
export function parseDuration(value: string | null | undefined): number | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v));
  const iso = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(v);
  if (iso && (iso[1] || iso[2] || iso[3])) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Math.round(Number(iso[3] ?? 0));
  const parts = v.split(":");
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0) | 0;
  }
  return null;
}

function isAudioUrl(url: string): boolean {
  return /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i.test(url);
}

function enclosureKind(e: FeedEnclosure): "audio" | "video" | "image" | "other" {
  const t = (e.type ?? "").toLowerCase();
  if (t.startsWith("audio/") || (!t && isAudioUrl(e.url))) return "audio";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("image/")) return "image";
  return "other";
}

function firstImgSrc(html: string | null, base: string | null): string | null {
  if (!html) return null;
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 20) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || src.startsWith("data:")) continue;
    const w = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    const h = /\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    if ((w && Number(w) <= 2) || (h && Number(h) <= 2)) continue; // tracking pixel
    const abs = absUrl(src.replace(/&amp;/g, "&"), base);
    if (abs) return abs;
  }
  return null;
}

function authorName(raw: string | null | undefined): string | null {
  const v = cleanLine(raw, 200);
  if (!v) return null;
  // RSS <author>: "me@example.com (Real Name)" or just an email address.
  const named = /\(([^)]+)\)\s*$/.exec(v);
  if (named && /@/.test(v)) return named[1]!.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(v)) return null; // bare email address: no display name
  return v;
}

function dedupeEnclosures(list: FeedEnclosure[]): FeedEnclosure[] {
  const seen = new Set<string>();
  const out: FeedEnclosure[] = [];
  for (const e of list) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
    if (out.length >= MAX_ENCLOSURES) break;
  }
  return out;
}

function sizeAttr(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Namespace prefixes are conventional; normalise the common alternative forms. */
function prefixToStrip(root: XNode): string | null {
  const name = root.name ?? "";
  const i = name.indexOf(":");
  if (i === -1) return null;
  const local = name.slice(i + 1).toLowerCase();
  if (local === "feed" || local === "rss" || local === "channel") return name.slice(0, i).toLowerCase();
  return null;
}

function normalizeNames(root: XNode): void {
  const prefix = prefixToStrip(root);
  const stack: XNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "tag") {
      if (prefix && n.name && n.name.toLowerCase().startsWith(`${prefix}:`)) n.name = n.name.slice(prefix.length + 1);
      if (n.attribs) {
        const fixed: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.attribs)) fixed[k.toLowerCase()] = v;
        n.attribs = fixed;
      }
    }
    for (const c of kids(n)) if (c.type === "tag" || c.type === "cdata") stack.push(c);
  }
}

// ---------- shared item finishing ----------

type RawItem = Partial<FeedItem> & { enclosures: FeedEnclosure[]; images: string[] };

function finishItem(raw: RawItem, base: string | null): FeedItem {
  const url = raw.url ? absUrl(raw.url, base) : null;
  const itemBase = url ?? base;
  const summaryHtml = clip(raw.summaryHtml, MAX_SUMMARY);
  const contentHtml = clip(raw.contentHtml, MAX_CONTENT);
  const enclosures = dedupeEnclosures(raw.enclosures.map((e) => ({ ...e, url: absUrl(e.url, base) ?? "" })).filter((e) => e.url));
  let imageUrl: string | null = null;
  for (const candidate of raw.images) {
    imageUrl = absUrl(candidate, base);
    if (imageUrl) break;
  }
  if (!imageUrl) {
    const img = enclosures.find((e) => enclosureKind(e) === "image");
    imageUrl = img?.url ?? firstImgSrc(contentHtml, itemBase) ?? firstImgSrc(summaryHtml, itemBase);
  }
  const mediaEnclosures = enclosures.filter((e) => enclosureKind(e) !== "image");
  let guid = clip(raw.guid, 1000);
  if (!guid) guid = null;
  return {
    guid,
    url,
    title: cleanLine(raw.title, 500),
    author: authorName(raw.author),
    publishedAt: raw.publishedAt ?? null,
    summaryHtml,
    contentHtml,
    imageUrl,
    enclosures: mediaEnclosures,
    durationSeconds: raw.durationSeconds ?? null,
    videoId: raw.videoId ?? null,
  };
}

// ---------- RSS 2.0 / RSS 1.0 (RDF) ----------

function mediaFromElements(node: XNode, enclosures: FeedEnclosure[], images: string[]): number | null {
  let duration: number | null = null;
  const scopes: XNode[] = [node, ...elements(node, "media:group")];
  for (const scope of scopes) {
    for (const t of elements(scope, "media:thumbnail")) if (t.attribs?.url) images.push(t.attribs.url);
    for (const c of elements(scope, "media:content")) {
      const url = c.attribs?.url;
      if (!url) continue;
      const type = c.attribs?.type?.toLowerCase() ?? null;
      const medium = c.attribs?.medium?.toLowerCase();
      if (type === "application/x-shockwave-flash" || /\/v\/|\/embed\//.test(url) || type === "text/html") continue; // embedded players, not files
      if (medium === "image" || type?.startsWith("image/")) images.push(url);
      else enclosures.push({ url, type: type ?? (medium === "audio" ? "audio/mpeg" : medium === "video" ? "video/mp4" : null), length: sizeAttr(c.attribs?.filesize) });
      duration ??= parseDuration(c.attribs?.duration);
    }
  }
  return duration;
}

function rssItem(node: XNode, base: string | null, isRdf: boolean): FeedItem {
  const raw: RawItem = { enclosures: [], images: [] };
  const guidEl = firstEl(node, "guid");
  const linkEl = elements(node, "link").find((l) => textOf(l).trim());
  const link = linkEl ? textOf(linkEl).trim() : null;
  const permalinkGuid = guidEl && guidEl.attribs?.ispermalink?.toLowerCase() !== "false" ? textOf(guidEl).trim() : "";
  raw.guid = textOf(guidEl).trim() || (isRdf ? node.attribs?.["rdf:about"] : null) || null;
  raw.url = link || (isRdf ? node.attribs?.["rdf:about"] : null) || (/^https?:\/\//i.test(permalinkGuid) ? permalinkGuid : null);
  raw.title = textOf(firstEl(node, "title"));
  raw.author = textOf(firstEl(node, "dc:creator")) || textOf(firstEl(node, "itunes:author")) || textOf(firstEl(node, "author")) || null;
  raw.publishedAt = parseFeedDate(textOf(firstEl(node, "pubdate")) || textOf(firstEl(node, "dc:date")) || textOf(firstEl(node, "published")) || textOf(firstEl(node, "date")));
  const description = textOf(firstEl(node, "description"));
  const encoded = textOf(firstEl(node, "content:encoded"));
  raw.summaryHtml = description || null;
  raw.contentHtml = encoded || null;
  for (const e of elements(node, "enclosure")) {
    if (e.attribs?.url) raw.enclosures.push({ url: e.attribs.url, type: e.attribs.type?.toLowerCase() ?? null, length: sizeAttr(e.attribs.length) });
  }
  let duration = parseDuration(textOf(firstEl(node, "itunes:duration")));
  const mediaDuration = mediaFromElements(node, raw.enclosures, raw.images);
  duration ??= mediaDuration;
  raw.durationSeconds = duration;
  const itunesImage = firstEl(node, "itunes:image")?.attribs?.href;
  if (itunesImage) raw.images.push(itunesImage);
  return finishItem(raw, base);
}

function rssFeedMeta(channel: XNode, base: string | null) {
  const link = elements(channel, "link").find((l) => textOf(l).trim());
  const siteUrl = absUrl(link ? textOf(link) : null, base);
  const imageNode = firstEl(channel, "image");
  const image = absUrl(textOf(firstEl(imageNode, "url")) || firstEl(channel, "itunes:image")?.attribs?.href || null, siteUrl ?? base);
  const itunesTags = kids(channel).filter((c) => c.type === "tag" && /^(itunes:(author|owner|category|explicit|type|summary|subtitle|new-feed-url)|podcast:)/i.test(c.name ?? ""));
  return {
    title: cleanLine(textOf(firstEl(channel, "title")), 300),
    siteUrl,
    description: cleanLine(textOf(firstEl(channel, "description")) || textOf(firstEl(channel, "itunes:summary")) || textOf(firstEl(channel, "subtitle")), 1000),
    language: clip(textOf(firstEl(channel, "language")) || textOf(firstEl(channel, "dc:language")), 20),
    imageUrl: image,
    hasItunes: itunesTags.length > 0,
    generator: cleanLine(textOf(firstEl(channel, "generator")), 200),
  };
}

// ---------- Atom ----------

function atomText(node: XNode | undefined, plainOk = false): string | null {
  if (!node) return null;
  const type = (node.attribs?.type ?? "text").toLowerCase();
  if (type === "xhtml") {
    const div = firstEl(node, "div");
    return innerMarkup(div ?? node) || null;
  }
  const raw = textOf(node);
  if (!raw.trim()) return null;
  if (type === "html" || type === "text/html") return raw;
  if (type === "text" || type === "" || type === "plain") return plainOk ? raw : escapeHtml(raw);
  return null; // non-text media (e.g. application/*) is not displayable content
}

function atomLinks(node: XNode, base: string | null) {
  let alternate: string | null = null;
  let selfOrOther: string | null = null;
  const enclosures: FeedEnclosure[] = [];
  for (const l of elements(node, "link")) {
    const href = l.attribs?.href;
    if (!href) continue;
    const rel = (l.attribs?.rel ?? "alternate").toLowerCase();
    if (rel === "alternate") {
      const type = (l.attribs?.type ?? "").toLowerCase();
      if (!alternate && (!type || /html|xml/.test(type))) alternate = href;
      else if (!selfOrOther) selfOrOther = href;
    } else if (rel === "enclosure") {
      enclosures.push({ url: href, type: l.attribs?.type?.toLowerCase() ?? null, length: sizeAttr(l.attribs?.length) });
    }
  }
  return { alternate: absUrl(alternate ?? selfOrOther, base), enclosures };
}

function atomEntry(node: XNode, base: string | null): FeedItem {
  const entryBase = absUrl(node.attribs?.["xml:base"], base) ?? base;
  const raw: RawItem = { enclosures: [], images: [] };
  const links = atomLinks(node, entryBase);
  raw.guid = textOf(firstEl(node, "id")).trim() || null;
  raw.url = links.alternate;
  raw.title = atomText(firstEl(node, "title"), true);
  const author = firstEl(node, "author");
  raw.author = textOf(firstEl(author, "name")) || textOf(firstEl(node, "dc:creator")) || null;
  raw.publishedAt = parseFeedDate(textOf(firstEl(node, "published")) || textOf(firstEl(node, "updated")) || textOf(firstEl(node, "dc:date")));
  const content = firstEl(node, "content");
  raw.contentHtml = content && !content.attribs?.src ? atomText(content) : null;
  const mediaDescription = textOf(firstEl(firstEl(node, "media:group"), "media:description") ?? firstEl(node, "media:description")).trim();
  raw.summaryHtml = atomText(firstEl(node, "summary")) ?? (mediaDescription ? escapeHtml(mediaDescription).replace(/\n/g, "<br>") : null);
  raw.enclosures.push(...links.enclosures);
  const mediaDuration = mediaFromElements(node, raw.enclosures, raw.images);
  raw.durationSeconds = mediaDuration;
  raw.videoId = textOf(firstEl(node, "yt:videoid")).trim() || null;
  return finishItem(raw, entryBase);
}

// ---------- JSON Feed ----------

function str(value: unknown, max = 100_000): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : null;
}

function jsonItem(value: unknown, base: string | null): FeedItem | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const raw: RawItem = { enclosures: [], images: [] };
  raw.guid = typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : null;
  raw.url = str(o.url, 4000) ?? str(o.external_url, 4000);
  raw.title = str(o.title, 2000);
  const authors = Array.isArray(o.authors) ? o.authors : o.author ? [o.author] : [];
  const first = authors.find((a) => a && typeof a === "object") as Record<string, unknown> | undefined;
  raw.author = str(first?.name, 300);
  raw.publishedAt = parseFeedDate(str(o.date_published, 100) ?? str(o.date_modified, 100));
  const html = str(o.content_html, MAX_CONTENT);
  const text = str(o.content_text, MAX_CONTENT);
  raw.contentHtml = html ?? (text ? `<p>${escapeHtml(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>` : null);
  const summary = str(o.summary, MAX_SUMMARY);
  raw.summaryHtml = summary ? escapeHtml(summary) : null;
  for (const key of ["image", "banner_image"]) {
    const v = str(o[key], 4000);
    if (v) raw.images.push(v);
  }
  let duration: number | null = null;
  if (Array.isArray(o.attachments)) {
    for (const a of o.attachments.slice(0, 20)) {
      if (!a || typeof a !== "object") continue;
      const att = a as Record<string, unknown>;
      const url = str(att.url, 4000);
      if (!url) continue;
      raw.enclosures.push({ url, type: str(att.mime_type, 200)?.toLowerCase() ?? null, length: typeof att.size_in_bytes === "number" ? att.size_in_bytes : null });
      if (typeof att.duration_in_seconds === "number" && duration === null) duration = Math.round(att.duration_in_seconds);
    }
  }
  raw.durationSeconds = duration;
  return finishItem(raw, base);
}

// ---------- coverage ----------

const EXCERPT_END = /(?:…|\[\s*…\s*\]|\[\s*\.{3}\s*\]|\.{3}|&hellip;|read more\.?|continue reading\.?|read the rest\.?|\(more…\)|the post .+ appeared first on .+)\s*$/i;

/** True when most items offer only an excerpt rather than the article body. */
export function detectSummariesOnly(items: FeedItem[], isMedia: boolean): boolean {
  if (isMedia) return false;
  const sample = items.slice(0, 10).filter((i) => i.summaryHtml || i.contentHtml);
  if (sample.length === 0) return false;
  let summaryOnly = 0;
  for (const item of sample) {
    const body = item.contentHtml ? htmlToText(item.contentHtml, 20_000) : "";
    const summary = item.summaryHtml ? htmlToText(item.summaryHtml, 20_000) : "";
    const best = Math.max(body.length, summary.length);
    const looksCut = EXCERPT_END.test(summary) || EXCERPT_END.test(body);
    if (item.contentHtml && body.length >= Math.min(1500, summary.length * 1.3 + 300) && !looksCut) continue;
    if (best < 800 || looksCut) summaryOnly++;
  }
  return summaryOnly / sample.length >= 0.7;
}

// ---------- entry point ----------

function assemble(format: FeedFormat, meta: { title: string | null; siteUrl: string | null; description: string | null; language: string | null; imageUrl: string | null; hasItunes?: boolean; generator?: string | null }, items: FeedItem[], truncated: boolean, youtube: ParsedFeed["youtube"], warnings: string[]): ParsedFeed {
  const audio = items.filter((i) => i.enclosures.some((e) => enclosureKind(e) === "audio")).length;
  const video = items.filter((i) => i.enclosures.some((e) => enclosureKind(e) === "video")).length;
  const isPodcast = Boolean(meta.hasItunes && (audio > 0 || video > 0 || items.length === 0)) || (audio > 0 && audio * 2 >= items.length);
  const isMedia = isPodcast || youtube !== null || video * 2 >= Math.max(items.length, 1);
  return {
    format,
    title: meta.title,
    siteUrl: meta.siteUrl,
    description: meta.description,
    language: meta.language,
    imageUrl: meta.imageUrl,
    generator: meta.generator ?? null,
    items,
    truncated,
    isPodcast,
    youtube,
    summariesOnly: detectSummariesOnly(items, isMedia),
    warnings,
  };
}

function parseJsonFeed(text: string, opts: ParseFeedOptions): ParsedFeed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FeedParseError("notfeed", "That isn't a readable feed.");
  }
  if (!data || typeof data !== "object") throw new FeedParseError("notfeed", "That isn't a readable feed.");
  const o = data as Record<string, unknown>;
  if (typeof o.version !== "string" || !o.version.includes("jsonfeed.org") || !Array.isArray(o.items)) throw new FeedParseError("notfeed", "That JSON isn't a feed.");
  const base = absUrl(str(o.home_page_url, 4000), opts.baseUrl ?? null) ?? opts.baseUrl ?? null;
  const max = Math.min(opts.maxItems ?? DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  const items: FeedItem[] = [];
  for (const v of o.items.slice(0, max)) {
    const item = jsonItem(v, base);
    if (item) items.push(item);
  }
  return assemble(
    "jsonfeed",
    {
      title: cleanLine(str(o.title, 1000), 300),
      siteUrl: absUrl(str(o.home_page_url, 4000), opts.baseUrl ?? null),
      description: cleanLine(str(o.description, 5000), 1000),
      language: clip(str(o.language, 40), 20),
      imageUrl: absUrl(str(o.icon, 4000) ?? str(o.favicon, 4000), base),
    },
    items,
    o.items.length > max,
    null,
    [],
  );
}

/**
 * Parse a feed body. Accepts text or raw bytes (decoded using BOM, header and XML
 * declaration). Throws FeedParseError when the content is not a feed.
 */
export function parseFeed(body: string | Uint8Array, contentType?: string | null, opts: ParseFeedOptions = {}): ParsedFeed {
  if (typeof body !== "string" && body.length > MAX_INPUT_BYTES) throw new FeedParseError("toolarge", "That feed is too large to read.");
  const text = typeof body === "string" ? body : decodeBody(body, contentType);
  if (text.length > MAX_INPUT_BYTES) throw new FeedParseError("toolarge", "That feed is too large to read.");
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (!trimmed) throw new FeedParseError("empty", "That address returned nothing.");
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, opts);

  let doc: XNode;
  try {
    doc = parseXml(trimmed);
  } catch (error) {
    if (error instanceof TooComplexError) throw new FeedParseError("notfeed", "That feed is too tangled to read safely.");
    throw error;
  }
  const roots = kids(doc).filter((n) => n.type === "tag");
  // Prefer a real feed root anywhere among top-level elements (HTML wrappers excluded).
  const root = roots.find((r) => /^(?:[\w-]+:)?(?:rss|feed|rdf)$/i.test(r.name ?? "") || /^rdf:rdf$/i.test(r.name ?? ""));
  if (!root) throw new FeedParseError("notfeed", "That page isn't a feed.");
  normalizeNames(root);
  const name = lower(root);
  const max = Math.min(opts.maxItems ?? DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  const warnings: string[] = [];
  const baseHint = opts.baseUrl ?? null;

  if (name === "feed") {
    const base = absUrl(root.attribs?.["xml:base"], baseHint) ?? baseHint;
    const links = atomLinks(root, base);
    const entries = elements(root, "entry");
    const items = entries.slice(0, max).map((e) => atomEntry(e, base));
    const channelId = textOf(firstEl(root, "yt:channelid")).trim() || null;
    const playlistId = textOf(firstEl(root, "yt:playlistid")).trim() || null;
    const youtube = channelId || playlistId ? { channelId, playlistId } : null;
    const siteLink = links.alternate;
    if (entries.length === 0) warnings.push("The feed has no entries right now.");
    return assemble(
      "atom",
      {
        title: cleanLine(atomText(firstEl(root, "title"), true), 300),
        siteUrl: siteLink,
        description: cleanLine(atomText(firstEl(root, "subtitle"), true), 1000),
        language: clip(root.attribs?.["xml:lang"], 20),
        imageUrl: absUrl(textOf(firstEl(root, "logo")) || textOf(firstEl(root, "icon")), siteLink ?? base),
        hasItunes: kids(root).some((c) => c.type === "tag" && /^itunes:/i.test(c.name ?? "")),
        generator: cleanLine(textOf(firstEl(root, "generator")), 200),
      },
      items,
      entries.length > max,
      youtube,
      warnings,
    );
  }

  if (name === "rss") {
    const channel = firstEl(root, "channel");
    if (!channel) throw new FeedParseError("notfeed", "That feed has no channel.");
    const meta = rssFeedMeta(channel, baseHint);
    const base = meta.siteUrl ?? baseHint;
    const entries = elements(channel, "item");
    const items = entries.slice(0, max).map((e) => rssItem(e, base, false));
    if (entries.length === 0) warnings.push("The feed has no entries right now.");
    return assemble("rss", meta, items, entries.length > max, null, warnings);
  }

  if (name === "rdf" || name === "rdf:rdf") {
    const channel = firstEl(root, "channel");
    const meta = channel ? rssFeedMeta(channel, baseHint) : { title: null, siteUrl: null, description: null, language: null, imageUrl: null, hasItunes: false };
    const base = meta.siteUrl ?? baseHint;
    const entries = elements(root, "item");
    const items = entries.slice(0, max).map((e) => rssItem(e, base, true));
    if (entries.length === 0) warnings.push("The feed has no entries right now.");
    return assemble("rdf", meta, items, entries.length > max, null, warnings);
  }

  throw new FeedParseError("notfeed", "That page isn't a feed.");
}

/** Is this item an audio/video media item? Used by callers that map items to kinds. */
export function itemMediaKind(item: FeedItem): "audio" | "video" | null {
  for (const e of item.enclosures) {
    const kind = enclosureKind(e);
    if (kind === "audio" || kind === "video") return kind;
  }
  return null;
}
