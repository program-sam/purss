import { deflateRawSync, inflateRawSync } from "node:zlib";
import { isForbiddenLiteralHost } from "./addresses.ts";
import { canonicalUrl } from "./page-context.ts";
import { validateRecipe } from "./page-xpath.ts";
import type { PageListRecipe } from "./page-xpath.ts";
import { privateUrlReason } from "./privacy.ts";
import { parseTarget } from "./safe-fetch.ts";

/*
 * A page list as a bridged source. The page-list detector (page-lists.ts) describes the list of posts on a page that
 * has no feed as a recipe: XPath expressions the bundled RSS-Bridge's XPathBridge runs against the page. A source made
 * from one is `bridge:page/<key>`, and the key is the whole description: the page's address, the recipe, and whether
 * the bridge has to repair the page's character set. It is a compact JSON in a fixed order, deflated and written in
 * base64url, so the same description is always the same key, and the descriptor says everything the router needs
 * without a database of its own.
 *
 * A key is read back with the same care as a pasted address: it must inflate to a small document in exactly the form
 * the writer makes, hold an address PURSS is allowed to fetch, and hold a recipe inside the grammar page-xpath.ts
 * checks. Nothing else reaches XPathBridge, and no key comes from anywhere but the detector.
 */

/** What a key says. */
export type PageSource = {
  /** The page, as the address parser writes it (no fragment). */
  url: string;
  recipe: PageListRecipe;
  /** The page has no character set in its own markup, which PHP's HTML reader needs; XPathBridge's `fix_encoding` undoes what it does then. */
  fixEncoding: boolean;
};

/**
 * The longest key. A page address is up to 2048 characters and each expression 200, so the largest recipe would be far
 * bigger; this bound is what the detector's recipes fit (see page-feeds.test.ts) with room, and a page whose recipe
 * does not fit is not offered. FreshRSS 1.30.4 keeps a feed address in a 32768-character column, the egress proxy
 * and the router read request lines of several KiB, and the descriptor is kept as text in the database.
 */
export const MAX_PAGE_KEY = 380;
/** What a key may inflate to: the largest well-formed document is about three KiB. */
const MAX_PAGE_DOCUMENT = 4096;

const KEY_CHARS = /^[A-Za-z0-9_-]+$/;

/** The page's address as discovery keeps it, or null when PURSS may not fetch it or it looks to carry a credential. */
function allowedPage(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const target = parseTarget(url);
  if (!target.ok || isForbiddenLiteralHost(target.url.hostname) || privateUrlReason(target.url.href)) return null;
  return target.url.href;
}

/** The document a source is written as: keys in this order, and nothing else. */
function documentOf(source: PageSource): string | null {
  const { recipe } = source;
  const url = allowedPage(source.url);
  if (!url || url !== source.url || !validateRecipe(recipe).ok) return null;
  const fields: Record<string, string | number> = { u: url, i: recipe.item, t: recipe.title, l: recipe.link };
  if (recipe.date !== undefined) fields.d = recipe.date;
  if (source.fixEncoding) fields.e = 1;
  return JSON.stringify(fields);
}

/** The key for a page and its recipe: the same description always gives the same key. Null when the description is not allowed or does not fit. */
export function encodePageKey(source: PageSource): string | null {
  const url = allowedPage(source.url);
  const json = url ? documentOf({ ...source, url }) : null;
  if (!json) return null;
  const key = deflateRawSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64url");
  return key.length <= MAX_PAGE_KEY ? key : null;
}

/** What a key says, or null for anything that is not exactly what `encodePageKey` makes. */
export function decodePageKey(key: string): PageSource | null {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_PAGE_KEY || !KEY_CHARS.test(key)) return null;
  const bytes = Buffer.from(key, "base64url");
  // One spelling of each key: the same bytes in another spelling (spare bits at the end) are another address for the same source.
  if (bytes.toString("base64url") !== key) return null;
  let text: string;
  try {
    text = inflateRawSync(bytes, { maxOutputLength: MAX_PAGE_DOCUMENT }).toString("utf8");
  } catch {
    return null;
  }
  let fields: unknown;
  try {
    fields = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const f = fields as Record<string, unknown>;
  const source: PageSource = {
    url: f.u as string,
    recipe: { item: f.i as string, title: f.t as string, link: f.l as string, ...(f.d === undefined ? {} : { date: f.d as string }) },
    fixEncoding: f.e === 1,
  };
  // Written back in the one form the writer makes, it must be the same text: no other keys, no other order, no other values.
  return documentOf(source) === text ? source : null;
}

/** XPathBridge reads each expression through `urldecode` once more, so what is a plain character for it is written the way it would write it. */
const forXPathBridge = (expression: string): string => expression.replace(/%/g, "%25").replace(/\+/g, "%2B");

/** The parameters RSS-Bridge's XPathBridge is asked with: the page, the item, its title, link and date, and the character-set repair when the page needs it. */
export function pageBridgeParams(source: PageSource): Record<string, string> {
  const { recipe } = source;
  return {
    url: source.url,
    item: forXPathBridge(recipe.item),
    title: forXPathBridge(recipe.title),
    uri: forXPathBridge(recipe.link),
    ...(recipe.date === undefined ? {} : { timestamp: forXPathBridge(recipe.date) }),
    ...(source.fixEncoding ? { fix_encoding: "on" } : {}),
  };
}

/**
 * The identity of a post: its canonical address, the way the detector writes it for the samples it shows. The one thing the
 * address alone does not say is a changelog's entries, which are headings of the page itself: the heading's fragment is kept then.
 */
export function pagePostId(source: PageSource, link: URL): string | null {
  if (link.protocol !== "http:" && link.protocol !== "https:") return null;
  const id = canonicalUrl(link.href);
  if (id.length > 1000) return null;
  return `page:${id}${keepsFragment(source, link) ? link.hash : ""}`;
}

/** Whether a post's address is a heading of the page itself, which is all that tells a changelog's entries apart. */
export function keepsFragment(source: PageSource, link: URL): boolean {
  return link.hash.length > 1 && canonicalUrl(link.href) === canonicalUrl(source.url);
}

/** What a source with no name of its own is called: the page's site. */
export function pageHost(source: PageSource): string {
  return new URL(source.url).hostname.replace(/^www\./, "");
}

/**
 * Whether a page's text has to be repaired for PHP's HTML reader, which takes a page that names no character set for Latin-1: the page is
 * UTF-8 with letters outside ASCII (UTF-8 read as Latin-1 is what XPathBridge's `fix_encoding` undoes). A page of plain ASCII needs nothing,
 * and repairing a page that is not UTF-8 would break it.
 */
export function needsCharsetRepair(body: Uint8Array): boolean {
  if (!body.some((byte) => byte >= 0x80)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body, { stream: true });
    return true;
  } catch {
    return false;
  }
}
