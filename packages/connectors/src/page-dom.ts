/*
 * The tree a page-list recipe is checked against. It is built from the package's tolerant HTML parser and shaped the
 * way libxml2's HTML parser shapes a document, because that is what runs a recipe later (PHP's DOMDocument): no
 * implied <tbody>, comments gone, scripts and styles gone, everything else kept (<noscript>, <template> and <svg>
 * text count in an element's string value), and no <html>, <head> or <body> elements of its own: their children sit
 * under the document node, and an absolute path names them as /html/body.
 */
import { parseHtmlTree, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";

export type PNode = {
  tag: string;
  attrs: Record<string, string>;
  parent: PNode | null;
  children: PNode[];
  /** Document order of the element (the document node is -1). */
  idx: number;
  /** Index of the last element inside this one (itself when it has none). */
  end: number;
  /** The text nodes inside are texts[t0 .. t1). */
  t0: number;
  t1: number;
  /** Position among the parent's children. */
  sib: number;
  cls: string[] | null;
  txt: string | null;
};

export type PageDom = {
  root: PNode;
  /** Every element in document order. */
  all: PNode[];
  /** Elements by tag, each list in document order. */
  byTag: Map<string, PNode[]>;
  texts: string[];
  /** Character offset of each text node in `full`, and one past the end. */
  off: number[];
  full: string;
  lang: string;
  base: string;
  jsonld: string[];
  /** Anchors with an href inside each prefix of `all`, so "has a link below" is a subtraction. */
  hrefsBefore: Int32Array;
  /** Nodes visited and characters read so far; reading stops, as for markup that is too complex, when it passes MAX_WORK. */
  work: number;
};

/** More elements than any real page holds: the page is refused instead of analysed. */
const MAX_ELEMENTS = 120_000;
/** The most nodes visited and characters read while analysing one page (a real page needs a fraction of it). */
const MAX_WORK = 60_000_000;

const SKIP_IN_HEAD = new Set(["meta", "link", "base"]);

function newNode(tag: string, attrs: Record<string, string>, parent: PNode | null): PNode {
  return { tag, attrs, parent, children: [], idx: -1, end: -1, t0: 0, t1: 0, sib: 0, cls: null, txt: null };
}

function copyAttrs(src: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (src) for (const k of Object.keys(src)) out[k] = src[k] ?? "";
  return out;
}

function textOfChildren(x: XNode): string {
  return (x.children ?? []).map((c) => c.data ?? "").join("");
}

/** Throws TooComplexError for markup nested too deeply or holding more elements than MAX_ELEMENTS. */
export function buildPageDom(html: string): PageDom {
  const doc = parseHtmlTree(html);
  const root = newNode("#root", copyAttrs(undefined), null);
  const all: PNode[] = [];
  const texts: string[] = [];
  let lang = "";
  let base = "";
  let titleSeen = false;
  const jsonld: string[] = [];

  type Frame = { kids: XNode[]; i: number; owner: PNode; own: boolean; inHead: boolean };
  const frames: Frame[] = [{ kids: doc.children ?? [], i: 0, owner: root, own: false, inHead: false }];
  while (frames.length) {
    const f = frames[frames.length - 1]!;
    if (f.i >= f.kids.length) {
      frames.pop();
      if (f.own) {
        f.owner.end = all.length - 1;
        f.owner.t1 = texts.length;
      }
      continue;
    }
    const x = f.kids[f.i++]!;
    if (x.type === "text") {
      if (x.data) texts.push(x.data);
      continue;
    }
    if (x.type === "script") {
      if (/^application\/ld\+json\b/i.test((x.attribs?.type ?? "").trim())) jsonld.push(textOfChildren(x));
      continue;
    }
    if (x.type !== "tag") continue;
    const name = (x.name ?? "").toLowerCase();
    const attrs = x.attribs ?? {};
    if (name === "html") {
      lang ||= (attrs.lang || attrs["xml:lang"] || "").trim();
      frames.push({ kids: x.children ?? [], i: 0, owner: f.owner, own: false, inHead: f.inHead });
      continue;
    }
    if (name === "head" || name === "body") {
      frames.push({ kids: x.children ?? [], i: 0, owner: f.owner, own: false, inHead: name === "head" });
      continue;
    }
    if (name === "title" && !titleSeen && f.owner === root) {
      titleSeen = true;
      continue;
    }
    if (name === "base") {
      if (attrs.href && !base) base = attrs.href;
      continue;
    }
    if (f.inHead && SKIP_IN_HEAD.has(name)) continue;
    if (all.length >= MAX_ELEMENTS) throw new TooComplexError();
    const n = newNode(name, copyAttrs(attrs), f.owner);
    n.idx = all.length;
    n.t0 = texts.length;
    all.push(n);
    n.sib = f.owner.children.length;
    f.owner.children.push(n);
    frames.push({ kids: x.children ?? [], i: 0, owner: n, own: true, inHead: false });
  }
  root.end = all.length - 1;
  root.t1 = texts.length;

  const off: number[] = new Array(texts.length + 1);
  let total = 0;
  for (let i = 0; i < texts.length; i++) {
    off[i] = total;
    total += texts[i]!.length;
  }
  off[texts.length] = total;
  const byTag = new Map<string, PNode[]>();
  const hrefsBefore = new Int32Array(all.length + 1);
  for (let i = 0; i < all.length; i++) {
    const n = all[i]!;
    const list = byTag.get(n.tag);
    if (list) list.push(n);
    else byTag.set(n.tag, [n]);
    hrefsBefore[i + 1] = hrefsBefore[i]! + (n.tag === "a" && "href" in n.attrs ? 1 : 0);
  }
  return { root, all, byTag, texts, off, full: texts.join(""), lang, base, jsonld, hrefsBefore, work: 0 };
}

// ---- reading the tree

export function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The XPath string value of a node, collapsed the way a bridge shows it. */
export function textOf(d: PageDom, n: PNode): string {
  if (n.txt === null) {
    const raw = d.full.slice(d.off[n.t0], d.off[n.t1]);
    spend(d, raw.length);
    n.txt = norm(raw);
  }
  return n.txt;
}

/** Counts work against the page's budget; throws TooComplexError when it is spent. */
export function spend(d: PageDom, amount: number): void {
  d.work += amount;
  if (d.work > MAX_WORK) throw new TooComplexError();
}

/** The text with a space between neighbouring pieces, so words that only touch in the markup stay apart. */
export function spacedTextOf(d: PageDom, n: PNode): string {
  const parts = d.texts.slice(n.t0, n.t1);
  spend(d, parts.length);
  return norm(parts.join(" "));
}

export function classesOf(n: PNode): string[] {
  if (n.cls === null) n.cls = (n.attrs.class ?? "").split(/[ \t\r\n]+/).filter(Boolean);
  return n.cls;
}

/** The elements inside `n`, in document order. */
export function descendantsOf(d: PageDom, n: PNode): PNode[] {
  spend(d, n.end - n.idx);
  return n.end > n.idx ? d.all.slice(n.idx + 1, n.end + 1) : [];
}

export function contains(outer: PNode, inner: PNode): boolean {
  return outer.idx <= inner.idx && inner.idx <= outer.end;
}

export function hasLinkBelow(d: PageDom, n: PNode): boolean {
  return d.hrefsBefore[n.end + 1]! - d.hrefsBefore[n.idx + 1]! > 0;
}

export function attr(n: PNode, name: string): string {
  return n.attrs[name] ?? "";
}

/** Whether the tag can be named in a recipe (a letter, then letters, digits and hyphens). */
export function selectableTag(tag: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(tag);
}
