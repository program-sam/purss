import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { assertShallowMarkup, escapeHtml, looksLikeCss, markupParagraphs, TooComplexError } from "@purss/connectors";
import type { ItemKind } from "@purss/domain";

/**
 * Bounds on the markup handed to sanitize-html, whose work grows with nesting depth (quadratically)
 * and with the number of tags, attributes and pieces of text. Real pages stay far inside them: the
 * largest seen, a 3 MB encyclopedia page, nests 34 deep and yields about 123,000 of those events.
 */
const SANITIZE_LIMITS = { depth: 256, events: 250_000 };

function withinLimits(html: string): boolean {
  try {
    assertShallowMarkup(html, "html", SANITIZE_LIMITS);
    return true;
  } catch (err) {
    if (err instanceof TooComplexError) return false;
    throw err;
  }
}

/** Elements whose content is dropped: sanitize-html's defaults plus iframe, whose fallback markup it would otherwise parse again as a page, outside SANITIZE_LIMITS. */
const NON_TEXT_TAGS = ["script", "style", "textarea", "option", "xmp", "iframe"];

/**
 * Some feeds wrap their markup in CDATA twice, so the summary arrives as the text `<![CDATA[<p>…</p>]]>`
 * (sometimes escaped, sometimes with the inner closing marker missing) and would be shown as raw code.
 * Remove the wrappers, and decode the markup when the wrapper itself arrived escaped.
 */
export function unwrapCdata(html: string): string {
  if (!/!\[CDATA\[/i.test(html)) return html;
  const escaped = /&lt;!\[CDATA\[/i.test(html);
  const out = html.replace(/(?:<|&lt;)!\[CDATA\[/gi, "").replace(/\]\](?:>|&gt;)/g, "");
  if (!escaped || !/&lt;\/?[a-z][^&]{0,200}&gt;/i.test(out)) return out;
  return out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Elements whose text is shown as the code it is. */
const CODE_TAGS = new Set(["pre", "code", "kbd", "samp"]);

/**
 * Strict allowlist for rendering feed/captured HTML. No scripts, handlers, embeds or forms.
 * Markup beyond SANITIZE_LIMITS keeps only its text, as escaped paragraphs.
 */
export function sanitize(html: string | null | undefined): string | null {
  if (!html) return null;
  if (!withinLimits(html)) return markupParagraphs(html).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  return sanitizeHtml(unwrapCdata(html), {
    nonTextTags: NON_TEXT_TAGS,
    allowedTags: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s",
      "sub", "sup", "small", "mark", "ul", "ol", "li", "dl", "dt", "dd", "a", "img", "figure", "figcaption", "table",
      "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "abbr", "cite", "q", "time", "span", "div",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      time: ["datetime"],
      abbr: ["title"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https", "http"] },
    allowProtocolRelative: false,
    // Style rules that ended up as text (a page's inline <style>, escaped) are not content.
    textFilter: (text, tagName) => (CODE_TAGS.has(tagName) || !looksLikeCss(text) ? text : ""),
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" } }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy", referrerpolicy: "no-referrer" } }),
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

/** Block boundaries become spaces before tags are stripped, so "<p>a</p><p>b</p>" reads "a b", not "ab". */
const BLOCK_TAG = /<\/?(?:p|br|hr|div|li|ul|ol|dl|dt|dd|h[1-6]|blockquote|pre|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|section|article|header|footer|aside)\b[^>]*>/gi;

export function toText(html: string | null | undefined): string {
  if (!html) return "";
  const spaced = unwrapCdata(html).replace(BLOCK_TAG, " ");
  if (!withinLimits(spaced)) return markupParagraphs(html).join(" ");
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {}, nonTextTags: NON_TEXT_TAGS })
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

/** Feeds sometimes put inline markup in titles as text ("Why <i>Nature</i> asks"); show it without the tags.
 *  Display only: stored titles stay as they arrived, so matching and content hashes don't change. */
const TITLE_TAG = /<\/?(?:i|b|em|strong|sup|sub|span|small|u|s|mark|abbr|cite|q|code)(?:\s[^<>]*)?>/gi;
export function displayTitle(title: string): string {
  return title.replace(TITLE_TAG, "").replace(/\s+/g, " ").trim() || title;
}

/** Journal feeds open every summary with the same citation ("Nature, Published online: 4 November 2026;
 *  doi:10.1038/…"), which buries the summary and, in older excerpts, runs into it. Show the summary only.
 *  Display only, like displayTitle; the DOI itself is kept on the item. */
const CITATION_LEAD = /^[^;]{1,80}?Published online:[^;]{1,40};\s*doi:10\.\d{4,9}\/[\w.-]*?[0-9a-z](?=\s|[A-Z]|$)\s*/;
export function displayExcerpt(text: string | null): string | null {
  if (!text) return text;
  // A leading "3 min read" from the publisher repeats the reading time the app shows itself.
  const rest = text.replace(CITATION_LEAD, "").replace(/^\d{1,3} min read\s+/i, "");
  return rest.trim() ? rest : text;
}

export function excerpt(text: string, max = 300): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

export const contentHash = (...parts: (string | null | undefined)[]) =>
  createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex");

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)\b/;
/** A link to an article often carries a tracking query or an anchor after the DOI (`…/sed.70161?af=R`); neither is part of it. */
const DOI_TAIL = /[?#].*$/;
export function findDoi(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t ? DOI_RE.exec(t) : null;
    if (m) return m[1]!.replace(DOI_TAIL, "").replace(/[.,;)]+$/, "");
  }
  return null;
}

export function detectKind(opts: { sourceKind: string; url: string | null; doi: string | null; enclosures: { type: string | null }[] }): ItemKind {
  if (opts.sourceKind === "youtube" || (opts.url && /youtube\.com\/watch|youtu\.be\//.test(opts.url))) return "video";
  if (opts.enclosures.some((e) => e.type?.startsWith("audio/"))) return "podcast";
  if (opts.enclosures.some((e) => e.type?.startsWith("video/"))) return "video";
  if (opts.doi) return "paper";
  if (opts.sourceKind === "manual") return "link";
  return "article";
}

export function readMinutes(text: string): number | null {
  const words = text ? text.split(/\s+/).length : 0;
  return words >= 80 ? Math.max(1, Math.round(words / 230)) : null;
}

/** Deterministic hue and initials for generated source avatars. */
export function hueFor(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export function initialsFor(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
