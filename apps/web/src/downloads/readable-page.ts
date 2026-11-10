/*
 * The readable article of a publisher's page, made on this device for a download (the apps only): the
 * page is parsed into an inert document (nothing runs, nothing loads), Mozilla Readability finds the
 * article (the library PURSS uses for its own copies), and a strict allowlist rebuilds it from
 * scratch: only structural and typographic elements, only the attributes listed, only https pictures
 * and http(s)/mailto links. The reader's display pass (lib/article-html.ts) runs on it again.
 */

/** A page larger than this isn't read; PURSS's own copies stop at the same size. */
export const PAGE_MAX_BYTES = 3 * 1024 * 1024;
/** The article kept: no larger than a copy PURSS keeps. */
const ARTICLE_MAX_CHARS = 1_500_000;
/** Less readable text than this is no article (PURSS's rule too). */
const MIN_TEXT = 200;

const ALLOWED = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);
/** Dropped with everything inside them; any other element not allowed keeps its content without the element. */
const DROPPED = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea", "option",
  "link", "meta", "base", "head", "title", "svg", "math", "audio", "video", "source", "track", "canvas", "picture", "map", "dialog",
]);
const ATTRS: Record<string, readonly string[]> = {
  a: ["href", "title"], img: ["src", "alt", "width", "height"], abbr: ["title"], time: ["datetime"], ol: ["start"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
  q: ["cite"], blockquote: ["cite"],
};

export type ReadableArticle = { ok: true; title: string | null; html: string } | { ok: false; message: string };

/** The character set a page declares in its markup (a `<meta charset>` or `http-equiv`), read from its first bytes. */
function declaredCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

/** A page's bytes as text, in the character set it declares (UTF-8 when it declares none or one this device can't read). */
export function decodePage(bytes: Uint8Array): string {
  const charset = declaredCharset(bytes);
  try { return new TextDecoder(charset ?? "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** This app's own address: a link or picture that points here never came from the publisher. */
const ownOrigin = (): string | null => (typeof location === "undefined" ? null : location.origin);

function safeUrl(raw: string | null, base: string, schemes: readonly string[]): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return schemes.includes(u.protocol) && u.origin !== ownOrigin() ? u.href : null;
  } catch { return null; }
}

/** Rebuild `from`'s children under `to` in `doc`, keeping only what the allowlist allows. */
function rebuild(from: Node, to: Node, doc: Document, base: string, depth: number): void {
  if (depth > 200) return;
  for (const n of Array.from(from.childNodes)) {
    if (n.nodeType === 3) { to.appendChild(doc.createTextNode(n.textContent ?? "")); continue; }
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    if (!ALLOWED.has(tag)) { rebuild(el, to, doc, base, depth + 1); continue; }
    const out = doc.createElement(tag);
    for (const name of ATTRS[tag] ?? []) {
      const v = el.getAttribute(name);
      if (v === null) continue;
      if (name === "href") { const href = safeUrl(v, base, ["http:", "https:", "mailto:"]); if (href) out.setAttribute("href", href); continue; }
      if (name === "src") { const src = safeUrl(v, base, ["https:"]); if (src) out.setAttribute("src", src); continue; }
      if (name === "cite") { const cite = safeUrl(v, base, ["http:", "https:"]); if (cite) out.setAttribute("cite", cite); continue; }
      out.setAttribute(name, v.slice(0, 300));
    }
    if (tag === "img" && !out.getAttribute("src")) continue;
    rebuild(el, out, doc, base, depth + 1);
    to.appendChild(out);
  }
}

/** Keep only allowed elements and attributes of article HTML, with links and pictures made absolute against `base`. */
export function cleanArticleHtml(html: string, base: string, parser: DOMParser = new DOMParser()): string {
  const src = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  const out = parser.parseFromString("<!doctype html><html><body></body></html>", "text/html");
  rebuild(src.body, out.body, out, base, 0);
  return out.body.innerHTML;
}

/** The readable article of a page's HTML; `url` is where the page came from, for its links and pictures. */
export async function readablePage(page: string, url: string, parser: DOMParser = new DOMParser()): Promise<ReadableArticle> {
  const noArticle: ReadableArticle = { ok: false, message: "No readable article was found on the publisher's page. It may need JavaScript or a login." };
  const doc = parser.parseFromString(page, "text/html");
  // Every address is made absolute against the page first: Readability would resolve what's left against this app's address.
  for (const el of Array.from(doc.querySelectorAll("[href],[src],[cite]"))) {
    for (const name of ["href", "src", "cite"]) {
      const v = el.getAttribute(name);
      if (v === null) continue;
      try { el.setAttribute(name, new URL(v.trim(), url).href); } catch { el.removeAttribute(name); }
    }
  }
  const { Readability } = await import("@mozilla/readability");
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(doc, { charThreshold: 150, maxElemsToParse: 40_000, keepClasses: false }).parse();
  } catch { return noArticle; }
  if (!article?.content) return noArticle;
  const html = cleanArticleHtml(article.content, url, parser);
  const text = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html").body.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length < MIN_TEXT) return noArticle;
  if (html.length > ARTICLE_MAX_CHARS) return { ok: false, message: "The article is longer than a download keeps." };
  const title = (article.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  return { ok: true, title, html };
}
