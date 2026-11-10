/** Content-type parsing, decoding and sniffing helpers shared by fetching and parsing. */

export type ParsedContentType = { mediaType: string; charset: string | null };

export function parseContentType(header: string | null | undefined): ParsedContentType {
  if (!header) return { mediaType: "", charset: null };
  const [type = "", ...params] = header.split(";");
  let charset: string | null = null;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(p);
    if (m) charset = m[1]!.toLowerCase();
  }
  return { mediaType: type.trim().toLowerCase(), charset };
}

function bomCharset(body: Uint8Array): string | null {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  return null;
}

function declaredCharset(body: Uint8Array): string | null {
  const head = Buffer.from(body.subarray(0, 2048)).toString("latin1");
  const xml = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml) return xml[1]!.toLowerCase();
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (meta) return meta[1]!.toLowerCase();
  return null;
}

/** Decode a response body to text using BOM, header, XML declaration or meta charset. */
export function decodeBody(body: Uint8Array, contentType?: string | null): string {
  const candidates = [bomCharset(body), parseContentType(contentType).charset, declaredCharset(body), "utf-8"];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      continue;
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

export type SniffedKind = "rss" | "atom" | "rdf" | "jsonfeed" | "html" | "xml" | "json" | "text" | "binary";

const HTML_FIRST = new Set(["title", "meta", "link", "script", "style", "div", "p", "a", "span", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "nav", "header", "main", "section", "article", "form", "img", "iframe", "center", "font", "b", "i", "noscript", "base", "!doctype"]);
const FEED_JSON = /"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\/\d/;

/**
 * Decide what a response body really is. Servers mislabel feeds as text/html and
 * pages as application/xml, so the body wins over the header.
 */
export function sniffContent(body: Uint8Array, contentType?: string | null): SniffedKind {
  const sample = Buffer.from(body.subarray(0, 4096));
  if (sample.length === 0) return "text";
  let nul = 0;
  for (let i = 0; i < Math.min(sample.length, 512); i++) if (sample[i] === 0) nul++;
  const utf16 = bomCharset(sample)?.startsWith("utf-16") ?? false;
  if (nul > 0 && !utf16) return "binary";
  const text = (utf16 ? new TextDecoder(bomCharset(sample)!).decode(sample) : sample.toString("utf8")).replace(/^﻿/, "");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return FEED_JSON.test(text) ? "jsonfeed" : "json";
  if (trimmed.startsWith("%PDF") || trimmed.startsWith("GIF8")) return "binary";
  if (trimmed.startsWith("<")) {
    // first real element, skipping comments, doctype, processing instructions
    const cleaned = trimmed.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi, "");
    const m = /<\s*([a-zA-Z][\w:.-]*)/.exec(cleaned);
    const name = m?.[1]?.toLowerCase() ?? "";
    if (name === "rss") return "rss";
    if (name === "feed" || name.endsWith(":feed")) return "atom";
    if (name === "rdf:rdf" || name === "rdf") return "rdf";
    if (name === "html" || name === "head" || name === "body" || name === "!doctype") return "html";
    const media = parseContentType(contentType).mediaType;
    if (media === "text/html" || media === "application/xhtml+xml") return "html";
    if (HTML_FIRST.has(name) && !/^\s*<\?xml/i.test(trimmed)) return "html";
    return "xml";
  }
  if (/<\s*(?:html|head|body)\b/i.test(text)) return "html";
  return "text";
}

export function isFeedKind(kind: SniffedKind): boolean {
  return kind === "rss" || kind === "atom" || kind === "rdf" || kind === "jsonfeed";
}
