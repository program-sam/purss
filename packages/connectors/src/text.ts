import { Parser, parseDocument, Tokenizer } from "htmlparser2";

/** Minimal structural view of htmlparser2/domhandler nodes (kept local on purpose). */
export type XNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: XNode[];
};

/** Raised when markup nests deeper, or is larger, than anything legitimate (a parser-stalling attack). */
export class TooComplexError extends Error {
  constructor() {
    super("markup is too complex to read safely");
  }
}

/** Real pages nest a few dozen elements deep; Chromium's HTML parser stops nesting at 512. */
export const MAX_MARKUP_DEPTH = 512;

/**
 * htmlparser2's open-element stack (top first) with constant-time push and pop. The parser's own
 * array is shifted on every open and close, which is what makes deep nesting quadratic.
 */
class TopFirstStack {
  private readonly items: string[] = [];
  constructor() {
    Object.defineProperty(this, 0, { get: () => this.items[this.items.length - 1] });
  }
  get length(): number { return this.items.length; }
  set length(n: number) { this.items.length = n; }
  unshift(name: string): number { return this.items.push(name); }
  shift(): string | undefined { return this.items.pop(); }
  includes(name: string): boolean { return this.items.includes(name); }
  indexOf(name: string): number {
    const at = this.items.lastIndexOf(name);
    return at === -1 ? -1 : this.items.length - 1 - at;
  }
}

/**
 * Refuse markup a parser would stall on, before it reaches one. The markup is read by htmlparser2
 * itself (so quoting, comments, raw-text elements, ignored and implied closing tags count exactly
 * as a parser counts them), with a stack that keeps the reading linear. Throws TooComplexError
 * when more than `depth` elements are open at once, or when it yields more than `events` tags,
 * attributes, closing tags and pieces of text (the work a sanitizer does is proportional to these).
 */
export function assertShallowMarkup(text: string, mode: "xml" | "html", limits: { depth?: number; events?: number } = {}): void {
  const maxDepth = limits.depth ?? MAX_MARKUP_DEPTH;
  const maxEvents = limits.events ?? Infinity;
  let events = 0;
  const count = () => {
    if (++events > maxEvents) throw new TooComplexError();
  };
  const parser: Parser = new Parser({
    onopentagname() {
      count();
      if ((parser as unknown as { stack: TopFirstStack }).stack.length > maxDepth) throw new TooComplexError();
    },
    onattribute: count,
    onclosetag: count,
    ontext: count,
    oncomment: count,
    onprocessinginstruction: count,
  }, { xmlMode: mode === "xml", decodeEntities: true });
  (parser as unknown as { stack: TopFirstStack }).stack = new TopFirstStack();
  parser.end(text);
}

export function parseXml(text: string): XNode {
  assertShallowMarkup(text, "xml");
  return parseDocument(text, { xmlMode: true, decodeEntities: true }) as unknown as XNode;
}

export function parseHtmlTree(text: string): XNode {
  assertShallowMarkup(text, "html");
  return parseDocument(text, { decodeEntities: true }) as unknown as XNode;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeXml(text: string): string {
  // Strip characters that are not allowed in XML 1.0 before escaping.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
  return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const SKIPPED = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed"]);

/** The parser types <script> and <style> elements as their own kinds, not as ordinary tags; their text is code, never content. */
function isSkipped(node: XNode): boolean {
  if (node.type === "script" || node.type === "style") return true;
  return node.type === "tag" && !!node.name && SKIPPED.has(node.name.toLowerCase());
}
const BLOCK = new Set(["p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote", "pre", "section", "article", "hr", "table"]);

const UNREAD = new Set(["script", "style", "template"]);

/**
 * The paragraphs of text in HTML, read by htmlparser2's tokenizer alone (no element tree), so it
 * is linear for any input: the fallback for markup too complex to parse. Script, style and
 * template contents are not text; block elements separate paragraphs.
 */
export function markupParagraphs(html: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let skipping: string | null = null;
  const flush = () => {
    const text = current.join("").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  const nothing = () => {};
  const tokenizer = new Tokenizer({ decodeEntities: true }, {
    ontext(start, end) {
      if (!skipping) current.push(html.slice(start, end));
    },
    ontextentity(codepoint) {
      if (!skipping) current.push(String.fromCodePoint(codepoint));
    },
    onopentagname(start, end) {
      const name = html.slice(start, end).toLowerCase();
      if (skipping) return;
      if (UNREAD.has(name)) skipping = name;
      else if (BLOCK.has(name)) flush();
    },
    onclosetag(start, end) {
      const name = html.slice(start, end).toLowerCase();
      if (skipping) {
        if (name === skipping) skipping = null;
      } else if (BLOCK.has(name)) flush();
    },
    isInForeignContext: () => false,
    onattribdata: nothing, onattribentity: nothing, onattribend: nothing, onattribname: nothing, oncdata: nothing, oncomment: nothing,
    ondeclaration: nothing, onend: nothing, onopentagend: nothing, onprocessinginstruction: nothing, onselfclosingtag: nothing,
  });
  tokenizer.write(html);
  tokenizer.end();
  flush();
  return paragraphs;
}

/** Plain text of an HTML fragment, without recursion (safe for hostile nesting). */
export function htmlToText(html: string, maxLength = 1_000_000): string {
  let root: XNode;
  try {
    root = parseHtmlTree(html.length > maxLength * 2 ? html.slice(0, maxLength * 2) : html);
  } catch (error) {
    if (error instanceof TooComplexError) return "";
    throw error;
  }
  const out: string[] = [];
  let length = 0;
  const stack: XNode[] = [root];
  while (stack.length && length < maxLength) {
    const node = stack.pop()!;
    if (node.type === "text") {
      const data = node.data ?? "";
      out.push(data);
      length += data.length;
      continue;
    }
    if (isSkipped(node)) continue;
    if (node.type === "tag" && node.name && BLOCK.has(node.name.toLowerCase())) {
      stack.push({ type: "text", data: " " });
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    if (node.type === "tag" && node.name && BLOCK.has(node.name.toLowerCase())) out.push(" ");
  }
  return out.join("").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Plain text of an HTML fragment that keeps paragraph breaks (blank line between blocks). */
export function htmlToPlainText(html: string, maxLength = 2_000_000): string {
  let root: XNode;
  try {
    root = parseHtmlTree(html.length > maxLength * 2 ? html.slice(0, maxLength * 2) : html);
  } catch (error) {
    if (error instanceof TooComplexError) return "";
    throw error;
  }
  const out: string[] = [];
  let length = 0;
  const BREAK = "\u0000";
  const stack: XNode[] = [root];
  while (stack.length && length < maxLength) {
    const node = stack.pop()!;
    if (node.type === "text") {
      const data = node.data ?? "";
      if (data === BREAK) {
        out.push("\n\n");
        length += 2;
      } else {
        out.push(data.replace(/\s+/g, " "));
        length += data.length;
      }
      continue;
    }
    if (isSkipped(node)) continue;
    const name = node.type === "tag" && node.name ? node.name.toLowerCase() : "";
    if (name === "br") {
      out.push("\n");
      continue;
    }
    const block = name !== "" && BLOCK.has(name);
    if (block) {
      out.push("\n\n");
      stack.push({ type: "text", data: BREAK });
    }
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One-line text for titles: strips markup only when it looks like markup. */
export function cleanLine(value: string | null | undefined, max = 500): string | null {
  if (!value) return null;
  let text = value;
  if (/<[a-zA-Z/!][^>]*>|&[a-zA-Z#][a-zA-Z0-9]{1,10};/.test(text)) text = htmlToText(text, max * 4);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Plain single-line text (no markup interpretation): control characters out, whitespace collapsed. */
export function plainLine(value: string | null | undefined, max = 200): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
