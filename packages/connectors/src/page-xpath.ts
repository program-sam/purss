/*
 * The XPath 1.0 a page-list recipe may use, as data: a small grammar (class and attribute tests, child and
 * descendant steps, the sibling and preceding axes, a position, a union, one concat), one parser that refuses
 * everything else, one writer, and an evaluator that follows libxml2's reading of those expressions. The detector
 * builds recipes from the same pieces it later checks them with, and the bridge router checks a stored recipe with
 * `validateRecipe` before it passes anything to RSS-Bridge's XPathBridge.
 */
import { attr, classesOf, hasLinkBelow, spend } from "./page-dom.ts";
import type { PageDom, PNode } from "./page-dom.ts";

export type Pred =
  /** contains(concat(' ', normalize-space(@class), ' '), ' v ') */
  | { k: "cls"; v: string }
  /** contains(@class, 'v'): the stable part of a class that carries a build hash */
  | { k: "clsc"; v: string }
  /** @name='v' */
  | { k: "attr"; name: string; v: string }
  /** @name */
  | { k: "has"; name: string }
  /** contains(@name, 'v') */
  | { k: "attrc"; name: string; v: string }
  /** starts-with(@id, 'v') */
  | { k: "idpre"; v: string }
  /** .//a[@href] */
  | { k: "hasa" }
  /** [n] */
  | { k: "pos"; n: number };

export type Axis = "child" | "desc" | "psib" | "fsib" | "prec";
export type Step = { axis: Axis; tag: string; preds: Pred[] };
/** A path from the document (`root`) or from the item; `nth` wraps it as (path)[n]; `attr` ends it with /@attr. */
export type PathExpr = { kind: "path"; root: boolean; steps: Step[]; nth?: number; attr?: string };
/** concat('literal', ./@attr) */
export type ConcatExpr = { kind: "concat"; literal: string; attr: string };
export type UnionExpr = { kind: "union"; parts: PathExpr[] };
export type Expr = PathExpr | ConcatExpr | UnionExpr;

export type PageListRecipe = { item: string; title: string; link: string; date?: string };
export type RecipeField = keyof PageListRecipe;
export type RecipeRefusal = "shape" | "tooLong" | "forbidden" | "syntax" | "tooDeep" | "tooMany" | "wrongForm" | "badLiteral";
export type RecipeCheck = { ok: true } | { ok: false; field: RecipeField | null; reason: RecipeRefusal };

export const MAX_EXPRESSION_LENGTH = 200;
const MAX_STEPS = 16;
const MAX_PREDS = 4;
const MAX_UNION = 6;
const MAX_LITERAL = 120;
const MAX_POSITION = 9999;

// ---- which class names can identify an element

const UTILITY = /^(?:-?(?:flex|grid|block|inline|inline-block|hidden|relative|absolute|fixed|sticky|static|container|truncate|underline|uppercase|lowercase|capitalize|italic|sr-only|rounded|border|shadow|transition|transform|overflow-\w+|cursor-\w+)|(?:w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|text|bg|font|leading|tracking|items|justify|self|place|col|row|space|z|top|left|right|bottom|min|max|opacity|duration|ease|line|order|basis|grow|shrink|fill|stroke|ring|outline|divide|aspect|object|inset|translate|scale|rotate|grid-cols|grid-rows|col-span|row-span|whitespace|break|list|align|decoration|underline-offset|backdrop|blur|brightness|from|via|to)-[\w./[\]%#-]+)$/;
const STATE = /^(?:active|current|first|last|odd|even|selected|open|closed|show|hide|hidden|visible|is-\w+|has-\w+|js-\w+|first-child|last-child|focus|hover|disabled|loading|loaded|lazy|lazyload|lazyloaded|fade|in|out|collapsed|expanded|item-\d+|col-\d+|row-\d+|post-\d+|type-\w+|status-\w+|format-\w+|category-[\w-]+|tag-[\w-]+|entry)$/i;
const PREFIX_HASH = /^_?([A-Za-z0-9]{5,8})_([A-Za-z][\w-]{2,})$/;
const HASHY = /^(.+?)(__|--|_|-)([A-Za-z0-9]{4,10})$/;
const SAFE_TOKEN = /^[\p{L}\p{N}_.-]+$/u;

function isHash(h: string): boolean {
  return (/\d/.test(h) && /[A-Za-z]/.test(h)) || (/[a-z]/.test(h) && /[A-Z]/.test(h) && h.length >= 5);
}

/** A class that names what an element is ("stable"), one whose stable part does ("stem": the rest is a build hash), or neither. */
export function tokenKind(tok: string): { kind: "stable" | "stem"; v: string } | null {
  if (!tok || tok.includes(":") || tok.includes("[") || tok.includes("/") || !SAFE_TOKEN.test(tok)) return null;
  if (/^(?:css|sc|jsx|emotion|svelte|astro|styled|chakra|mui|Mui|makeStyles)-[\w-]*$/.test(tok) || /^_[a-z0-9]{5,}$/.test(tok)) return null;
  if (UTILITY.test(tok) || STATE.test(tok)) return null;
  if (/^[A-Za-z0-9]{6,12}$/.test(tok) && (tok.match(/\d/g) ?? []).length >= 2 && /[A-Za-z]/.test(tok)) return null;
  let m = PREFIX_HASH.exec(tok);
  if (m && isHash(m[1]!)) return { kind: "stem", v: `_${m[2]}` };
  m = HASHY.exec(tok);
  if (m && isHash(m[3]!) && ["__", "_", "-"].includes(m[2]!)) return m[1]!.length >= 4 ? { kind: "stem", v: m[1]! } : null;
  if (/\d{3,}/.test(tok)) return null;
  return { kind: "stable", v: tok };
}

/** The class tests that could identify this element, in the order its classes are written. */
export function classPreds(n: PNode): Pred[] {
  const out: Pred[] = [];
  const seen = new Set<string>();
  for (const tok of classesOf(n)) {
    const k = tokenKind(tok);
    if (!k) continue;
    const key = `${k.kind}\u0000${k.v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k.kind === "stable" ? { k: "cls", v: k.v } : { k: "clsc", v: k.v });
  }
  return out;
}

export function predKey(p: Pred): string {
  switch (p.k) {
    case "cls": case "clsc": case "idpre": return `${p.k}:${p.v}`;
    case "attr": case "attrc": return `${p.k}:${p.name}:${p.v}`;
    case "has": return `has:${p.name}`;
    case "hasa": return "hasa";
    case "pos": return `pos:${p.n}`;
  }
}

// ---- writing

function predText(p: Pred): string {
  switch (p.k) {
    case "cls": return `contains(concat(' ', normalize-space(@class), ' '), ' ${p.v} ')`;
    case "clsc": return `contains(@class, '${p.v}')`;
    case "attr": return `@${p.name}='${p.v}'`;
    case "has": return `@${p.name}`;
    case "attrc": return `contains(@${p.name}, '${p.v}')`;
    case "idpre": return `starts-with(@id, '${p.v}')`;
    case "hasa": return ".//a[@href]";
    case "pos": return String(p.n);
  }
}

const AXIS_WORD: Record<Axis, string> = { child: "", desc: "", psib: "preceding-sibling::", fsib: "following-sibling::", prec: "preceding::" };

function stepText(s: Step): string {
  return AXIS_WORD[s.axis] + s.tag + s.preds.map((p) => `[${predText(p)}]`).join("");
}

function pathText(p: PathExpr): string {
  let out = "";
  p.steps.forEach((s, i) => {
    const sep = s.axis === "desc" ? "//" : "/";
    if (i > 0) out += sep;
    else if (p.root) out += sep;
    else out += s.axis === "desc" ? ".//" : s.axis === "child" ? "./" : "";
    out += stepText(s);
  });
  if (!p.steps.length) out = ".";
  if (p.nth !== undefined) out = `(${out})[${p.nth}]`;
  return p.attr ? `${out}/@${p.attr}` : out;
}

export function toXPath(e: Expr): string {
  if (e.kind === "union") return e.parts.map(pathText).join(" | ");
  if (e.kind === "concat") return `concat('${e.literal}', ./@${e.attr})`;
  return pathText(e);
}

// ---- reading

class Refuse extends Error {
  readonly reason: RecipeRefusal;
  constructor(reason: RecipeRefusal) {
    super(reason);
    this.reason = reason;
  }
}

class Reader {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  eat(t: string): boolean {
    if (!this.s.startsWith(t, this.i)) return false;
    this.i += t.length;
    return true;
  }
  look(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }
  done(): boolean {
    return this.i >= this.s.length;
  }
  name(pattern: RegExp): string | null {
    pattern.lastIndex = this.i;
    const m = pattern.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  int(): number | null {
    const d = this.name(/\d{1,5}/y);
    if (d === null) return null;
    const n = Number(d);
    if (n < 1 || n > MAX_POSITION) throw new Refuse("syntax");
    return n;
  }
  /** A single-quoted string. Anything that could carry code or surprise a bridge is refused, not skipped. */
  literal(charset: RegExp): string {
    if (!this.eat("'")) throw new Refuse("syntax");
    const end = this.s.indexOf("'", this.i);
    if (end < 0) throw new Refuse("syntax");
    const v = this.s.slice(this.i, end);
    if (v.length > MAX_LITERAL || !charset.test(v)) throw new Refuse("badLiteral");
    this.i = end + 1;
    return v;
  }
}

const TAG = /[a-z][a-z0-9-]*/y;
const ATTR = /[a-z][a-z0-9_-]*/y;
const TOKEN_CHARS = /^[\p{L}\p{N}_.-]+$/u;
const VALUE_CHARS = /^[\p{L}\p{N}_./-]+$/u;
const URL_CHARS = /^[\x21\x23\x25-\x26\x28-\x7e]*$/;

function readPred(r: Reader): Pred {
  let p: Pred;
  if (r.eat(".//a[@href]")) p = { k: "hasa" };
  else if (r.eat("contains(concat(' ', normalize-space(@class), ' '), ")) {
    const lit = r.literal(/^ [\p{L}\p{N}_.-]+ $/u);
    if (!r.eat(")")) throw new Refuse("syntax");
    p = { k: "cls", v: lit.slice(1, -1) };
  } else if (r.eat("contains(@")) {
    const name = r.name(ATTR);
    if (name === null || !r.eat(", ")) throw new Refuse("syntax");
    const v = r.literal(name === "class" ? TOKEN_CHARS : VALUE_CHARS);
    if (!r.eat(")")) throw new Refuse("syntax");
    p = name === "class" ? { k: "clsc", v } : { k: "attrc", name, v };
  } else if (r.eat("starts-with(@id, ")) {
    const v = r.literal(TOKEN_CHARS);
    if (!r.eat(")")) throw new Refuse("syntax");
    p = { k: "idpre", v };
  } else if (r.eat("@")) {
    const name = r.name(ATTR);
    if (name === null) throw new Refuse("syntax");
    p = r.eat("=") ? { k: "attr", name, v: r.literal(TOKEN_CHARS) } : { k: "has", name };
  } else {
    const n = r.int();
    if (n === null) throw new Refuse("syntax");
    p = { k: "pos", n };
  }
  return p;
}

function readStep(r: Reader, axis: Axis): Step {
  const star = axis === "psib" || axis === "fsib" ? r.eat("*") : false;
  const tag = star ? "*" : r.name(TAG);
  if (tag === null) throw new Refuse("syntax");
  const preds: Pred[] = [];
  while (r.eat("[")) {
    if (preds.length >= MAX_PREDS) throw new Refuse("tooDeep");
    preds.push(readPred(r));
    if (!r.eat("]")) throw new Refuse("syntax");
  }
  return { axis, tag, preds };
}

const AXIS_STARTS: [string, Axis][] = [["preceding-sibling::", "psib"], ["following-sibling::", "fsib"], ["preceding::", "prec"]];

function readSteps(r: Reader, steps: Step[], first: Step | null): void {
  if (first) steps.push(first);
  for (;;) {
    let axis: Axis;
    if (r.look("//")) {
      r.i += 2;
      axis = "desc";
    } else if (r.look("/") && !r.look("/@")) {
      r.i += 1;
      axis = "child";
    } else return;
    if (steps.length >= MAX_STEPS) throw new Refuse("tooDeep");
    steps.push(readStep(r, axis));
  }
}

function readPath(r: Reader, root: boolean): PathExpr {
  const steps: Step[] = [];
  if (root) {
    if (r.eat("//")) readSteps(r, steps, readStep(r, "desc"));
    else if (r.look("/") && !r.look("/@")) {
      r.i += 1;
      readSteps(r, steps, readStep(r, "child"));
    } else throw new Refuse("syntax");
    return { kind: "path", root: true, steps };
  }
  const paren = r.eat("(");
  let first: Step | null = null;
  const axisStart = AXIS_STARTS.find(([w]) => r.look(w));
  if (axisStart) {
    r.i += axisStart[0].length;
    first = readStep(r, axisStart[1]);
  } else if (!r.eat(".")) throw new Refuse("syntax");
  else if (r.look("//")) {
    r.i += 2;
    first = readStep(r, "desc");
  } else if (r.look("/") && !r.look("/@")) {
    r.i += 1;
    first = readStep(r, "child");
  }
  readSteps(r, steps, first);
  const out: PathExpr = { kind: "path", root: false, steps };
  if (paren) {
    if (!r.eat(")") || !r.eat("[")) throw new Refuse("syntax");
    const n = r.int();
    if (n === null || !r.eat("]")) throw new Refuse("syntax");
    out.nth = n;
  }
  if (r.eat("/@")) {
    const name = r.name(ATTR);
    if (name === null) throw new Refuse("syntax");
    out.attr = name;
  }
  return out;
}

function checkStructure(p: PathExpr): void {
  if (p.steps.length > MAX_STEPS) throw new Refuse("tooDeep");
  p.steps.forEach((s, i) => {
    if (s.tag === "*" && !(s.axis === "psib" || s.axis === "fsib")) throw new Refuse("wrongForm");
    if ((s.axis === "psib" || s.axis === "fsib" || s.axis === "prec") && (p.root || i > 0)) throw new Refuse("wrongForm");
    const pos = s.preds.filter((x) => x.k === "pos");
    if (pos.length > 1 || s.preds.filter((x) => x.k === "hasa").length > 1) throw new Refuse("wrongForm");
    if (pos.length && s.axis === "desc") throw new Refuse("wrongForm");
    if (pos.length && s.preds[s.preds.length - 1]!.k !== "pos") throw new Refuse("wrongForm");
    if ((s.axis === "psib" || s.axis === "fsib") && (s.tag !== "*" || s.preds.length !== 1 || pos[0]!.k !== "pos" || pos[0]!.n !== 1)) throw new Refuse("wrongForm");
    if (s.axis === "prec" && !pos.length) throw new Refuse("wrongForm");
  });
  if (p.root) {
    // Absolute paths are either //tag... or the positional /html/body/...
    const first = p.steps[0]!;
    if (first.axis === "child" && (p.steps.length < 3 || first.tag !== "html" || p.steps[1]!.tag !== "body" || p.steps[1]!.axis !== "child" || first.preds.length || p.steps[1]!.preds.length)) throw new Refuse("wrongForm");
    if (p.attr !== undefined || p.nth !== undefined) throw new Refuse("wrongForm");
  }
}

/** Reads one recipe expression, or throws why it is refused. */
function readExpr(text: string, field: RecipeField): Expr {
  if (text.length > MAX_EXPRESSION_LENGTH) throw new Refuse("tooLong");
  if (/document\s*\(|\$|php:|[\u0000-\u001f\u007f]/i.test(text)) throw new Refuse("forbidden");
  const r = new Reader(text);
  let e: Expr;
  if (field === "item") {
    const parts: PathExpr[] = [readPath(r, true)];
    while (r.eat(" | ")) {
      if (parts.length >= MAX_UNION) throw new Refuse("tooMany");
      parts.push(readPath(r, true));
    }
    e = parts.length === 1 ? parts[0]! : { kind: "union", parts };
  } else if (field === "link" && r.look("concat(")) {
    r.i += "concat(".length;
    const literal = r.literal(URL_CHARS);
    if (!r.eat(", ./@")) throw new Refuse("syntax");
    const a = r.name(ATTR);
    if (a === null || !r.eat(")")) throw new Refuse("syntax");
    e = { kind: "concat", literal, attr: a };
  } else e = readPath(r, false);
  if (!r.done()) throw new Refuse("syntax");
  if (e.kind === "path") checkStructure(e);
  else if (e.kind === "union") e.parts.forEach(checkStructure);
  return e;
}

export function parseExpr(text: string, field: RecipeField): Expr | null {
  try {
    return readExpr(text, field);
  } catch (error) {
    if (error instanceof Refuse) return null;
    throw error;
  }
}

/**
 * Whether a stored recipe stays inside the grammar above. `item` is absolute; `title`, `link` and `date` are
 * relative to the item; every expression is at most 200 characters. It names the first refusal; nothing else
 * (no extension function, no `document()`, no variable, no other axis) is accepted.
 */
export function validateRecipe(recipe: unknown): RecipeCheck {
  if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) return { ok: false, field: null, reason: "shape" };
  const r = recipe as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!["item", "title", "link", "date"].includes(key)) return { ok: false, field: null, reason: "shape" };
  for (const field of ["item", "title", "link", "date"] as const) {
    const v = r[field];
    if (v === undefined && field === "date") continue;
    if (typeof v !== "string" || !v) return { ok: false, field, reason: "shape" };
    try {
      readExpr(v, field);
    } catch (error) {
      if (error instanceof Refuse) return { ok: false, field, reason: error.reason };
      throw error;
    }
  }
  return { ok: true };
}

// ---- evaluating

function nameOk(n: PNode, tag: string): boolean {
  return tag === "*" || n.tag === tag;
}

function predHolds(d: PageDom, n: PNode, p: Pred): boolean {
  switch (p.k) {
    case "cls": return classesOf(n).includes(p.v);
    case "clsc": return (n.attrs.class ?? "").includes(p.v);
    case "attr": return n.attrs[p.name] === p.v;
    case "has": return p.name in n.attrs;
    case "attrc": return (n.attrs[p.name] ?? "").includes(p.v);
    case "idpre": return (n.attrs.id ?? "").startsWith(p.v);
    case "hasa": return hasLinkBelow(d, n);
    case "pos": return true;
  }
}

function lowerBound(list: PNode[], idx: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.idx <= idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nodes a step reaches from one context node, in axis order (nearest first on the reverse axes), before any position. */
function reach(d: PageDom, c: PNode, s: Step): PNode[] {
  switch (s.axis) {
    case "child":
      spend(d, c.children.length);
      return c.children.filter((x) => nameOk(x, s.tag));
    case "desc": {
      const pool = s.tag === "*" ? d.all : (d.byTag.get(s.tag) ?? []);
      const out: PNode[] = [];
      for (let i = lowerBound(pool, c.idx); i < pool.length && pool[i]!.idx <= c.end; i++) out.push(pool[i]!);
      spend(d, out.length + 1);
      return out;
    }
    case "psib": case "fsib": {
      // Only the nearest sibling is ever asked for (`*[1]`, checked when a recipe is read).
      const near = c.parent?.children[s.axis === "psib" ? c.sib - 1 : c.sib + 1];
      return near ? [near] : [];
    }
    case "prec": {
      const out: PNode[] = [];
      const want = s.preds.find((p) => p.k === "pos");
      const tests = s.preds.filter((p) => p.k !== "pos");
      for (let j = c.idx - 1; j >= 0; j--) {
        const x = d.all[j]!;
        spend(d, 1);
        if (x.end >= c.idx || !nameOk(x, s.tag) || !tests.every((p) => predHolds(d, x, p))) continue;
        out.push(x);
        if (want && want.k === "pos" && out.length >= want.n) break;
      }
      return out;
    }
  }
}

function applyStep(d: PageDom, ctx: PNode[], s: Step): PNode[] {
  const one = ctx.length === 1 && s.axis !== "prec" && s.axis !== "psib";
  const seen = new Set<PNode>();
  const out: PNode[] = [];
  for (const c of ctx) {
    let list = reach(d, c, s);
    for (const p of s.preds) list = p.k === "pos" ? (list[p.n - 1] ? [list[p.n - 1]!] : []) : list.filter((x) => predHolds(d, x, p));
    // From one context node these steps already give nodes in document order, each once.
    if (one) return list;
    for (const x of list) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
  }
  return out.sort((a, b) => a.idx - b.idx);
}

function stepKey(s: Step): string {
  return `${s.axis}|${s.tag}|${s.preds.map(predKey).join("&")}`;
}

/** Selections from the document node by their leading steps, so a longer expression only evaluates its last steps. */
const rootSelections = new WeakMap<PageDom, Map<string, PNode[]>>();
const MAX_CACHED_SELECTIONS = 4000;

function selectFromRoot(d: PageDom, steps: Step[]): PNode[] {
  let cache = rootSelections.get(d);
  if (!cache || cache.size > MAX_CACHED_SELECTIONS) {
    cache = new Map();
    rootSelections.set(d, cache);
  }
  const keys: string[] = [];
  steps.forEach((s, i) => keys.push(`${i ? keys[i - 1] : ""}/${stepKey(s)}`));
  let k = steps.length;
  let cur: PNode[] | undefined;
  while (k > 0 && !(cur = cache.get(keys[k - 1]!))) k--;
  if (!cur) {
    cur = [d.root];
    k = 0;
  }
  for (let i = k; i < steps.length; i++) {
    cur = applyStep(d, cur, steps[i]!);
    cache.set(keys[i]!, cur);
  }
  return cur;
}

function selectPath(d: PageDom, p: PathExpr, ctx: PNode[]): PNode[] {
  let steps = p.steps;
  let cur: PNode[];
  if (p.root) {
    // The tree has no <html> or <body> element of its own; /html/body/ names the document node.
    if (steps[0]?.axis === "child" && steps[0].tag === "html") steps = steps.slice(2);
    cur = selectFromRoot(d, steps);
  } else {
    cur = ctx;
    for (const s of steps) cur = applyStep(d, cur, s);
  }
  if (p.nth !== undefined) return cur[p.nth - 1] ? [cur[p.nth - 1]!] : [];
  return cur;
}

/** The nodes an `item` expression selects from the document, in document order. */
export function selectItems(d: PageDom, e: Expr): PNode[] {
  if (e.kind === "concat") return [];
  const parts = e.kind === "union" ? e.parts : [e];
  const seen = new Set<PNode>();
  for (const p of parts) for (const n of selectPath(d, p, [])) seen.add(n);
  return [...seen].sort((a, b) => a.idx - b.idx);
}

/** The nodes a relative expression selects from an item (the elements only, never the attribute). */
export function selectFrom(d: PageDom, e: Expr, item: PNode): PNode[] {
  return e.kind === "path" ? selectPath(d, e, [item]) : [];
}

/**
 * What the bridge reads from an item: the first selected attribute, else the first selected element's text
 * (not collapsed), trimmed; `null` when nothing is selected. A concat gives the literal and the item's attribute.
 */
export function evaluateField(d: PageDom, e: Expr, item: PNode): string | null {
  if (e.kind === "concat") return `${e.literal}${attr(item, e.attr)}`;
  if (e.kind !== "path") return null;
  const nodes = selectPath(d, e, [item]);
  if (e.attr !== undefined) {
    const hit = nodes.find((n) => e.attr! in n.attrs);
    return hit ? hit.attrs[e.attr]!.trim() : null;
  }
  const first = nodes[0];
  return first ? d.full.slice(d.off[first.t0], d.off[first.t1]).trim() : null;
}
