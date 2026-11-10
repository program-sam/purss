import sanitizeHtml from "sanitize-html";
import { TooComplexError, assertShallowMarkup } from "./text.ts";

/*
 * Strict allowlist sanitizer for captured article HTML. Only structural and
 * typographic elements survive; scripts, handlers, styles, forms, embeds, iframes,
 * SVG and every attribute outside the allowlist are removed, and so is text that is only style rules. Links gain
 * rel="noopener noreferrer nofollow"; only http(s) (and mailto on links) are kept.
 */

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
];

const MAX_INPUT = 4 * 1024 * 1024;

const SELECTOR = /^[@\w\s.#*>+~,:()[\]="'^$|%\\&;-]{1,300}$/;
const DECLARATION = /(?:^|[;{\s])-{0,2}[a-z][a-z-]*\s*:\s*[^;{}]+/i;

/**
 * True for text that is only style rules (`.map{position:relative}`), which a page's inline <style>
 * leaves behind when it was escaped or placed where no one expected it. Code a reader is meant to see
 * sits in <pre>/<code>, which callers leave alone; prose is never a run of `selector { property: value }`.
 */
export function looksLikeCss(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || !t.endsWith("}") || !t.includes("{")) return false;
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let rules = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") {
      if (depth === 0) {
        if (!SELECTOR.test(t.slice(selectorStart, i).trim())) return false;
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      if (depth === 0) return false;
      depth--;
      if (depth === 0) {
        const body = t.slice(bodyStart, i);
        if (!DECLARATION.test(body) && !looksLikeCss(body)) return false;
        rules++;
        selectorStart = i + 1;
      }
    }
  }
  return depth === 0 && rules > 0 && t.slice(selectorStart).trim() === "";
}

/** Elements whose text is shown as the code it is. */
const CODE_TAGS = new Set(["pre", "code", "kbd", "samp"]);

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  try {
    return new URL(v, base).href;
  } catch {
    return undefined;
  }
}

export type SanitizeResult = { ok: true; html: string } | { ok: false; reason: "toolarge" | "toocomplex" };

/** Sanitize untrusted HTML. `baseUrl` resolves relative links and image sources. */
export function sanitizeArticleHtml(html: string, baseUrl: string): SanitizeResult {
  if (html.length > MAX_INPUT) return { ok: false, reason: "toolarge" };
  try {
    assertShallowMarkup(html, "html");
  } catch (error) {
    if (error instanceof TooComplexError) return { ok: false, reason: "toocomplex" };
    throw error;
  }
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      time: ["datetime"],
      q: ["cite"],
      blockquote: ["cite"],
      ol: ["start"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "iframe", "object", "embed", "svg", "math", "head", "title"],
    parseStyleAttributes: false,
    // Style rules that ended up as text are not content.
    textFilter: (text, tagName) => (CODE_TAGS.has(tagName) || !looksLikeCss(text) ? text : ""),
    transformTags: {
      a: (tagName, attribs) => {
        const href = absolute(attribs.href, baseUrl);
        const out: Record<string, string> = {};
        if (href) out.href = href;
        if (attribs.title) out.title = attribs.title;
        out.rel = "noopener noreferrer nofollow";
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        const src = absolute(attribs.src, baseUrl);
        const out: Record<string, string> = {};
        if (src) out.src = src;
        for (const k of ["alt", "title", "width", "height"]) if (attribs[k] !== undefined) out[k] = attribs[k]!;
        return { tagName, attribs: out };
      },
    },
    // An image with no source, or a link with nothing visible in it, carries no information.
    exclusiveFilter: (frame) => (frame.tag === "img" && !frame.attribs.src) || (frame.tag === "a" && !frame.text.trim() && frame.mediaChildren.length === 0),
  });
  return { ok: true, html: withoutEmptyBlocks(clean) };
}

/** Removing style text can leave `<p></p>` behind, and so can the page itself. These tags carry no attributes here. */
function withoutEmptyBlocks(html: string): string {
  let out = html;
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(/<(p|div|span)>\s*<\/\1>/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
