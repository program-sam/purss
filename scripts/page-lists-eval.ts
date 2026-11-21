#!/usr/bin/env node
/**
 * How well does the page-list detector find the list of posts on pages that have no feed? Runs `detectPageLists` over
 * a directory of saved pages and compares each page's lists with hand labels (the first five titles, links and dates of
 * the right list), then prints top-1 and top-3 accuracy, the strict order match, title cleanliness, date accuracy and
 * how well the confidence label separates right from wrong. It also checks that every recipe passes `validateRecipe`.
 * Run by hand when the detector changes; the saved pages are not part of the repository, so it is not part of `npm test`.
 *
 *   node scripts/page-lists-eval.ts <pages-dir> <labels.json> [--json out.json] [--proto results.json] [--now 2026-11-21T13:00:00Z]
 *
 * <pages-dir> holds `<page-id>.html`; the labels file maps page ids to
 * `{ cat, lang, base, static, frag, has_list, titles, links, dates, alts }`. `--proto` names the prototype's
 * results file, to print its verdict next to this detector's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectPageLists, validateRecipe } from "../packages/connectors/src/page-lists.ts";
import type { PageListCandidate } from "../packages/connectors/src/page-lists.ts";

type Label = {
  cat: string;
  lang: string;
  base: string;
  static: boolean;
  frag?: boolean;
  has_list: boolean;
  titles: string[];
  links: (string | null)[];
  dates: (string | null)[];
  alts: { links: string[] }[];
};

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const jsonOut = flag("--json");
const protoPath = flag("--proto");
const now = new Date(flag("--now") ?? "2026-11-21T13:00:00Z");
const [pagesDir, labelsPath] = args;
if (!pagesDir || !labelsPath) {
  console.error("usage: node scripts/page-lists-eval.ts <pages-dir> <labels.json> [--json out.json] [--proto results.json] [--now ISO]");
  process.exit(2);
}

function decodeHtml(raw: Buffer): string {
  let charset: string | null = null;
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) charset = "utf-8";
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(raw.subarray(0, 4096).toString("latin1"))?.[1] ?? null;
  for (const c of [charset, "utf-8"]) {
    if (!c) continue;
    try {
      return new TextDecoder(c, { fatal: true }).decode(raw);
    } catch {
      // try the next
    }
  }
  return new TextDecoder("utf-8").decode(raw);
}

// ---- measures (the same as the prototype's evaluate.py)

const canon = (u: string): string => {
  try {
    const p = new URL(u.trim());
    const host = p.hostname.replace(/^www\./, "");
    const q = new URLSearchParams();
    for (const [k, v] of p.searchParams) if (!/^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|recid|recsource|searchid|eventorigin|source|cmpid|ocid|share|igshid|yclid|_ga|spm|at_.*)$/i.test(k)) q.append(k, v);
    let pth = p.pathname.replace(/\/index\.html?$/, "/");
    if (pth.length > 1 && pth.endsWith("/")) pth = pth.slice(0, -1);
    return `https://${host}${p.port && p.port !== "80" && p.port !== "443" ? `:${p.port}` : ""}${pth || "/"}${q.size ? `?${q}` : ""}`;
  } catch {
    return u;
  }
};
const labCanon = (x: string, frag: boolean) => (frag && x.includes("#") ? `${canon(x)}#${x.split("#")[1]}` : canon(x));
const tkey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().replace(/[‘’“”'"`.,:;!?()[\]\-–—]/g, "").trim();

function titleClass(got: string, want: string): "exact" | "empty" | "contaminated" | "truncated" | "near" | "wrong" {
  const g = tkey(got);
  const w = tkey(want);
  if (g === w) return "exact";
  if (!g) return "empty";
  if (w.length >= 45 && g.startsWith(w) && g.length - w.length <= 30) return "exact";
  if (g.includes(w)) return "contaminated";
  if (w.includes(g)) return "truncated";
  const gw = new Set(g.split(" "));
  const ww = new Set(w.split(" "));
  const common = [...ww].filter((x) => gw.has(x)).length;
  return ww.size && common / ww.size >= 0.8 && gw.size <= ww.size * 1.25 ? "near" : "wrong";
}

type Sample = PageListCandidate["samples"][number];

function dateOk(label: string | null, row: Sample): boolean | null {
  if (label === "?" || label === null) return null;
  if (label === "rel") return row.datePrecision === "relative";
  const got = row.date;
  if (!got) return false;
  const day = label.split("T")[0]!;
  return got.slice(0, day.length) === day || (label.length === 7 && got.slice(0, 7) === label);
}

function match(links: (string | null)[], rows: Sample[], frag: boolean): { hits: number; strict: boolean } {
  const want = links.filter((x): x is string => !!x).map((x) => labCanon(x, frag));
  const ids = rows.map((r) => r.id);
  return { hits: want.filter((w) => ids.slice(0, 10).includes(w)).length, strict: want.every((w, i) => ids[i] === w) };
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "n/a");

// ---- run

const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, Label>;
const proto = protoPath ? (JSON.parse(readFileSync(protoPath, "utf8")) as Record<string, { new?: { top1?: boolean; top3?: boolean } }>) : null;
const agg = { pages: 0, t1: 0, t3: 0, s1: 0, s3: 0, a1: 0, a3: 0, tn: 0, tex: 0, tcont: 0, dtot: 0, dgot: 0, dright: 0, spur: 0 };
const calibration = new Map<string, boolean[]>();
const noList: [string, string | null, number | null, string | null][] = [];
const out: Record<string, unknown> = {};
let invalidRecipes = 0;
let candidatesSeen = 0;
let slowest = { id: "", ms: 0 };
let totalMs = 0;

for (const [id, lab] of Object.entries(labels)) {
  const html = decodeHtml(readFileSync(path.join(pagesDir, `${id}.html`)));
  const started = performance.now();
  const result = detectPageLists(html, lab.base, now, { samples: 200 });
  const ms = performance.now() - started;
  totalMs += ms;
  if (ms > slowest.ms) slowest = { id, ms };
  for (const c of result.candidates) {
    candidatesSeen++;
    if (c.recipe && validateRecipe(c.recipe).ok !== true) invalidRecipes++;
  }
  const cands = result.candidates;
  const kind = lab.static && lab.has_list ? "list" : !lab.static ? "JS" : "none";
  let line = `${id.padEnd(24)} ${kind.padEnd(5)} ${lab.cat.padEnd(13)} |`;
  if (kind !== "list") {
    noList.push([id, cands[0]?.confidence ?? null, cands[0]?.itemCount ?? null, result.diagnosis]);
    console.log(`${line} top=${cands[0]?.confidence ?? "none"} rows=${cands[0]?.itemCount ?? 0} diagnosis=${result.diagnosis} (${ms.toFixed(0)} ms)`);
    out[id] = { top_conf: cands[0]?.confidence ?? null, top_n: cands[0]?.itemCount ?? 0, diagnosis: result.diagnosis };
    continue;
  }
  const frag = lab.frag ?? false;
  const lens: boolean[] = [];
  const stricts: boolean[] = [];
  const alts: boolean[] = [];
  for (const c of cands) {
    const m = match(lab.links, c.samples, frag);
    lens.push(m.hits >= 4);
    stricts.push(m.strict);
    alts.push(Math.max(0, ...lab.alts.map((a) => match(a.links, c.samples, frag).hits)) >= 4);
  }
  const top1 = lens[0] === true;
  const top3 = lens.some(Boolean);
  agg.pages++;
  agg.t1 += Number(top1);
  agg.t3 += Number(top3);
  agg.s1 += Number(stricts[0] === true);
  agg.s3 += Number(stricts.some(Boolean));
  agg.a1 += Number(top1 || alts[0] === true);
  agg.a3 += Number(lens.some((l, i) => l || alts[i]));
  const mi = lens.findIndex(Boolean);
  const classes: string[] = [];
  const dates = { total: 0, got: 0, right: 0, spurious: 0 };
  if (mi >= 0) {
    const rows = new Map(cands[mi]!.samples.map((r) => [r.id, r]));
    lab.titles.forEach((t, i) => {
      const l = lab.links[i];
      const d = lab.dates[i] ?? null;
      const row = l ? rows.get(labCanon(l, frag)) : undefined;
      if (!row) return;
      classes.push(titleClass(row.title, t));
      if (d !== null && d !== "?") {
        dates.total++;
        if (row.date) dates.got++;
        if (dateOk(d, row)) dates.right++;
      } else if (d === null && row.date) dates.spurious++;
    });
  }
  agg.tn += classes.length;
  agg.tex += classes.filter((c) => c === "exact").length;
  agg.tcont += classes.filter((c) => c === "contaminated").length;
  agg.dtot += dates.total;
  agg.dgot += dates.got;
  agg.dright += dates.right;
  agg.spur += dates.spurious;
  const conf = cands[0]?.confidence ?? "none";
  calibration.set(conf, [...(calibration.get(conf) ?? []), top1]);
  const letter: Record<string, string> = { exact: "E", contaminated: "C", truncated: "T", near: "n", wrong: "X", empty: "0" };
  const protoNew = proto?.[id]?.new;
  line += ` ${top1 ? "Y" : "-"} ${top3 ? "Y" : "-"} ${stricts[0] ? "Y" : "-"} r=${mi >= 0 ? mi + 1 : "None"} t=${classes.map((c) => letter[c]).join("")} conf=${conf}${protoNew ? ` | proto ${protoNew.top1 ? "Y" : "-"} ${protoNew.top3 ? "Y" : "-"}` : ""} (${ms.toFixed(0)} ms)`;
  console.log(line);
  out[id] = { top1, top3, top1_strict: stricts[0] === true, matched_rank: mi >= 0 ? mi + 1 : null, titles: classes, dates, conf1: conf, confidences: cands.map((c) => c.confidence), scores: cands.map((c) => c.score), diagnosis: result.diagnosis };
}

console.log(`\n== ${agg.pages} list pages`);
console.log(`  top-1 lenient ${pct(agg.t1, agg.pages)}   top-3 lenient ${pct(agg.t3, agg.pages)}`);
console.log(`  top-1 strict  ${pct(agg.s1, agg.pages)}   top-3 strict  ${pct(agg.s3, agg.pages)}`);
console.log(`  top-1 incl. alt lists ${pct(agg.a1, agg.pages)}   top-3 incl. alt ${pct(agg.a3, agg.pages)}`);
console.log(`  titles on the matched list: exact ${pct(agg.tex, agg.tn)}, contaminated ${pct(agg.tcont, agg.tn)}`);
console.log(`  dates (items labelled with a date): returned ${pct(agg.dgot, agg.dtot)}, correct ${pct(agg.dright, agg.dtot)}; spurious on date-less items: ${agg.spur}`);
console.log("== calibration of the top-1 confidence label (lenient top-1 correct)");
for (const k of ["high", "medium", "low", "none"]) {
  const v = calibration.get(k);
  if (v) console.log(`  ${k.padEnd(7)} ${pct(v.filter(Boolean).length, v.length)}`);
}
console.log("== pages without a list (JS-only or none): top-1 confidence, item count, diagnosis");
for (const [id, conf, n, diag] of noList) console.log(`  ${id}: ${conf ?? "none"}, ${n ?? 0} items, ${diag ?? "-"}`);
console.log(`== recipes: ${candidatesSeen} candidates, ${invalidRecipes} refused by validateRecipe`);
console.log(`== time: ${totalMs.toFixed(0)} ms in total, slowest ${slowest.id} ${slowest.ms.toFixed(0)} ms`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
process.exit(invalidRecipes ? 1 : 0);
