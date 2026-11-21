/*
 * From elements the detector picked to the XPath that selects them again: a class test where the classes identify the
 * item, then the ancestors' classes, then a union of looks, then positions (marked brittle). Every expression is
 * evaluated against the tree it was derived from before it is kept.
 */
import { selectableTag } from "./page-dom.ts";
import type { PageDom, PNode } from "./page-dom.ts";
import { mostCommon } from "./page-context.ts";
import { MAX_EXPRESSION_LENGTH, classPreds, predKey, selectFrom, selectItems, tokenKind, toXPath } from "./page-xpath.ts";
import type { Expr, PathExpr, Pred, Step } from "./page-xpath.ts";

function step(axis: Step["axis"], tag: string, preds: Pred[] = []): Step {
  return { axis, tag, preds };
}

function path(root: boolean, steps: Step[], extra: { nth?: number; attr?: string } = {}): PathExpr {
  const p: PathExpr = { kind: "path", root, steps };
  if (extra.nth !== undefined) p.nth = extra.nth;
  if (extra.attr !== undefined) p.attr = extra.attr;
  return p;
}

function fits(e: Expr): boolean {
  return toXPath(e).length <= MAX_EXPRESSION_LENGTH;
}

/** Class tests that at least `share` of the nodes have, in first-seen order. */
function commonPreds(nodes: PNode[], share = 0.95): Pred[] {
  const count = new Map<string, { p: Pred; n: number }>();
  for (const n of nodes) {
    for (const p of classPreds(n)) {
      const key = predKey(p);
      const e = count.get(key);
      if (e) e.n++;
      else count.set(key, { p, n: 1 });
    }
  }
  return [...count.values()].filter((e) => e.n >= share * nodes.length).map((e) => e.p);
}

// ---- relative expressions (title, link, date)

export type RelPath = { steps: Step[]; nth?: number; brittle: boolean };
export type RelResult = { path: RelPath | null; coverage: number };

/**
 * The shortest expression, relative to each item, whose first match is the node picked for it. `roots[i]` is the
 * element the expression starts from (the item, or a sibling of it).
 */
export function generateRelative(d: PageDom, roots: (PNode | null)[], nodes: (PNode | null)[], require = 0.9): RelResult {
  const total = roots.length;
  const pairs: [PNode, PNode][] = [];
  roots.forEach((it, i) => {
    const n = nodes[i];
    if (it && n) pairs.push([it, n]);
  });
  if (!pairs.length) return { path: null, coverage: 0 };
  const selves = pairs.filter(([it, n]) => it === n).length;
  if (selves >= require * total) return { path: { steps: [], brittle: false }, coverage: selves / total };

  const maxDepth = 4;
  const chains = pairs.slice(0, 14).map(([it, n]) => {
    const chain: PNode[] = [];
    for (let x: PNode | null = n; x && x !== it && chain.length < maxDepth; x = x.parent) chain.push(x);
    return chain;
  });
  const tag0 = mostCommon(chains.filter((c) => c.length).map((c) => c[0]!.tag));
  if (!tag0) return { path: null, coverage: 0 };

  let best: { steps: Step[]; cov: number; cost: number } | null = null;
  const evalFirst = (it: PNode, steps: Step[]): PNode | undefined => selectFrom(d, path(false, steps), it)[0];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const ref = chains.filter((c) => c.length >= depth && c[0]!.tag === tag0.value);
    if (!ref.length) continue;
    const levels: { tag: string; opts: Pred[][] }[] = [];
    for (let lv = 0; lv < depth; lv++) {
      const col = ref.map((c) => c[lv]!);
      const tag = mostCommon(col.map((x) => x.tag))!.value;
      const common = commonPreds(col.filter((x) => x.tag === tag), 0.9);
      const opts: Pred[][] = [[]];
      for (const p of common.slice(0, 3)) opts.push([p]);
      if (common.length >= 2) opts.push(common.slice(0, 2));
      levels.push({ tag, opts });
    }
    let combos: { tag: string; preds: Pred[] }[][] = [[]];
    for (const { tag, opts } of levels) combos = combos.flatMap((c) => opts.map((o) => [...c, { tag, preds: o }])).slice(0, 60);
    for (const combo of combos) {
      const steps: Step[] = [];
      for (let i = depth - 1; i >= 0; i--) steps.push(step(i === depth - 1 ? "desc" : "child", combo[i]!.tag, combo[i]!.preds));
      let hits = 0;
      for (const [it, n] of pairs) if (evalFirst(it, steps) === n) hits++;
      const cov = hits / total;
      const cost = combo.reduce((s, c) => s + 1 + c.preds.length, 0);
      if (best === null ? cov > 1e-9 : cov > best.cov + 1e-9 || (Math.abs(cov - best.cov) < 1e-9 && cost < best.cost)) best = { steps, cov, cost };
    }
    if (best && best.cov >= 0.98) break;
  }
  if (best && best.cov >= require) return { path: { steps: best.steps, brittle: false }, coverage: best.cov };

  // The k-th element of that tag below the item.
  const ks = new Map<number, number>();
  for (const [it, n] of pairs) {
    const same = selectFrom(d, path(false, [step("desc", tag0.value)]), it);
    const at = same.indexOf(n);
    if (at >= 0) ks.set(at + 1, (ks.get(at + 1) ?? 0) + 1);
  }
  const k = mostCommon([...ks.entries()].flatMap(([key, c]) => Array<number>(c).fill(key)));
  if (k) {
    const cov = k.count / total;
    if (cov > (best?.cov ?? 0) && cov >= require) return { path: { steps: [step("desc", tag0.value)], nth: k.value, brittle: true }, coverage: cov };
  }
  if (best && best.cov >= 0.6) return { path: { steps: best.steps, brittle: false }, coverage: best.cov };
  return { path: null, coverage: best?.cov ?? 0 };
}

export function relExpr(p: RelPath, attr?: string, lead: Step[] = []): PathExpr {
  const steps = [...lead, ...p.steps];
  return path(false, steps, { nth: p.nth, attr });
}

// ---- absolute expressions (the item)

export type AbsResult = { expr: Expr; exact: boolean; selected: number; brittle: boolean } | null;

function hrefPath(href: string): string {
  return href.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/^\/\/[^/?#]*/, "").split(/[?#]/)[0]!;
}

function commonPrefix(values: string[]): string {
  let p = values[0] ?? "";
  for (const v of values) while (!v.startsWith(p)) p = p.slice(0, -1);
  return p;
}

function positionalPath(n: PNode): Step[] {
  const parts: Step[] = [];
  for (let x: PNode | null = n; x && x.tag !== "#root"; x = x.parent) {
    const sibs = (x.parent?.children ?? []).filter((s) => s.tag === x!.tag);
    parts.push(step("child", x.tag, sibs.length > 1 ? [{ k: "pos", n: sibs.indexOf(x) + 1 }] : []));
  }
  return parts.reverse();
}

function positional(items: PNode[]): Expr | null {
  const byParent = new Map<PNode, PNode[]>();
  for (const it of items) {
    if (!it.parent) return null;
    const g = byParent.get(it.parent);
    if (g) g.push(it);
    else byParent.set(it.parent, [it]);
  }
  if (byParent.size > 6) return null;
  const parts: PathExpr[] = [];
  for (const [par, grp] of byParent) {
    if (par.tag === "#root") return null;
    const tag = grp[0]!.tag;
    if (!selectableTag(tag) || par.children.filter((s) => s.tag === tag).length !== grp.length) return null;
    parts.push(path(true, [step("child", "html"), step("child", "body"), ...positionalPath(par), step("child", tag)]));
  }
  return parts.length === 1 ? parts[0]! : { kind: "union", parts };
}

function fineKey(n: PNode): string {
  const key: string[] = [];
  for (let x: PNode | null = n; x && x.tag !== "#root"; x = x.parent) {
    key.push(`${x.tag}\u0001${classPreds(x).map((p) => (p as { v: string }).v).filter((v) => !v.includes("--")).sort().join("\u0002")}`);
  }
  return key.reverse().join("\u0003");
}

function union(d: PageDom, items: PNode[]): Expr | null {
  const clusters = new Map<string, PNode[]>();
  for (const it of items) {
    const k = fineKey(it);
    const g = clusters.get(k);
    if (g) g.push(it);
    else clusters.set(k, [it]);
  }
  if (clusters.size < 2 || clusters.size > 6) return null;
  const parts: PathExpr[] = [];
  for (const cl of clusters.values()) {
    const r = generateItems(d, cl, false);
    if (!r?.exact || r.expr.kind !== "path") return null;
    parts.push(r.expr);
  }
  const e: Expr = { kind: "union", parts };
  return fits(e) ? e : null;
}

const SEGMENT = /^[\p{L}_-]{4,}$/u;
const ID_PREFIX = /^[\p{L}\p{N}_.-]+$/u;

/** An expression that selects exactly `items` (anywhere in the document), or the closest one it found. */
export function generateItems(d: PageDom, items: PNode[], allowUnion = true): AbsResult {
  const target = new Set(items);
  const tag = mostCommon(items.map((x) => x.tag))!.value;
  if (!selectableTag(tag)) return null;
  const same = (got: PNode[]) => got.length === target.size && got.every((x) => target.has(x));
  const jaccard = (got: PNode[]) => {
    const inter = got.filter((x) => target.has(x)).length;
    return inter / Math.max(1, got.length + target.size - inter);
  };
  const common: Pred[] = commonPreds(items, 0.95);
  if (tag === "a" && items.every((x) => x.attrs.href)) {
    let shared: string[] | null = null;
    for (const x of items) {
      const ss = hrefPath(x.attrs.href!).split("/").slice(0, -1).filter((s) => SEGMENT.test(s));
      shared = shared === null ? [...new Set(ss)] : shared.filter((s) => ss.includes(s));
    }
    for (const s of (shared ?? []).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 2)) common.push({ k: "attrc", name: "href", v: `/${s}/` });
  }
  if (tag !== "a") common.push({ k: "hasa" });
  if (items.every((x) => x.attrs.id)) {
    const ids = items.map((x) => x.attrs.id!);
    const pre = commonPrefix(ids);
    if (pre.length >= 2 && new Set(ids).size === ids.length && /[A-Za-z]/.test(pre) && ID_PREFIX.test(pre)) common.push({ k: "idpre", v: pre });
  }
  const sel = (steps: Step[]) => selectItems(d, path(true, steps));
  const candPreds = (): Pred[][] => {
    const out: Pred[][] = [[]];
    for (const p of common) out.push([p]);
    for (let i = 0; i < common.length; i++) for (let j = i + 1; j < Math.min(common.length, 5); j++) out.push([common[i]!, common[j]!]);
    return out;
  };
  const alternatives = candPreds();
  let best: { score: number; expr: Expr; selected: number } | null = null;
  const consider = (steps: Step[]): AbsResult => {
    const expr = path(true, steps);
    const got = sel(steps);
    if (same(got) && fits(expr)) return { expr, exact: true, selected: got.length, brittle: false };
    const score = jaccard(got);
    if (best === null || score > best.score) best = { score, expr, selected: got.length };
    return null;
  };
  let tried = 0;
  for (const preds of alternatives) {
    const r = consider([step("desc", tag, preds)]);
    if (r) return r;
    if (++tried > 14) break;
  }
  // Add the ancestors' context.
  const chains = items.slice(0, 12).map((it) => {
    const chain: PNode[] = [];
    for (let x = it.parent; x && x.tag !== "#root" && chain.length < 6; x = x.parent) chain.push(x);
    return chain;
  });
  for (let L = 1; L <= 5; L++) {
    const levels: { tag: string; opts: Pred[][] }[] = [];
    let ok = true;
    for (let lv = 0; lv < L; lv++) {
      const col = chains.filter((c) => c.length > lv).map((c) => c[lv]!);
      if (col.length < 0.9 * chains.length) {
        ok = false;
        break;
      }
      const t = mostCommon(col.map((x) => x.tag))!.value;
      const sameTag = col.filter((x) => x.tag === t);
      const cm = commonPreds(sameTag, 0.9);
      const ids = new Set(sameTag.map((x) => x.attrs.id));
      const opts: Pred[][] = [[]];
      for (const p of cm.slice(0, 3)) opts.push([p]);
      const only = [...ids][0];
      if (ids.size === 1 && only && tokenKind(only)) opts.push([{ k: "attr", name: "id", v: only }]);
      if (cm.length >= 2) opts.push(cm.slice(0, 2));
      if (!selectableTag(t)) opts.length = 0;
      levels.push({ tag: t, opts });
    }
    if (!ok) break;
    const top = levels[L - 1]!;
    for (const ipreds of alternatives.slice(0, 8)) {
      for (const outer of top.opts) {
        let chain: Step[];
        if (L === 1) chain = [step("desc", top.tag, outer), step("desc", tag, ipreds)];
        else {
          chain = [step("desc", top.tag, outer)];
          for (let lv = L - 2; lv >= 0; lv--) {
            if (!selectableTag(levels[lv]!.tag)) {
              chain = [];
              break;
            }
            chain.push(step("child", levels[lv]!.tag));
          }
          if (!chain.length) continue;
          chain.push(step("child", tag, ipreds));
        }
        const r = consider(chain);
        if (r) return r;
        if (L > 1) {
          const r2 = consider([...chain.slice(0, -1), step("desc", tag, ipreds)]);
          if (r2) return r2;
        }
      }
    }
  }
  if (allowUnion) {
    const u = union(d, items);
    if (u) return { expr: u, exact: true, selected: items.length, brittle: false };
    const p = positional(items);
    if (p && fits(p) && same(selectItems(d, p))) return { expr: p, exact: true, selected: items.length, brittle: true };
  }
  const b = best as { score: number; expr: Expr; selected: number } | null;
  return b && fits(b.expr) ? { expr: b.expr, exact: false, selected: b.selected, brittle: false } : null;
}

