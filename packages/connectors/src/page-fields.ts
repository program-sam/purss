/*
 * What an item says about itself: the element that holds its title, the elements that hold a date, the author's own
 * markup (microformats and microdata) and, among several links to the same address, the one that carries the title.
 */
import { classesOf, contains, descendantsOf, spacedTextOf } from "./page-dom.ts";
import type { PNode } from "./page-dom.ts";
import { canonicalUrl, wordCount } from "./page-context.ts";
import type { PageContext } from "./page-context.ts";
import type { ParsedDate } from "./page-dates.ts";

export const HEADS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const HEAD_SET = new Set(HEADS);
const BLOCKISH = new Set(["div", "p", "ul", "ol", "li", "table", "tr", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "blockquote", "dl", "dd", "dt", "form", "main", "aside", "nav"]);
const TITLE_CLASS = /(?:^|[-_ ])(title|headline|heading|name|post-title|entry-title)(?:$|[-_ ])/i;
const BAD_TITLE_CLASS = /(sub-?title|sub-?head|byline|user-?name|file-?name|nick|category|kicker|eyebrow|tag|label|badge|meta|date|time|author|excerpt|summary|description|teaser|caption|read-?more|cta|button|btn|icon|count|comments?)/i;
const DATE_CLASS = /(date|time|posted|published|pubdate|updated|age|when|datum|dag|ago|timestamp|meta)/i;
export const BAD_ANCHOR_TEXT = /^(?:read more|more|lees meer|meer|continue reading|learn more|view|view all|see all|alle|next|previous|volgende|vorige|older|newer|\d{1,3}|»|«|>|<|›|‹|share|reply|comments?|[^\p{L}\p{N}]+)$/iu;
const CTA_TEXT = /^(?:apply|apply now|read more|learn more|view|view details|details|more info|more|open|lees meer|bekijk|solliciteer|sollicitatie|register|sign up|buy tickets|tickets|get tickets|download|watch|listen|see more|continue)\b/i;
const LEAF_SKIP = new Set(["script", "style", "svg", "img", "time", "button", "select", "input", "label"]);
const DATE_PROPS = new Set(["datePublished", "dateCreated", "startDate", "dateModified", "uploadDate"]);

export function isHeading(n: PNode): boolean {
  return HEAD_SET.has(n.tag) || n.attrs.role === "heading";
}

function glued(ctx: PageContext, n: PNode): boolean {
  return ctx.text(n) !== spacedTextOf(ctx.doc, n);
}

function leafBlocks(ctx: PageContext, item: PNode): PNode[] {
  const out: PNode[] = [];
  for (const n of descendantsOf(ctx.doc, item)) {
    if (LEAF_SKIP.has(n.tag)) continue;
    const t = ctx.text(n);
    if (!t || t.length > 300) continue;
    if (n.children.some((c) => BLOCKISH.has(c.tag) && ctx.text(c))) continue;
    out.push(n);
  }
  return out;
}

function dateyHeading(ctx: PageContext, h: PNode): boolean {
  if (descendantsOf(ctx.doc, h).some((x) => x.tag === "time")) return true;
  const t = ctx.text(h);
  return wordCount(t) <= 6 && ctx.absoluteDate(t) !== null;
}

/** The element whose text is the item's title, and the element chosen before descending past glued-together children. */
export function pickTitleNode(ctx: PageContext, item: PNode, anchor: PNode | null): { node: PNode | null; before: PNode | null } {
  const dateOnly = (t: string) => ctx.isDateOnly(t);
  const heads = [...(isHeading(item) ? [item] : []), ...descendantsOf(ctx.doc, item)].filter((n) => isHeading(n) && ctx.text(n));
  const at = anchor ? ctx.text(anchor) : "";
  let cand: PNode | null = null;
  const related = heads.filter((h) => anchor !== null && (contains(h, anchor) || contains(anchor, h)) && !dateyHeading(ctx, h) && !dateOnly(ctx.text(h)));
  if (related.length) {
    const rank = (h: PNode) => ((HEAD_SET.has(h.tag) && Number(h.tag[1]) <= 4) || !HEAD_SET.has(h.tag) ? 0 : 1);
    related.sort((a, b) => rank(a) - rank(b) || ctx.text(b).length - ctx.text(a).length);
    cand = related[0]!;
  }
  if (cand === null && anchor && at && !BAD_ANCHOR_TEXT.test(at) && at.length <= 160 && !dateOnly(at)
    && (!descendantsOf(ctx.doc, anchor).some((c) => BLOCKISH.has(c.tag)) || wordCount(at) <= 14)) cand = anchor;
  if (cand === null) {
    for (const n of descendantsOf(ctx.doc, item)) {
      const ident = classesOf(n).join(" ");
      const t = ctx.text(n);
      if (TITLE_CLASS.test(ident) && !BAD_TITLE_CLASS.test(ident.replace(/title|headline|heading/gi, "")) && t && !dateOnly(t) && wordCount(t) >= 2 && !/^[\d.\s]+$/.test(t)) {
        cand = n;
        break;
      }
    }
  }
  if (cand === null) {
    for (const h of heads) {
      const t = ctx.text(h);
      if (wordCount(t) >= 2 && !dateyHeading(ctx, h) && !dateOnly(t) && !BAD_ANCHOR_TEXT.test(t)) {
        cand = h;
        break;
      }
    }
  }
  if (cand === null) {
    let best: { s: number; n: PNode } | null = null;
    for (const n of leafBlocks(ctx, item)) {
      const t = ctx.text(n);
      const ident = classesOf(n).join(" ");
      if (dateOnly(t) || BAD_ANCHOR_TEXT.test(t)) continue;
      let s = Math.min(t.length, 120) + (wordCount(t) >= 3 ? 15 : 0);
      if (isHeading(n)) s += 30;
      if (TITLE_CLASS.test(ident)) s += 20;
      if (BAD_TITLE_CLASS.test(ident)) s -= 25;
      if (["span", "small", "em", "b", "strong"].includes(n.tag) && wordCount(t) < 3) s -= 10;
      if (best === null || s > best.s) best = { s, n };
    }
    cand = best ? best.n : at ? anchor : null;
  }
  const before = cand;
  // A node whose children touch without a space would read run together: use the dominant child instead.
  for (let i = 0; i < 3; i++) {
    if (cand && glued(ctx, cand)) {
      const kids = cand.children.filter((c) => ctx.text(c));
      if (kids.length) {
        const big = kids.reduce((a, b) => (ctx.text(b).length > ctx.text(a).length ? b : a));
        if (ctx.text(big).length >= 0.6 * ctx.text(cand).length) {
          cand = big;
          continue;
        }
      }
    }
    break;
  }
  return { node: cand, before };
}

export type DateHit = {
  /** Lower is better. */
  priority: number;
  node: PNode;
  attr: string | null;
  parsed: ParsedDate;
  how: string;
};

/** Date-bearing nodes in or below `root`, best first. */
export function dateNodesIn(ctx: PageContext, root: PNode, includeSelf = true): DateHit[] {
  const out: DateHit[] = [];
  const nodes = [...(includeSelf ? [root] : []), ...descendantsOf(ctx.doc, root)];
  const parse = (s: string) => ctx.date(s);
  for (const n of nodes) {
    if (n.tag === "time") {
      const dt = (n.attrs.datetime ?? "").trim();
      const r = dt ? parse(dt) : null;
      if (r && r.kind === "absolute") {
        out.push({ priority: 0, node: n, attr: "datetime", parsed: r, how: "time[@datetime]" });
        continue;
      }
      const rt = parse(ctx.text(n));
      if (rt) {
        out.push({ priority: 2, node: n, attr: null, parsed: rt, how: "time text" });
        continue;
      }
    }
    const ip = n.attrs.itemprop ?? "";
    if (DATE_PROPS.has(ip)) {
      let found = false;
      for (const a of ["content", "datetime"]) {
        const v = n.attrs[a] ?? "";
        const r = v ? parse(v) : null;
        if (r) {
          out.push({ priority: 1, node: n, attr: a, parsed: r, how: `itemprop ${ip}` });
          found = true;
          break;
        }
      }
      if (!found) {
        const r = parse(ctx.text(n));
        if (r) out.push({ priority: 2, node: n, attr: null, parsed: r, how: "itemprop text" });
      }
      continue;
    }
    const tt = n.attrs.title ?? "";
    if (tt && tt.length < 40 && /\d{4}-\d{2}-\d{2}/.test(tt)) {
      const r = parse(tt);
      if (r && r.kind === "absolute") {
        out.push({ priority: 1, node: n, attr: "title", parsed: r, how: "@title ISO" });
        continue;
      }
    }
    const t = ctx.text(n);
    if (!t || t.length > 60) continue;
    if (n.tag === "a" && t.length > 30) continue;
    if (ctx.isDateOnly(t)) {
      const r = parse(t);
      if (r) out.push({ priority: DATE_CLASS.test(classesOf(n).join(" ")) ? 3 : 4, node: n, attr: null, parsed: r, how: "date text" });
    }
  }
  out.sort((a, b) => a.priority - b.priority || a.node.idx - b.node.idx);
  // Of nested nodes with the same text, keep the one that comes first.
  const res: DateHit[] = [];
  for (const h of out) {
    const text = ctx.text(h.node);
    if (res.some((m) => m.node !== h.node && contains(m.node, h.node) && ctx.text(m.node) === text)) continue;
    res.push(h);
  }
  return res;
}

/** Fallback: a small element whose text contains a date among other words ("Jan 5 · 3 comments"). */
export function dateWithTextIn(ctx: PageContext, item: PNode): DateHit[] {
  let best: DateHit | null = null;
  for (const n of [item, ...descendantsOf(ctx.doc, item)]) {
    const t = ctx.text(n);
    if (!t || t.length > 160 || n.children.some((c) => BLOCKISH.has(c.tag) && ctx.text(c))) continue;
    const r = ctx.date(t);
    if (r && (best === null || t.length < ctx.text(best.node).length)) best = { priority: 5, node: n, attr: null, parsed: r, how: "text containing a date" };
  }
  return best ? [best] : [];
}

export type Hints = { title?: PNode; link?: PNode; date?: PNode };

/** The author's own markup (microformats, microdata) inside an item. */
export function semanticHints(ctx: PageContext, item: PNode): Hints {
  const h: Hints = {};
  for (const n of [item, ...descendantsOf(ctx.doc, item)]) {
    const cl = classesOf(n);
    const ip = n.attrs.itemprop ?? "";
    if (!h.title && (cl.includes("p-name") || cl.includes("entry-title") || ip === "headline" || ip === "name") && ctx.text(n)) h.title = n;
    if (!h.link && ((n.tag === "a" && (cl.includes("u-url") || n.attrs.rel === "bookmark")) || (ip === "url" && n.tag === "a"))) h.link = n;
    if (!h.date && (cl.includes("dt-published") || (cl.includes("published") && ["time", "abbr", "span"].includes(n.tag)) || ip === "datePublished" || ip === "startDate")) h.date = n;
  }
  return h;
}

/** Among the links inside an item that point at the same address, the one that carries the title. */
export function bestAnchor(ctx: PageContext, item: PNode, anchor: PNode | null): PNode | null {
  if (!anchor) return null;
  const url = canonicalUrl(ctx.abs(anchor));
  const cands = [item, ...descendantsOf(ctx.doc, item)].filter((a) => a.tag === "a" && a.attrs.href && ctx.anchorSet.has(a) && canonicalUrl(ctx.abs(a)) === url);
  if (cands.length < 2) return anchor;
  const heads = descendantsOf(ctx.doc, item).filter(isHeading);
  const score = (a: PNode) => {
    const t = ctx.text(a);
    let s = Math.min(t.length, 80) / 8;
    if (!t) s -= 5;
    if (CTA_TEXT.test(t) || BAD_ANCHOR_TEXT.test(t)) s -= 15;
    if (heads.some((h) => contains(h, a) || contains(a, h))) s += 10;
    return s;
  };
  return cands.reduce((best, a) => (score(a) > score(best) ? a : best));
}

