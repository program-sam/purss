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

/** The character references plain text may carry once its markup is gone (the few that are in use; others stay as they arrived). */
const NAMED_REFS: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", laquo: "«", raquo: "»", middot: "·", bull: "•",
};

/**
 * Plain text with its character references (`&#039;`, `&amp;`, `&hellip;`) turned into the characters. One pass only, so
 * `&amp;#039;` becomes `&#039;` and no more: what a feed escaped twice is shown as once-escaped, never decoded without end.
 */
export function decodeCharRefs(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return Object.hasOwn(NAMED_REFS, name) ? NAMED_REFS[name]! : Object.hasOwn(NAMED_REFS, name.toLowerCase()) ? NAMED_REFS[name.toLowerCase()]! : whole;
    const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
    // Control characters, surrogates and anything beyond Unicode are not text.
    return code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) || code === 0x09 || code === 0x0a ? String.fromCodePoint(code) : whole;
  });
}

/** Elements whose text is shown as the code it is. */
const CODE_TAGS = new Set(["pre", "code", "kbd", "samp"]);

const TAGS = "p|div|span|b|strong|i|em|u|s|a|ul|ol|li|h[1-6]|blockquote|figure|figcaption|img|table|thead|tbody|tr|td|th|small|sub|sup|abbr|cite|q|mark|time";
/** A tag some feeds escaped as text: `&lt;p class=&quot;x&quot;&gt;`, `&lt;/p&gt;`, `&lt;br /&gt;`. */
const ESCAPED_TAG = new RegExp(`&lt;(\\/?)(${TAGS}|br|hr)((?:\\s(?:(?!&gt;|&lt;)[\\s\\S])*?)?)(\\/?)&gt;`, "gi");
const ESCAPED_OPEN = new RegExp(`&lt;(?:${TAGS})(?:\\s(?:(?!&gt;|&lt;)[\\s\\S])*?)?&gt;`, "i");
const ESCAPED_CLOSE = new RegExp(`&lt;\\/(?:${TAGS})&gt;`, "i");
const ESCAPED_BREAK = /&lt;br\s*\/?&gt;/i;
const CODE_TAG = /<(\/?)(?:pre|code|kbd|samp)\b[^>]*>/gi;
const DOUBLE_REF = /&amp;(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo|copy|reg|trade|euro|pound|laquo|raquo);/g;
const MAX_REPAIRED = 3_000_000;

/** `fn` over the parts of the markup that are not inside a code sample (`pre`, `code`, `kbd`, `samp`); the samples themselves stay as they are. */
function outsideCode(html: string, fn: (part: string) => string): string {
  let out = "";
  let last = 0;
  let depth = 0;
  for (const m of html.matchAll(CODE_TAG)) {
    const part = html.slice(last, m.index);
    out += (depth === 0 ? fn(part) : part) + m[0];
    depth = m[1] ? Math.max(0, depth - 1) : depth + 1;
    last = m.index! + m[0].length;
  }
  const rest = html.slice(last);
  return out + (depth === 0 ? fn(rest) : rest);
}

/**
 * What a feed escaped once too often, put right before the markup is read. Character references escaped twice (`&amp;#039;`,
 * shown as `&#039;`) lose one level. Tags escaped as text (`&lt;p&gt;…&lt;/p&gt;`, shown as a raw `<p>`) become tags when the text holds
 * an escaped opening and an escaped closing tag, or a line break (one escaped tag in a sentence is a person writing about a tag).
 * One pass each, nothing nested, and code samples are left as they are; the sanitizer still decides what the tags may be.
 */
export function repairMarkup(html: string): string {
  if (!html.includes("&") || html.length > MAX_REPAIRED) return html;
  let out = outsideCode(html, (part) => part.replace(DOUBLE_REF, "&$1;"));
  let marked = false;
  outsideCode(out, (part) => { marked ||= (ESCAPED_OPEN.test(part) && ESCAPED_CLOSE.test(part)) || ESCAPED_BREAK.test(part); return part; });
  if (marked) {
    out = outsideCode(out, (part) => part.replace(ESCAPED_TAG, (_whole, slash: string, name: string, attrs: string, close: string) =>
      `<${slash}${name}${attrs.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, "&")}${close}>`));
  }
  return out;
}

/**
 * Strict allowlist for rendering feed/captured HTML. No scripts, handlers, embeds or forms.
 * Markup beyond SANITIZE_LIMITS keeps only its text, as escaped paragraphs.
 */
export function sanitize(html: string | null | undefined): string | null {
  if (!html) return null;
  const repaired = embedLabelled(repairMarkup(unwrapCdata(html)));
  if (!withinLimits(repaired)) return markupParagraphs(html).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  return sanitizeHtml(repaired, {
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
  const spaced = embedLabelled(repairMarkup(unwrapCdata(html))).replace(BLOCK_TAG, " ");
  if (!withinLimits(spaced)) return markupParagraphs(html).join(" ");
  // What a feed escaped twice is still a character reference after the markup is read once: `&amp;#039;` is `&#039;` here, an apostrophe once decoded.
  return decodeCharRefs(sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {}, nonTextTags: NON_TEXT_TAGS })
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
    .replace(/\s+/g, " ").trim();
}

/** Feeds sometimes put inline markup in titles as text ("Why <i>Nature</i> asks"); show it without the tags.
 *  Display only: stored titles stay as they arrived, so matching and content hashes don't change. */
/** What Bluesky's feed writes into a post's text where the post carries a quote or an attachment it does not send, and what is shown in its place. */
const EMBED_PLACEHOLDER = /\[contains quote post or other embedded content\]/gi;
export const EMBED_LABEL = "[quote or attachment: open the post to see it]";
const embedLabelled = (text: string): string => (text.includes("[contains") ? text.replace(EMBED_PLACEHOLDER, EMBED_LABEL) : text);

/** Tags that are only text in an excerpt (the excerpt is plain text, so any real tag is one a feed escaped). */
const EXCERPT_TAG = /<\/?(?:p|div|span|br|hr|a|b|strong|i|em|u|s|ul|ol|li|h[1-6]|blockquote|figure|figcaption|img|table|thead|tbody|tr|td|th|small|sub|sup|abbr|cite|q|mark|time)(?:\s[^<>]*)?\/?>/gi;
const TITLE_TAG = /<\/?(?:i|b|em|strong|sup|sub|span|small|u|s|mark|abbr|cite|q|code)(?:\s[^<>]*)?>/gi;
export function displayTitle(title: string): string {
  return decodeCharRefs(embedLabelled(title).replace(TITLE_TAG, "")).replace(/\s+/g, " ").trim() || title;
}

/** "podcast@radiofrance.com (Radio France)": how RSS writes an author, an address with the name beside it. */
const ADDRESS_THEN_NAME = /^[^\s@()<>]+@[^\s@()<>]+\s*\((.+)\)$/;
const NAME_THEN_ADDRESS = /^(.+?)\s*[<(]\s*[^\s@()<>]+@[^\s@()<>]+\s*[>)]$/;
const BARE_ADDRESS = /^<?[^\s@()<>]+@[^\s@()<>]+>?$/;
/** Initials after a surname, as journal feeds split them: one person's "S." is not repeated by another's. */
const INITIALS_ONLY = /^(?:\p{Lu}\.?[\s-]*)+$/u;

/**
 * An author line as it is shown: each name without the address RSS writes beside it ("podcast@radiofrance.com (Radio France)"
 * is "Radio France"), an address with no name dropped (nothing left to show: null), and a person the engine joined twice
 * ("; " between the RSS author and the feed's own) shown once. Parts stay separated by ";", which is how journal feeds list
 * "Kaur; S.; Turin; T. C." (the reader sets those). A person there is a surname with the initials that follow it, and only a
 * whole person that repeats is dropped: "Smith; J.; Smith; A." is two people. Display only, like displayTitle: the stored line,
 * search and the data export keep what the feed sent.
 */
export function displayAuthor(author: string | null): string | null {
  if (!author) return null;
  // A name, with the initials parts that follow it. Initials with no name before them stand alone.
  const people: { parts: string[]; named: boolean }[] = [];
  for (const raw of author.split(";")) {
    const part = raw.trim();
    const name = (ADDRESS_THEN_NAME.exec(part) ?? NAME_THEN_ADDRESS.exec(part))?.[1]?.trim() ?? (BARE_ADDRESS.test(part) ? "" : part);
    if (!name) continue;
    const last = people.at(-1);
    if (INITIALS_ONLY.test(name) && last) last.parts.push(name);
    else people.push({ parts: [name], named: !INITIALS_ONLY.test(name) });
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const person of people) {
    if (person.named) {
      const key = person.parts.join("\u0000").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    parts.push(...person.parts);
  }
  return parts.length ? parts.join("; ") : null;
}

/** Journal feeds open every summary with the same citation ("Nature, Published online: 4 November 2026;
 *  doi:10.1038/…"), which buries the summary and, in older excerpts, runs into it. Show the summary only.
 *  Display only, like displayTitle; the DOI itself is kept on the item. */
const CITATION_LEAD = /^[^;]{1,80}?Published online:[^;]{1,40};\s*doi:10\.\d{4,9}\/[\w.-]*?[0-9a-z](?=\s|[A-Z]|$)\s*/;
export function displayExcerpt(text: string | null): string | null {
  if (!text) return text;
  // Markup a feed escaped (`© <p>Photography: …</p>`) was kept as text in the excerpt: shown without the tags, and without a character reference left over.
  const plain = decodeCharRefs(embedLabelled(text)).replace(EXCERPT_TAG, " ").replace(/\s+/g, " ").trim();
  // A leading "3 min read" from the publisher repeats the reading time the app shows itself.
  const rest = plain.replace(CITATION_LEAD, "").replace(/^\d{1,3} min read\s+/i, "");
  return rest.trim() ? rest : plain || text;
}

/**
 * What an item's excerpt adds to its title. A post has no headline, so its title is its own first words (cut short with "…" when long) and its
 * excerpt is the whole text: the same words twice in a row. The excerpt is left out when it only repeats the title, and starts after it when
 * the title is the start of it. Both as shown (`displayTitle`, `displayExcerpt`).
 */
export function excerptBeyondTitle(title: string, excerptText: string | null): string | null {
  if (!excerptText) return excerptText;
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const shown = displayTitle(title);
  if (norm(shown.replace(/…$/, "")) === norm(excerptText.replace(/…$/, ""))) return null;
  if (shown.endsWith("…")) {
    const start = shown.slice(0, -1).trimEnd();
    if (start && excerptText.startsWith(start)) return excerptText.slice(start.length).trim() || null;
  }
  return excerptText;
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

/** A post on Bluesky, as its feed links it (`https://bsky.app/profile/<handle or DID>/post/<id>`). */
const BLUESKY_POST = /^https:\/\/(?:www\.)?bsky\.app\/profile\/[^/?#]+\/post\/[A-Za-z0-9]+/;

export function detectKind(opts: { sourceKind: string; url: string | null; doi: string | null; enclosures: { type: string | null }[] }): ItemKind {
  if (opts.url && BLUESKY_POST.test(opts.url)) return "post";
  if (opts.sourceKind === "youtube" || (opts.url && /youtube\.com\/watch|youtu\.be\//.test(opts.url))) return "video";
  if (opts.enclosures.some((e) => e.type?.startsWith("audio/"))) return "podcast";
  if (opts.enclosures.some((e) => e.type?.startsWith("video/"))) return "video";
  if (opts.doi) return "paper";
  if (opts.sourceKind === "manual") return "link";
  return "article";
}

/** Words a minute of reading, as the minutes shown and the Short and Long filters count them. */
const WORDS_PER_MINUTE = 230;

/**
 * Whole minutes a text takes to read, rounded up, so a few lines are 1 min and "Short (up to 5 min)" holds them. Null only for a text with
 * no words. It counts the text there is (the feed's, or the readable copy once one is saved), not what a page might hold beyond it.
 */
export function readMinutes(text: string): number | null {
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return words > 0 ? Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) : null;
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
