/*
 * What the page-list detector knows about the page it reads: the tree, the address links resolve against, the links
 * worth considering, and how likely a spot in the page is to be navigation rather than content.
 */
import { buildPageDom, classesOf, textOf } from "./page-dom.ts";
import type { PageDom, PNode } from "./page-dom.ts";
import { looksLikeDateOnly, parseAbsoluteDate, parseDate } from "./page-dates.ts";
import type { ParsedDate } from "./page-dates.ts";

const TRACKING = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|recid|recsource|searchid|eventorigin|source|cmpid|ocid|share|igshid|yclid|_ga|spm|at_.*)$/i;

/** The stable identity of an item address: https, no `www.`, no tracking parameters, no fragment, no trailing slash. */
export function canonicalUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./, "");
  const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!TRACKING.test(k)) kept.append(k, v);
  let path = u.pathname.replace(/\/index\.html?$/, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const query = kept.toString();
  return `https://${host}${port}${path || "/"}${query ? `?${query}` : ""}`;
}

export function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** The value that occurs most often; the first one seen wins a tie. */
export function mostCommon<T>(values: Iterable<T>): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) if (best === null || count > best.count) best = { value, count };
  return best;
}

const NEG_TAGS: Record<string, number> = { nav: 9, header: 3, footer: 8, aside: 6, form: 3 };
const NEG_WORDS = /(?:^|[-_ ])(nav|navbar|navigation|menu|menus|footer|breadcrumbs?|pagination|pager|paging|social|share|sharing|cookie|consent|banner|toolbar|sidebar|skip|tabs?|filters?|facets?|toc|related|trending|popular|widget|comments?|newsletter|subscribe|promo|advert|ad|ads|sponsor\w*|masthead|dropdown|megamenu|language|lang|locale|selector|switcher)(?:$|[-_ ])/i;
const NAVISH = /^(?:nav|navbar|navigation|menu|menus|breadcrumbs?|pagination|pager|paging|tabs?|toc|dropdown|megamenu|skip|toolbar|filters?|facets?|language|lang|locale|selector|switcher)$/i;
const NAV_ROLES = new Set(["navigation", "menubar", "tablist"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menubar", "tablist"]);

export type RegionKind = "inNav" | "inFooter" | "inSidebar" | "inChrome";
export type Region = { penalty: number; good: number; kind: RegionKind | null };

export class PageContext {
  readonly url: string;
  readonly now: Date;
  readonly doc: PageDom;
  readonly lang: string;
  readonly base: string;
  readonly anchors: PNode[] = [];
  readonly anchorSet = new Set<PNode>();
  private readonly resolved = new Map<PNode, string>();
  private readonly regions = new Map<PNode, Region>();
  private readonly dates = new Map<string, ParsedDate | null>();
  private readonly dateOnly = new Map<string, boolean>();

  constructor(html: string, url: string, now: Date) {
    this.url = url;
    this.now = now;
    this.doc = buildPageDom(html);
    this.lang = (this.doc.lang || "en").toLowerCase();
    this.base = this.resolveAgainst(this.doc.base, url) ?? url;
    const here = canonicalUrl(url);
    for (const a of this.doc.all) {
      if (a.tag !== "a") continue;
      const h = (a.attrs.href ?? "").trim();
      if (!h || /^(?:#|javascript:|mailto:|tel:|sms:|data:)/i.test(h)) continue;
      const u = this.resolveAgainst(h, this.base);
      if (!u || !/^https?:\/\//i.test(u)) continue;
      if (canonicalUrl(u) === here && h.includes("#")) continue;
      this.anchors.push(a);
      this.anchorSet.add(a);
      this.resolved.set(a, u);
    }
  }

  private resolveAgainst(href: string, base: string): string | null {
    if (!href) return null;
    try {
      return new URL(href.trim(), base).href;
    } catch {
      return null;
    }
  }

  /** The absolute address an anchor points at. */
  abs(a: PNode): string {
    return this.resolved.get(a) ?? this.resolveAgainst(a.attrs.href ?? "", this.base) ?? "";
  }

  text(n: PNode): string {
    return textOf(this.doc, n);
  }

  /** The date a text reads as (an absolute one first, then a relative one); the same text is read once. */
  date(text: string): ParsedDate | null {
    let r = this.dates.get(text);
    if (r === undefined) {
      r = parseDate(text, this.lang, this.now);
      if (this.dates.size < 100_000) this.dates.set(text, r);
    }
    return r;
  }

  /** The first absolute date in a text. */
  absoluteDate(text: string): ParsedDate | null {
    return parseAbsoluteDate(text, this.lang, this.now);
  }

  /** Whether the text is essentially only a date. */
  isDateOnly(text: string): boolean {
    let r = this.dateOnly.get(text);
    if (r === undefined) {
      r = looksLikeDateOnly(text, this.lang, this.now);
      if (this.dateOnly.size < 100_000) this.dateOnly.set(text, r);
    }
    return r;
  }

  /** How much a spot looks like navigation or page furniture (higher is worse), whether it sits in the main content, and what kind. */
  region(n: PNode): Region {
    const cached = this.regions.get(n);
    if (cached) return cached;
    let penalty = 0;
    let good = 0;
    let worst = 0;
    let kind: RegionKind | null = null;
    for (let a: PNode | null = n; a && a.tag !== "#root"; a = a.parent) {
      const role = a.attrs.role ?? "";
      const ident = `${classesOf(a).join(" ")} ${a.attrs.id ?? ""}`;
      let p = NEG_TAGS[a.tag] ?? 0;
      if (CHROME_ROLES.has(role)) p = Math.max(p, 7);
      const word = NEG_WORDS.exec(ident)?.[1] ?? null;
      if (word) p = Math.max(p, 4);
      if (p) {
        penalty += p;
        if (p > worst) {
          worst = p;
          kind = a.tag === "footer" || role === "contentinfo" || word?.toLowerCase() === "footer" ? "inFooter"
            : a.tag === "nav" || NAV_ROLES.has(role) || (word !== null && NAVISH.test(word)) ? "inNav"
            : a.tag === "aside" || role === "complementary" || (word !== null && /^(?:sidebar|related|trending|popular|widget)$/i.test(word)) ? "inSidebar"
            : "inChrome";
        }
      }
      if (a.tag === "main" || a.tag === "article" || role === "main" || ["main", "content", "main-content", "primary"].includes(a.attrs.id ?? "")) good = 3;
    }
    const r: Region = { penalty: Math.min(penalty, 16), good, kind };
    this.regions.set(n, r);
    return r;
  }
}
