/*
 * Finds the repeating list of posts on a page that has no feed (a blog index, a news section, a changelog, a job
 * board) and describes it as a data-only recipe: XPath 1.0 expressions an RSS-Bridge XPathBridge can run. It reads
 * the page's own structure and nothing else: no network, no script, no fetching.
 *
 * The page is read as structured data first (JSON-LD, microformats, microdata) and as repeated links. Each group of
 * links that sit in the same kind of place becomes a list: its items are the largest elements that hold only one of
 * the links, at one height; titles, links and dates are read inside each item, and a recipe is generated and checked
 * against the tree. Up to three lists are scored and returned; a clearly best first one is marked `high`.
 */
import { classesOf, contains, descendantsOf, norm, textOf } from "./page-dom.ts";
import type { PNode } from "./page-dom.ts";
import { PageContext, canonicalUrl, mostCommon, wordCount } from "./page-context.ts";
import { isStrictIsoDate, strtotimeReadsAs } from "./page-dates.ts";
import type { DatePrecision, ParsedDate } from "./page-dates.ts";
import { BAD_ANCHOR_TEXT, HEADS, bestAnchor, dateNodesIn, dateWithTextIn, isHeading, pickTitleNode, semanticHints } from "./page-fields.ts";
import type { DateHit } from "./page-fields.ts";
import { generateItems, generateRelative, relExpr } from "./page-recipes.ts";
import { classPreds, evaluateField, selectFrom, selectItems, toXPath, validateRecipe } from "./page-xpath.ts";
import type { Expr, PageListRecipe, PathExpr, Step } from "./page-xpath.ts";
import { TooComplexError } from "./text.ts";

export { validateRecipe };
export type { PageListRecipe, RecipeCheck, RecipeRefusal } from "./page-xpath.ts";

export type PageListConfidence = "high" | "medium" | "low";

/** Why a list was chosen or doubted. Codes only; the words belong to the translation files. */
export type PageListReason =
  | "dated" | "undated" | "inMain" | "headingTitles" | "slugUrls" | "sharedUrlPattern"
  | "inNav" | "inFooter" | "inSidebar" | "inChrome"
  | "brittle" | "approximate" | "incomplete"
  | "facetTitles" | "metaTitles" | "queryOnlyLinks"
  | "microformats" | "microdata" | "structuredData" | "dataOnly" | "changelog";

/** What is wrong with a page that gave no list, or only weak ones. */
export type PageListDiagnosis = "appShell" | "emptyMain" | "noRepeatedLinks" | "notHtml" | "tooLarge" | "tooComplex";

export type PageListSample = {
  title: string;
  /** The address the item points at (resolved against the page). */
  url: string;
  /** The item's stable identity: its canonical address (https, no `www.`, no tracking parameters). */
  id: string;
  /** The date as this detector reads it: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` or `YYYY-MM`; null when the item shows none. */
  date: string | null;
  datePrecision: DatePrecision | null;
};

export type PageListCandidate = {
  rank: number;
  score: number;
  confidence: PageListConfidence;
  reasons: PageListReason[];
  /** The XPath recipe; null when the list cannot be expressed as one (`portable` is false). `item` is absolute; the rest are relative to the item. */
  recipe: PageListRecipe | null;
  /** Whether the recipe carries the dates in `samples`. When it does not, the feed dates posts by when they were first seen. */
  datesInRecipe: boolean;
  /** How many distinct items the recipe yields from the page (what the bridge will put in the feed). */
  itemCount: number;
  /** The first of them, dated as this detector reads their dates (the recipe may carry fewer, see `datesInRecipe`). */
  samples: PageListSample[];
  portable: boolean;
};

export type PageListResult = {
  candidates: PageListCandidate[];
  /** Set when there is no candidate, or none better than `low`. */
  diagnosis: PageListDiagnosis | null;
};

/** Pages bigger than this are refused (discovery reads at most this much). */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ANCHORS = 20_000;
const MAX_ANALYSED = 30;
const SAMPLE_COUNT = 8;

// ---- internal candidate

type Row = { title: string; url: string; id: string; date: string | null; datePrecision: DatePrecision | null };

type Cand = {
  items: PNode[];
  anchors: (PNode | null)[];
  rows: Row[];
  urls: string[];
  titleNodes: (PNode | null)[];
  source: "dom" | "heading-sections" | "microformats" | "microdata";
  recipe: { item: Expr; title: Expr | null; link: Expr | null; date: Expr | null } | null;
  exact: boolean;
  near: number;
  dateCoverage: number;
  /** Whether the recipe's date expression is one PHP's strtotime reads as the date shown. */
  datesCarried: boolean;
  brittle: boolean;
  score: number;
  why: PageListReason[];
  portable: boolean;
};

type Structured = { kind: string; urls: Set<string>; items: { title: string; url: string; date: string | null }[] };

// ---- structured data

type Json = unknown;
const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting", "Event", "JobPosting", "Report"]);

function asList(x: Json): Json[] {
  return Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];
}

function typesOf(x: Record<string, Json>): string[] {
  return asList(x["@type"]).map(String);
}

function isObject(x: Json): x is Record<string, Json> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function ldNodes(blocks: string[]): Record<string, Json>[] {
  const out: Record<string, Json>[] = [];
  const stack: Json[] = [];
  const parse = (b: string): Json | undefined => {
    try {
      return JSON.parse(b);
    } catch {
      try {
        return JSON.parse(b.replace(/\/\*[\s\S]*?\*\//g, ""));
      } catch {
        return undefined;
      }
    }
  };
  let budget = 0;
  for (const raw of blocks) {
    if ((budget += raw.length) > MAX_PAGE_BYTES / 2) break;
    const v = parse(raw.trim());
    if (v !== undefined) stack.push(v);
  }
  let visited = 0;
  while (stack.length && visited++ < 50_000) {
    const x = stack.pop()!;
    if (Array.isArray(x)) for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
    else if (isObject(x)) {
      out.push(x);
      if ("@graph" in x) stack.push(x["@graph"]);
    }
  }
  return out;
}

function ldItem(e: Json, base: string): { title: string; url: string; date: string | null } | null {
  if (!isObject(e)) return null;
  const inner = isObject(e.item) ? e.item : e;
  let url = inner.url ?? inner["@id"] ?? e.url;
  if (isObject(url)) url = url["@id"] ?? url.url;
  if (typeof url !== "string" || !url) return null;
  const title = inner.headline ?? inner.name ?? e.name;
  const date = inner.datePublished ?? inner.startDate ?? inner.dateCreated ?? inner.dateModified;
  let abs: string;
  try {
    abs = new URL(url, base).href;
  } catch {
    return null;
  }
  return { title: String(title ?? "").replace(/\s+/g, " ").trim(), url: abs, date: date ? String(date) : null };
}

function structuredLists(ctx: PageContext): Structured[] {
  const nodes = ldNodes(ctx.doc.jsonld);
  const found: { kind: string; items: NonNullable<ReturnType<typeof ldItem>>[] }[] = [];
  const take = (kind: string, list: Json[]) => {
    const items = list.map((e) => ldItem(e, ctx.base)).filter((i): i is NonNullable<typeof i> => i !== null);
    if (items.length >= 3) found.push({ kind, items });
  };
  for (const n of nodes) {
    if (typesOf(n).includes("ItemList") && n.itemListElement) take("ItemList", asList(n.itemListElement));
    if (n.blogPost) take("blogPost", asList(n.blogPost));
    for (const key of ["hasPart", "mainEntity"]) {
      const v = n[key];
      if (Array.isArray(v) && v.length >= 3) take(key, v.filter((e) => isObject(e) && typesOf(e).some((t) => ARTICLE_TYPES.has(t))));
    }
  }
  const arts = nodes.filter((n) => typesOf(n).some((t) => ARTICLE_TYPES.has(t)) && n.url);
  if (arts.length >= 3) take("article-array", arts);
  return found.map((f) => ({ kind: `JSON-LD ${f.kind}`, urls: new Set(f.items.map((i) => canonicalUrl(i.url))), items: f.items }));
}

// ---- grouping links into items

const ANCHOR_SKIP_ROOT = new Set(["body", "html", "#root"]);

/** Links grouped by the (tag, class) path above them; `coarse` keeps classes only on the two nearest levels. */
function anchorGroups(ctx: PageContext, coarse: boolean): Map<string, PNode[]> {
  const groups = new Map<string, PNode[]>();
  const partCache = new Map<PNode, string>();
  const tagPath = new Map<PNode, string>();
  const part = (x: PNode) => {
    let p = partCache.get(x);
    if (p === undefined) {
      p = `${x.tag}\u0001${[...new Set(classPreds(x).map((q) => (q as { v: string }).v).filter((v) => !v.includes("--")))].sort().join("\u0002")}`;
      partCache.set(x, p);
    }
    return p;
  };
  const tags = (x: PNode | null): string => {
    if (!x || x.tag === "#root") return "";
    let p = tagPath.get(x);
    if (p === undefined) {
      p = `${tags(x.parent)}\u0003${x.tag}\u0001`;
      tagPath.set(x, p);
    }
    return p;
  };
  const fine = new Map<PNode, string>();
  const fineKey = (x: PNode | null): string => {
    if (!x || x.tag === "#root") return "";
    let k = fine.get(x);
    if (k === undefined) {
      k = `${fineKey(x.parent)}\u0003${part(x)}`;
      fine.set(x, k);
    }
    return k;
  };
  for (const a of ctx.anchors.slice(0, MAX_ANCHORS)) {
    const key = coarse ? `${tags(a.parent?.parent ?? null)}\u0003${a.parent && a.parent.tag !== "#root" ? part(a.parent) : ""}\u0003${part(a)}` : fineKey(a);
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  return groups;
}

function urlTemplate(u: string): string {
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return u;
  }
  const segs = p.pathname.replace(/\d+(?:[._-]\d+)*/g, "#").split("/");
  const last = segs[segs.length - 1]!;
  if (/[A-Za-z0-9]+-[A-Za-z0-9]+-/.test(last) || (/[A-Za-z]-[A-Za-z]/.test(last) && last.length > 18)) segs[segs.length - 1] = "<slug>";
  const q = p.search ? `?${p.search.slice(1).split("&").map((k) => k.split("=")[0]).sort().join(",")}` : "";
  return `${p.hostname}\u0000${segs.join("/")}\u0000${q}`;
}

function templateGroups(ctx: PageContext): PNode[][] {
  const groups = new Map<string, PNode[]>();
  for (const a of ctx.anchors.slice(0, MAX_ANCHORS)) {
    if (!ctx.text(a)) continue;
    const k = urlTemplate(ctx.abs(a));
    const g = groups.get(k);
    if (g) g.push(a);
    else groups.set(k, [a]);
  }
  const out: PNode[][] = [];
  for (const members of groups.values()) {
    const seen = new Set<string>();
    const ded = members.filter((a) => {
      const u = canonicalUrl(ctx.abs(a));
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    if (ded.length >= 6 && ded.length >= 0.7 * members.length) out.push(ded);
  }
  return out;
}

function lowerBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The items a group of links stands for: per link, the outermost ancestor that holds that link alone, at one height. */
function itemsFromGroup(ctx: PageContext, members: PNode[]): { items: PNode[]; anchors: PNode[]; dups: PNode[] } | null {
  const seen = new Set<string>();
  const ded = members.filter((a) => {
    const u = canonicalUrl(ctx.abs(a));
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
  if (ded.length < 3 || ded.length < 0.5 * members.length) return null;
  const idxs = ded.map((a) => a.idx).sort((a, b) => a - b);
  const countIn = (el: PNode) => lowerBound(idxs, el.end + 1) - lowerBound(idxs, el.idx);
  const heights = ded.map((a) => {
    let x = a;
    let h = 0;
    while (x.parent && !ANCHOR_SKIP_ROOT.has(x.parent.tag) && countIn(x.parent) === 1) {
      x = x.parent;
      h++;
    }
    return h;
  });
  const hm = mostCommon(heights)!.value;
  const its: PNode[] = [];
  const ans: PNode[] = [];
  ded.forEach((a, i) => {
    if (heights[i]! < hm) return;
    let x = a;
    for (let k = 0; k < hm; k++) x = x.parent!;
    its.push(x);
    ans.push(a);
  });
  if (its.length < 3 || new Set(its).size !== its.length) return null;
  const tag = mostCommon(its.map((x) => x.tag))!.value;
  const keep = its.map((x, i) => [x, ans[i]!] as const).filter(([x]) => x.tag === tag);
  if (keep.length < 3 || keep.length < 0.85 * its.length) return null;
  const dedSet = new Set(ded);
  const keptItems = new Set(keep.map(([x]) => x));
  const dups = new Set<PNode>();
  for (const a of members) {
    if (dedSet.has(a)) continue;
    let x = a;
    for (let k = 0; k < hm; k++) x = x.parent ?? x;
    if (x.tag === tag && !keptItems.has(x)) dups.add(x);
  }
  return { items: keep.map(([x]) => x), anchors: keep.map(([, a]) => a), dups: [...dups] };
}

// ---- one candidate

function dateKey(h: DateHit): string {
  return `${h.how}\u0000${h.attr ?? ""}\u0000${h.node.tag}`;
}

type DatePlan = { region: "inside" | "preceding-sibling" | "following-sibling" | "preceding"; nodes: (DateHit | null)[]; attr: string | null; sibs?: (PNode | null)[] };

function planDates(ctx: PageContext, items: PNode[]): DatePlan | null {
  const n = items.length;
  const inside = items.map((it) => {
    const d = dateNodesIn(ctx, it);
    return d.length ? d : dateWithTextIn(ctx, it);
  });
  /** Keep the dominant kind of date node (how it was found, which attribute, which tag) and take the first of that kind per item. */
  const pickKind = (hits: DateHit[][]) => {
    const kind = mostCommon(hits.filter((d) => d.length).map((d) => dateKey(d[0]!)))!.value;
    return { nodes: hits.map((d) => d.find((x) => dateKey(x) === kind) ?? null), attr: kind.split("\u0000")[1] || null };
  };
  if (inside.filter((d) => d.length).length / n >= 0.5) return { region: "inside", ...pickKind(inside) };
  for (const side of ["preceding-sibling", "following-sibling"] as const) {
    const sibs = items.map((it) => it.parent?.children[side === "preceding-sibling" ? it.sib - 1 : it.sib + 1] ?? null);
    const found = sibs.map((sib) => (sib ? dateNodesIn(ctx, sib) : []));
    const have = found.filter((d) => d.length);
    const distinct = new Set(have.map((d) => d[0]!.node)).size / Math.max(1, have.length);
    if (have.length / n >= 0.6 && distinct > 0.9) return { region: side, ...pickKind(found), sibs };
  }
  // The nearest date heading above (a list grouped by day).
  const found: (DateHit | null)[] = items.map((it) => {
    for (let x = it.idx - 1; x >= 0 && it.idx - x < 400; x--) {
      const m = ctx.doc.all[x]!;
      if (contains(m, it)) continue;
      if (HEADS.includes(m.tag) || m.tag === "time" || m.tag === "dt" || m.tag === "th") {
        const d = dateNodesIn(ctx, m);
        if (d.length) return d[0]!;
      }
    }
    return null;
  });
  const have = found.filter((d): d is DateHit => d !== null);
  if (have.length / n >= 0.8 && new Set(have.map((d) => d.node)).size >= 2) {
    const kind = mostCommon(have.map(dateKey))!.value;
    return { region: "preceding", nodes: found, attr: kind.split("\u0000")[1] || null };
  }
  return null;
}

type DateRecipe = { path: PathExpr; coverage: number };

function dateRecipe(ctx: PageContext, items: PNode[], plan: DatePlan): DateRecipe | null {
  const d = ctx.doc;
  const n = items.length;
  const attr = plan.attr ?? undefined;
  const els = plan.nodes.map((x) => x?.node ?? null);
  if (plan.region === "inside") {
    const r = generateRelative(d, items, els, 0.8);
    return r.path ? { path: relExpr(r.path, attr), coverage: r.coverage } : null;
  }
  if (plan.region === "preceding-sibling" || plan.region === "following-sibling") {
    const r = generateRelative(d, plan.sibs!, els, 0.8);
    if (!r.path) return null;
    const lead: Step = { axis: plan.region === "preceding-sibling" ? "psib" : "fsib", tag: "*", preds: [{ k: "pos", n: 1 }] };
    return { path: relExpr(r.path, attr, [lead]), coverage: r.coverage };
  }
  const tags = mostCommon(plan.nodes.filter((x): x is DateHit => x !== null).map((x) => `${x.node.tag}\u0000${classPreds(x.node).slice(0, 1).map((p) => JSON.stringify(p)).join("")}`))!.value;
  const [tag, pred] = tags.split("\u0000") as [string, string];
  const preds: Step["preds"] = pred ? [JSON.parse(pred) as Step["preds"][number]] : [];
  const p: PathExpr = { kind: "path", root: false, steps: [{ axis: "prec", tag, preds: [...preds, { k: "pos", n: 1 }] }] };
  if (attr) p.attr = attr;
  let ok = 0;
  items.forEach((it, i) => {
    const want = plan.nodes[i]?.node;
    const got = selectFrom(d, p, it)[0];
    if (want && got && (got === want || contains(want, got))) ok++;
  });
  return ok / n >= 0.8 ? { path: p, coverage: ok / n } : null;
}

/** Whether PHP's strtotime reads the date a recipe would select the way the detector does, for nearly every item that has one. */
function carriesDates(ctx: PageContext, plan: DatePlan): boolean {
  let total = 0;
  let good = 0;
  for (const h of plan.nodes) {
    if (!h) continue;
    total++;
    if (h.attr) {
      if (h.parsed.kind === "absolute" && isStrictIsoDate(h.node.attrs[h.attr] ?? "")) good++;
    } else {
      const raw = ctx.doc.full.slice(ctx.doc.off[h.node.t0], ctx.doc.off[h.node.t1]).trim();
      if (strtotimeReadsAs(raw, ctx.date(raw))) good++;
    }
  }
  return total > 0 && good >= 0.9 * total;
}

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function literalSafe(s: string): string {
  return s.replace(/'/g, "%27").replace(/\$/g, "%24").replace(/"/g, "%22").replace(/\\/g, "%5C").replace(/ /g, "%20");
}

function analyze(ctx: PageContext, items: PNode[], anchorsIn: (PNode | null)[], source: Cand["source"], opts: { hint?: boolean; heading?: boolean; dups?: PNode[] } = {}): Cand | null {
  const n = items.length;
  const heading = opts.heading === true;
  const anchors = heading ? anchorsIn : items.map((it, i) => bestAnchor(ctx, it, anchorsIn[i] ?? null));
  const page = pageKey(ctx.url);
  const urls = heading ? items.map((it) => `${canonicalUrl(ctx.url)}#${it.attrs.id}`) : anchors.map((a) => canonicalUrl(ctx.abs(a!)));
  const titleNodes: (PNode | null)[] = [];
  const preNodes: (PNode | null)[] = [];
  items.forEach((it, i) => {
    const hint = opts.hint ? semanticHints(ctx, it) : {};
    if (hint.title) {
      titleNodes.push(hint.title);
      preNodes.push(hint.title);
    } else if (heading) {
      titleNodes.push(it);
      preNodes.push(it);
    } else {
      const t = pickTitleNode(ctx, it, anchors[i] ?? null);
      titleNodes.push(t.node);
      preNodes.push(t.before);
    }
  });
  let titles = titleNodes.map((t) => (t ? ctx.text(t) : ""));

  // The recipe.
  const dups = opts.dups ?? [];
  const itemRes = generateItems(ctx.doc, [...items, ...dups]);
  if (!itemRes) return null;
  let link: Expr | null;
  if (heading) link = { kind: "concat", literal: `${literalSafe(page)}#`, attr: "id" };
  else {
    const l = generateRelative(ctx.doc, items, anchors);
    link = l.path ? relExpr(l.path, "href") : null;
  }
  let t = generateRelative(ctx.doc, items, titleNodes);
  if (t.coverage < 0.9 && titleNodes.some((x, i) => x !== preNodes[i])) {
    const t2 = generateRelative(ctx.doc, items, preNodes);
    if (t2.coverage > t.coverage) {
      t = t2;
      titles = preNodes.map((x) => (x ? ctx.text(x) : ""));
    }
  }
  const title: Expr | null = t.path ? relExpr(t.path) : null;
  let brittle = itemRes.brittle || (t.path?.brittle ?? false) || (link?.kind === "path" && link.nth !== undefined);

  // Dates.
  const plan = planDates(ctx, items);
  let dateExpr: Expr | null = null;
  let parsed: (ParsedDate | null)[] = items.map(() => null);
  let carried = false;
  if (plan) {
    const dr = dateRecipe(ctx, items, plan);
    if (dr) {
      parsed = plan.nodes.map((x) => x?.parsed ?? null);
      if (carriesDates(ctx, plan)) {
        dateExpr = dr.path;
        carried = true;
        if (dr.path.nth !== undefined) brittle = true;
      }
    }
  }
  const dateCoverage = parsed.filter((p) => p).length / n;
  const rows: Row[] = items.map((it, i) => ({
    title: titles[i]!,
    url: heading ? `${page}#${it.attrs.id}` : ctx.abs(anchors[i]!),
    id: urls[i]!,
    date: parsed[i]?.iso ?? null,
    datePrecision: parsed[i]?.precision ?? null,
  }));
  const total = n + dups.length;
  return {
    items, anchors, rows, urls, titleNodes, source,
    recipe: { item: itemRes.expr, title, link, date: dateExpr },
    exact: itemRes.exact,
    near: total / Math.max(total, itemRes.selected || n),
    dateCoverage, datesCarried: carried, brittle, score: 0, why: [], portable: true,
  };
}

// ---- scoring

const TAG_FEATURES_FILTER = /\(\d[\d,.]*\)\s*$/;

function score(ctx: PageContext, c: Cand, structured: Structured[], contentAnchors: number): void {
  const { items, rows, urls } = c;
  const n = items.length;
  const why: PageListReason[] = [];
  let s = 2.2 * Math.log(Math.min(n, 40));
  const uniq = new Set(urls).size / n;
  s += 8 * (uniq - 0.85);
  const shapes = new Map<string, number>();
  for (const u of urls) {
    let key: string;
    try {
      const p = new URL(u);
      const segs = p.pathname.split("/").filter(Boolean);
      key = `${p.hostname}\u0000${segs[0] ?? ""}\u0000${Math.min(segs.length, 4)}`;
    } catch {
      key = u;
    }
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  const domShare = Math.max(...shapes.values()) / n;
  s += 5 * (domShare - 0.5);
  if (domShare >= 0.85) why.push("sharedUrlPattern");
  const slug = urls.filter((u) => {
    try {
      return /[^/]*[-_][^/]*[-_][^/]*\/?$|\/\d{4,}/.test(new URL(u).pathname);
    } catch {
      return false;
    }
  }).length / n;
  s += 2.5 * slug;
  if (slug >= 0.6) why.push("slugUrls");
  const tw = rows.map((r) => wordCount(r.title)).sort((a, b) => a - b);
  const med = tw[Math.floor(tw.length / 2)]!;
  if (med < 2) s -= 4;
  else if (med < 3) s -= 1;
  else if (med >= 4) {
    s += 2;
    if (med >= 6) s += 1;
  }
  const titles = rows.map((r) => r.title);
  if (new Set(titles).size / n < 0.8) s -= 3;
  if (titles.filter((t) => TAG_FEATURES_FILTER.test(t)).length >= 0.5 * n) {
    s -= 8;
    why.push("facetTitles");
  }
  if (titles.filter((t) => !t).length > 0.3 * n) s -= 6;
  const metaTitles = titles.filter((t) => t && (ctx.isDateOnly(t) || BAD_ANCHOR_TEXT.test(t) || /^\d+\s*(?:points?|comments?|replies|reacties)\b/i.test(t))).length;
  if (metaTitles > 0.4 * n) {
    s -= 10;
    why.push("metaTitles");
  }
  const queryOnly = c.anchors.filter((a) => a && (a.attrs.href ?? "").trim().startsWith("?")).length / n;
  if (queryOnly > 0.5) {
    s -= 8;
    why.push("queryOnlyLinks");
  }
  const regions = items.map((it) => ctx.region(it));
  const pmax = mostCommon(regions.map((r) => r.penalty))!.value;
  const good = Math.max(...regions.map((r) => r.good));
  s -= pmax;
  s += good;
  if (pmax) why.push(regions[0]!.kind ?? "inChrome");
  else if (good) why.push("inMain");
  const dc = c.dateCoverage;
  s += 6 * dc + (dc >= 0.8 ? 2 : 0);
  if (dc >= 0.6 && c.datesCarried) why.push("dated");
  const heads = c.titleNodes.filter((tn) => {
    for (let x: PNode | null = tn; x && x.tag !== "#root"; x = x.parent) if (isHeading(x)) return true;
    return false;
  }).length / n;
  s += 3 * heads;
  if (heads >= 0.7) why.push("headingTitles");
  const txt = items.map((it) => ctx.text(it).length).sort((a, b) => a - b)[Math.floor(n / 2)]!;
  if (txt < 12) s -= 3;
  else if (txt >= 40) s += 1;
  if (txt >= 200) s += 1;
  s += 4 * Math.min(1, (n / Math.max(1, contentAnchors)) * 1.25);
  if (c.source === "microformats" || c.source === "microdata") {
    s += 3;
    why.push(c.source);
  } else if (c.source === "heading-sections") {
    s -= 1;
    why.push("changelog");
  }
  for (const ss of structured) {
    const inter = new Set(urls.filter((u) => ss.urls.has(u))).size;
    if (inter >= 3 && inter >= 0.6 * Math.min(n, ss.urls.size)) {
      s += 9;
      why.push("structuredData");
      break;
    }
  }
  if (c.recipe && !c.exact) {
    s -= c.near >= 0.95 ? 1 : 4;
    why.push("approximate");
  }
  if (!c.recipe?.title) s -= 5;
  if (!c.recipe?.link) s -= 5;
  if (!c.recipe?.title || !c.recipe?.link) why.push("incomplete");
  if (c.brittle) why.push("brittle");
  if (!c.recipe?.date) why.push("undated");
  c.score = s;
  c.why = why;
}

// ---- the page

function looksLikeHtml(html: string): boolean {
  const head = html.slice(0, 2048);
  if (head.includes("\u0000")) return false;
  const t = head.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return false;
  if (/^<\?xml[^>]*\?>\s*<(?:rss|feed|rdf:rdf|opml)\b/i.test(t) || /^<(?:rss|feed|rdf:rdf|opml)\b/i.test(t)) return false;
  return /<(?:!doctype\s+html|html|head|body|div|a|p|ul|ol|li|table|article|section|main|span|h[1-6]|header|nav|meta|link|script)[\s>/]/i.test(html.slice(0, 65536));
}

function diagnose(ctx: PageContext): PageListDiagnosis {
  const d = ctx.doc;
  const main = d.all.find((e) => e.tag === "main");
  const shell = d.all.find((e) => e.tag === "app-root" || e.tag === "root" || ["__next", "root", "app", "__nuxt"].includes(e.attrs.id ?? ""));
  if (shell && textOf(d, shell).length < 200) return "appShell";
  if (main && textOf(d, main).length < 40) return "emptyMain";
  if (textOf(d, d.root).length < 200 && ctx.anchors.length < 5) return "appShell";
  return "noRepeatedLinks";
}

/**
 * Whether the markup says which character set it is written in, which is how PHP's DOMDocument::loadHTML reads it
 * (`<meta charset>`, `<meta http-equiv="Content-Type" content="…; charset=…">`, or an XML declaration). A page that
 * does not is read as Latin-1 by the bridge, whatever its HTTP headers say, so its non-ASCII text arrives garbled
 * unless the bridge is asked to repair it (XPathBridge's `fix_encoding`).
 */
export function markupDeclaresCharset(html: string): boolean {
  const head = html.slice(0, 32_768);
  return /<meta\s[^>]*\bcharset\s*=/i.test(head) || /^\s*<\?xml[^>]*\bencoding\s*=/i.test(head);
}

export type DetectOptions = {
  /** How many items to describe per list in `samples` (default 8). */
  samples?: number;
};

/**
 * The lists of posts on a page, best first (at most three), or why there are none. `html` is the decoded page,
 * `pageUrl` the address it was fetched from (links resolve against it and a `<base>`), `now` the moment relative dates
 * and dates without a year are counted from. Only the first list can be `high`, and `low` means no list was found.
 */
export function detectPageLists(html: string, pageUrl: string, now: Date = new Date(), options: DetectOptions = {}): PageListResult {
  if (html.length > MAX_PAGE_BYTES || (html.length * 3 > MAX_PAGE_BYTES && Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES)) return { candidates: [], diagnosis: "tooLarge" };
  if (!looksLikeHtml(html)) return { candidates: [], diagnosis: "notHtml" };
  let ctx: PageContext;
  try {
    ctx = new PageContext(html, pageUrl, now);
  } catch (error) {
    if (error instanceof TooComplexError) return { candidates: [], diagnosis: "tooComplex" };
    throw error;
  }
  const sampleCount = Math.max(options.samples ?? SAMPLE_COUNT, 1);
  try {
    return detect(ctx, sampleCount);
  } catch (error) {
    if (error instanceof TooComplexError) return { candidates: [], diagnosis: "tooComplex" };
    throw error;
  }
}

function detect(ctx: PageContext, sampleCount: number): PageListResult {
  const doc = ctx.doc;
  const structured = structuredLists(ctx);
  const contentAnchors = Math.max(1, ctx.anchors.filter((a) => ctx.text(a) || descendantsOf(doc, a).some((c) => c.tag === "img")).length);
  const cands: Cand[] = [];

  // 1. Microformats and microdata item sets.
  const semantic: [PNode[], "microformats" | "microdata"][] = [];
  const hentry = doc.all.filter((x) => classesOf(x).includes("h-entry") || classesOf(x).includes("hentry"));
  if (hentry.length >= 3) semantic.push([hentry, "microformats"]);
  const micro = doc.all.filter((x) => /schema\.org\/(?:Blog ?Posting|NewsArticle|Article|Event|JobPosting)$/.test(x.attrs.itemtype ?? ""));
  if (micro.length >= 3) semantic.push([micro, "microdata"]);
  for (const [els, label] of semantic) {
    const anchors = els.map((it) => {
      const h = semanticHints(ctx, it).link;
      if (h) return h;
      const inner = descendantsOf(doc, it).find((x) => x.tag === "a" && ctx.anchorSet.has(x));
      return inner ?? (it.tag === "a" && ctx.anchorSet.has(it) ? it : null);
    });
    if (anchors.every((a) => a !== null)) {
      const c = analyze(ctx, els, anchors, label, { hint: true });
      if (c) cands.push(c);
    }
  }

  // 2. Groups of links.
  type Pre = { quick: number; items: PNode[]; anchors: PNode[]; dups: PNode[] };
  const pre: Pre[] = [];
  const log = (k: number) => 2.2 * Math.log(Math.min(k, 40));
  for (const coarse of [false, true]) {
    for (const members of anchorGroups(ctx, coarse).values()) {
      const r = itemsFromGroup(ctx, members);
      if (!r) continue;
      const { items, anchors, dups } = r;
      const region = ctx.region(items[0]!);
      let quick = log(items.length) - region.penalty + region.good;
      if (anchors.reduce((s, a) => s + ctx.text(a).length, 0) / items.length < 3) quick -= 3;
      pre.push({ quick, items, anchors, dups });
      const byParent = new Map<PNode | null, number[]>();
      items.forEach((it, i) => {
        const g = byParent.get(it.parent);
        if (g) g.push(i);
        else byParent.set(it.parent, [i]);
      });
      if (byParent.size > 1) {
        for (const idx of byParent.values()) {
          if (idx.length >= 3 && idx.length < items.length) pre.push({ quick: log(idx.length) - region.penalty + region.good - 0.5, items: idx.map((i) => items[i]!), anchors: idx.map((i) => anchors[i]!), dups: [] });
        }
      }
    }
  }
  for (const ded of templateGroups(ctx)) {
    const region = ctx.region(ded[0]!);
    pre.push({ quick: log(ded.length) - region.penalty + region.good, items: ded, anchors: ded, dups: [] });
  }
  pre.sort((a, b) => b.quick - a.quick);
  const seenSets = new Set<string>();
  for (const p of pre.slice(0, MAX_ANALYSED)) {
    const sig = p.items.map((x) => x.idx).sort((a, b) => a - b).join(",");
    if (seenSets.has(sig)) continue;
    seenSets.add(sig);
    const c = analyze(ctx, p.items, p.anchors, "dom", { dups: p.dups });
    if (c) cands.push(c);
  }
  cands.push(...headingCandidates(ctx));

  // 3. Score, drop lists that overlap a better one, rank.
  for (const c of cands) score(ctx, c, structured, contentAnchors);
  cands.sort((a, b) => b.score - a.score);
  const final: Cand[] = [];
  for (const c of cands) {
    const us = new Set(c.urls);
    if (final.some((f) => {
      const fs = new Set(f.urls);
      let inter = 0;
      for (const u of us) if (fs.has(u)) inter++;
      return inter / Math.max(1, us.size + fs.size - inter) > 0.5;
    })) continue;
    if (us.size < 3) continue;
    final.push(c);
    if (final.length >= 3) break;
  }
  // Structured data with no list on the page to match it can still be offered, but cannot run as a recipe.
  for (const ss of structured) {
    if (!cands.slice(0, 6).some((f) => [...f.urls].filter((u) => ss.urls.has(u)).length >= 0.5 * ss.urls.size)) {
      final.push(dataOnly(ctx, ss));
    }
  }
  final.sort((a, b) => b.score - a.score);
  const top = final.slice(0, 3);
  const candidates = top.map((c, i) => publish(ctx, c, i + 1, top[i + 1]?.score, sampleCount));
  const best = candidates[0];
  return { candidates, diagnosis: !best || best.confidence === "low" ? diagnose(ctx) : null };
}

function dataOnly(ctx: PageContext, ss: Structured): Cand {
  return {
    items: [], anchors: [], urls: ss.items.map((i) => canonicalUrl(i.url)), titleNodes: [], source: "dom",
    rows: ss.items.map((i) => {
      const d = i.date ? ctx.date(i.date) : null;
      return { title: i.title, url: i.url, id: canonicalUrl(i.url), date: d?.iso ?? null, datePrecision: d?.precision ?? null };
    }),
    recipe: null, exact: false, near: 0, dateCoverage: 0, datesCarried: false, brittle: false, score: 14, why: ["dataOnly"], portable: false,
  };
}

function headingCandidates(ctx: PageContext): Cand[] {
  const out: Cand[] = [];
  const groups = new Map<string, PNode[]>();
  for (const x of ctx.doc.all) {
    if ((HEADS.includes(x.tag) || x.tag === "dt") && x.attrs.id && ctx.text(x)) {
      const k = `${x.tag}\u0000${[...new Set(classPreds(x).map((p) => (p as { v: string }).v))].sort().join("\u0001")}`;
      const g = groups.get(k);
      if (g) g.push(x);
      else groups.set(k, [x]);
    }
  }
  const versionLike = (t: string) => /\bv?\d+\.\d+(?:\.\d+)?\b/.test(t);
  for (const hs of groups.values()) {
    if (hs.length < 4 || new Set(hs.map((h) => h.attrs.id)).size < 0.9 * hs.length) continue;
    const dated = hs.filter((h) => ctx.absoluteDate(ctx.text(h))).length / hs.length;
    const versiony = hs.filter((h) => versionLike(ctx.text(h))).length / hs.length;
    if (dated < 0.5 && versiony < 0.6) continue;
    const kept = hs.filter((h) => ctx.absoluteDate(ctx.text(h)) || versionLike(ctx.text(h)));
    if (kept.length < 4) continue;
    const c = analyze(ctx, kept, kept.map(() => null), "heading-sections", { heading: true });
    if (c) out.push(c);
  }
  return out;
}

function recipeText(c: Cand): PageListRecipe | null {
  const r = c.recipe;
  if (!r || !r.title || !r.link) return null;
  const out: PageListRecipe = { item: toXPath(r.item), title: toXPath(r.title), link: toXPath(r.link) };
  if (r.date) out.date = toXPath(r.date);
  return out;
}

/**
 * The list as the recipe yields it: what the bridge will put in the feed, item by item. Elements the recipe selects
 * beyond the ones the detector found are included, repeated addresses are listed once, and the date is the one the
 * recipe reads (or, when it carries none, the one the detector read for the item).
 */
function recipeRows(ctx: PageContext, c: Cand): Row[] | null {
  const r = c.recipe;
  if (!r || !r.title || !r.link) return null;
  const found = new Map<PNode, Row>();
  c.items.forEach((it, i) => found.set(it, c.rows[i]!));
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const it of selectItems(ctx.doc, r.item)) {
    const href = evaluateField(ctx.doc, r.link, it) ?? "";
    let url = "";
    try {
      url = href ? new URL(href, ctx.base).href : "";
    } catch {
      url = href;
    }
    const title = norm(evaluateField(ctx.doc, r.title, it) ?? "");
    if (!url && !title) continue;
    const fragment = c.source === "heading-sections" && url.includes("#") ? `#${url.split("#")[1]}` : "";
    const id = url ? `${canonicalUrl(url)}${fragment}` : "";
    if (seen.has(id)) continue;
    seen.add(id);
    let date: ParsedDate | null = null;
    if (r.date) date = ctx.date(evaluateField(ctx.doc, r.date, it) ?? "");
    else {
      const own = found.get(it);
      if (own?.date) date = { iso: own.date, precision: own.datePrecision ?? "day", kind: own.datePrecision === "relative" ? "relative" : "absolute" };
    }
    rows.push({ title, url, id, date: date?.iso ?? null, datePrecision: date?.precision ?? null });
  }
  return rows;
}

function publish(ctx: PageContext, c: Cand, rank: number, nextScore: number | undefined, sampleCount: number): PageListCandidate {
  const gap = nextScore === undefined ? Infinity : c.score - nextScore;
  // Only the best list can be the pre-selected one; a data-only list never is.
  let confidence: PageListConfidence = c.score >= 17 && gap >= 3 ? "high" : c.score >= 10 ? "medium" : "low";
  if (rank > 1 && confidence === "high") confidence = "medium";
  if (!c.portable) confidence = "medium";
  const recipe = recipeText(c);
  const portable = c.portable && recipe !== null;
  // A list that cannot be written as a recipe (no title or link expression found) is not one to offer.
  if (c.portable && !portable) confidence = "low";
  const reasons = [...new Set(c.why)];
  const rows = (portable ? recipeRows(ctx, c) : null) ?? c.rows;
  return {
    rank,
    score: Math.round(c.score * 10) / 10,
    confidence,
    reasons: portable ? reasons : reasons.filter((r) => r !== "brittle" && r !== "undated" && r !== "dated"),
    recipe: portable ? recipe : null,
    datesInRecipe: portable && recipe?.date !== undefined,
    itemCount: rows.length,
    samples: rows.slice(0, sampleCount),
    portable,
  };
}
