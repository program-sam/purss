import { escapeXml } from "@purss/connectors";
import type { GatewayLimits, StagedEntry } from "./types.ts";

/** RSS 2.0 serialisation of staged entries with stable GUIDs and bounded size. */

export type FeedMeta = { title: string; siteUrl: string | null; description: string | null };

const MAX_TITLE = 500;
const MAX_SUMMARY = 20_000;

function clipText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
}

function rfc822(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toUTCString();
}

/**
 * Bound one entry to the per-entry limit. Oversized content is dropped as a whole
 * rather than cut mid-markup, and the entry says so with a category.
 */
export function boundEntry(entry: StagedEntry, limits: Pick<GatewayLimits, "maxEntryBytes">): { entry: StagedEntry; limited: boolean } {
  const bounded: StagedEntry = {
    guid: clipText(entry.guid, 500),
    title: clipText(entry.title, MAX_TITLE),
    url: entry.url ? clipText(entry.url, 4000) : null,
    author: entry.author ? clipText(entry.author, 300) : null,
    publishedAt: entry.publishedAt,
    summaryHtml: entry.summaryHtml ? clipText(entry.summaryHtml, MAX_SUMMARY) : null,
    contentHtml: entry.contentHtml ?? null,
    imageUrl: entry.imageUrl ? clipText(entry.imageUrl, 4000) : null,
    enclosures: (entry.enclosures ?? []).slice(0, 10).map((e) => ({ url: clipText(e.url, 4000), type: e.type ? clipText(e.type, 200) : null, length: e.length })),
    categories: (entry.categories ?? []).slice(0, 10).map((c) => clipText(c, 100)),
  };
  let limited = false;
  const size = () => Buffer.byteLength(JSON.stringify(bounded));
  if (size() > limits.maxEntryBytes && bounded.contentHtml) {
    bounded.contentHtml = null;
    limited = true;
  }
  if (size() > limits.maxEntryBytes && bounded.summaryHtml) {
    bounded.summaryHtml = clipText(bounded.summaryHtml, 4000);
    limited = true;
  }
  if (size() > limits.maxEntryBytes) {
    bounded.summaryHtml = null;
    bounded.enclosures = [];
    limited = true;
  }
  return { entry: bounded, limited };
}

export function serializeItem(entry: StagedEntry, limited = false): string {
  const parts: string[] = ["<item>"];
  parts.push(`<title>${escapeXml(entry.title || "Untitled")}</title>`);
  if (entry.url) parts.push(`<link>${escapeXml(entry.url)}</link>`);
  parts.push(`<guid isPermaLink="false">${escapeXml(entry.guid)}</guid>`);
  const date = rfc822(entry.publishedAt);
  if (date) parts.push(`<pubDate>${date}</pubDate>`);
  if (entry.author) parts.push(`<dc:creator>${escapeXml(entry.author)}</dc:creator>`);
  if (entry.summaryHtml) parts.push(`<description>${escapeXml(entry.summaryHtml)}</description>`);
  if (entry.contentHtml) parts.push(`<content:encoded>${escapeXml(entry.contentHtml)}</content:encoded>`);
  for (const e of entry.enclosures ?? []) {
    if (e.url) parts.push(`<enclosure url="${escapeXml(e.url)}" length="${e.length ?? 0}" type="${escapeXml(e.type ?? "application/octet-stream")}"/>`);
  }
  if (entry.imageUrl) parts.push(`<media:thumbnail url="${escapeXml(entry.imageUrl)}"/>`);
  for (const c of entry.categories ?? []) parts.push(`<category>${escapeXml(c)}</category>`);
  if (limited) parts.push("<category>content-limited</category>");
  parts.push("</item>");
  return parts.join("");
}

export function serializeFeed(meta: FeedMeta, items: string[], now: Date): string {
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
    "<channel>",
    `<title>${escapeXml(clipText(meta.title, MAX_TITLE) || "Private source")}</title>`,
    meta.siteUrl ? `<link>${escapeXml(meta.siteUrl)}</link>` : "",
    `<description>${escapeXml(clipText(meta.description, 1000) || "Private feed")}</description>`,
    `<lastBuildDate>${now.toUTCString()}</lastBuildDate>`,
  ];
  return `${head.filter(Boolean).join("\n")}\n${items.join("\n")}\n</channel>\n</rss>\n`;
}
