import { sameSite } from "./hosts.ts";
import { mayBeCredentialParam, privateUrlReason } from "./privacy.ts";
import { MORE_FEED_PATHS, SITE_FEED_PATHS } from "./feed-choice.ts";

/*
 * What a page's own scripts say about where its posts are. When a page has no feed and nothing else found one, the scripts it loads are read
 * as text (never run) for two kinds of address: a feed the page doesn't link, and a page of the same site that shows the list of posts as
 * ordinary markup (a server-rendered "latest news" the page's own route belongs under). Everything here is a pure rule over text; reading
 * the scripts, asking for what they name and judging the answers is discover.ts's.
 *
 * Only what a measurement over 58 script-built list pages (56 scored) found worth keeping is here: feed addresses written out in a script,
 * feeds on an API root the scripts name, and same-site pages the scripts name. JSON endpoints, lists inside the page's own data, content
 * management systems' interfaces and the scripts a script loads later are left alone: they need a source that PURSS doesn't have.
 */

/** At most this many script files are read, and this many bytes of them (one file at most `SCRIPT_FILE_BYTES`). */
export const SCRIPT_FILES = 10;
export const SCRIPT_BYTES = 3 * 1024 * 1024;
export const SCRIPT_FILE_BYTES = 2 * 1024 * 1024;
/** Of the addresses the scripts name, at most this many are asked for as feeds, and this many as pages: eight in all. */
export const SCRIPT_FEEDS = 6;
export const SCRIPT_SIBLINGS = 2;
/** Inline scripts are read from the page already in hand: each up to this many characters, and this many in all. */
const INLINE_EACH = 600_000;
const INLINE_ALL = 1_500_000;

// ---------- which scripts are read ----------

const tagAttr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const decodeAmp = (s: string): string => s.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/");

/** Files named by `<script src>` and by script preloads. */
const VENDOR = /(jquery|polyfill|runtime|framework|react(-dom)?|vue(\.runtime)?|angular|zone\.js|lodash|moment|gtm|gtag|analytics|hotjar|sentry|datadog|segment|optimizely|onetrust|cookiebot|consent|recaptcha|adobedtm|launch-|newrelic|facebook|fbevents|twitter|linkedin|clarity|polyfills|webpack-[0-9a-f]{8}|bootstrap|swiper|slick|core-js|tslib|rxjs|hydration)/i;

/**
 * The script files the page loads from its own site (its registrable domain, so a CDN subdomain counts and another company's host does not),
 * the likeliest to name a list first: those with a word of the page's own address in their name, and those that look like a page's code, before
 * libraries. Never more than `SCRIPT_FILES` are read; the order is for the caller to cut.
 */
export function scriptFiles(html: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const found = new Set<string>();
  const add = (raw: string | null) => {
    if (!raw) return;
    try {
      const u = new URL(decodeAmp(raw), page);
      if ((u.protocol === "https:" || u.protocol === "http:") && sameSite(u.hostname, page.hostname)) { u.hash = ""; found.add(u.href); }
    } catch { /* not an address */ }
  };
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) add(tagAttr(m[0], "src"));
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (tagAttr(m[0], "rel") ?? "").toLowerCase();
    if (rel === "modulepreload" || (rel === "preload" && (tagAttr(m[0], "as") ?? "").toLowerCase() === "script")) add(tagAttr(m[0], "href"));
  }
  const words = pageWords(page);
  const rank = (u: string): number => {
    const url = new URL(u);
    const path = url.pathname.toLowerCase();
    let score = url.origin === page.origin ? 20 : 0;
    if (VENDOR.test(path)) score -= 40;
    if (/(\/pages?\/|\/app\/|\/routes?\/|\/views?\/|\/chunks?\/|main|app|index|list|news|blog|search|overview|feed)/.test(path)) score += 15;
    for (const w of words) if (path.includes(w)) score += 25;
    return score;
  };
  return [...found].map((u, i) => ({ u, i, s: rank(u) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.u);
}

/** The text of the page's inline scripts (JSON-LD and application data included: they name pages too), bounded. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  let total = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!) || m[2]!.length <= 40) continue;
    const text = m[2]!.slice(0, INLINE_EACH);
    if (total + text.length > INLINE_ALL) break;
    total += text.length;
    out.push(text);
  }
  return out;
}

/** Words of an address that say nothing about what is on the page. */
const PLAIN_WORDS = new Set(["index", "html", "home", "default", "page", "pages", "php", "aspx", "main"]);

/** Words of four letters or more in a path: what a script's file or an address it names shares with the page. */
function pathWords(path: string): string[] {
  return path.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !PLAIN_WORDS.has(w));
}
const pageWords = (page: URL): string[] => pathWords(page.pathname);

/** Whether a path says what the page says: a word of the page's path, or a longer word that starts with it (`news`, `newsroom`), not one that merely contains it (`search`, `research`). */
function sharesAWord(words: readonly string[], path: string): boolean {
  const theirs = pathWords(path);
  return words.some((w) => theirs.some((t) => t === w || (t.length > w.length ? t.startsWith(w) : w.startsWith(t))));
}

// ---------- what is read out of a script ----------

const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|zip|wasm)(\?|#|$)/i;
const NOISE = /(schema\.org|w3\.org|localhost|example\.(com|org)|googleapis\.com|gstatic|google-analytics|googletagmanager|doubleclick|facebook\.|twitter\.com|linkedin\.com|youtube\.com|youtu\.be|github\.com\/|npmjs|reactjs\.org|nextjs\.org\/docs|mozilla\.org|webpack|unpkg|jsdelivr|cdnjs|sentry|apple\.com\/|openstreetmap|creativecommons|xmlns|\/locales?\/|\/i18n\/|\/translations?\/|\/lang\/|manifest\.json|package\.json|tsconfig|sitemap|robots|favicon|opensearch|oembed|\.well-known)/i;
/** The shapes of a feed's address. */
const FEED_PATH = /(\/(rss|feeds?|atom)(\/|\.|\?|$)|\.(rss|atom)(\?|$)|(^|\/)(rss|feed|atom|index)\.(xml|json)(\?|$)|api\/rss|\/rss\.xml|feed\.json|\/feed\/?(\?|$))/i;
/** Not a page of posts: an interface the scripts call, or a file. */
const NOT_A_PAGE = /(^|\/)(api|wp-json|graphql|rest|papi|site-api|_api|apis|rpc|elastic|jsonapi|odata|cms|_next|_nuxt|static|assets|ajax|cdn-cgi|wp-admin|wp-includes|wp-content|v\d+(\.\d+)?|[\w-]*-api)(\/|\.|$)|\.(json|xml|txt)$/i;
/** The usual conventional feed addresses were asked for already when a lookup gets here. */
const ASKED = new Set([...SITE_FEED_PATHS, ...MORE_FEED_PATHS]);

/** A script's text with its JSON and URL escapes undone, so an address written out reads as one; null when it still isn't an address. */
function cleanAddress(raw: string): string | null {
  let s = raw.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
  if (/[\s\\<>{}`^|]|\$\{|%s|undefined|null|\[object|%7B|%7D/.test(s)) return null;
  s = s.replace(/[?&][A-Za-z0-9_\-[\]]+=$/g, "").replace(/[?&]$/, "").replace(/[.,;:]+$/, "");
  if (s.length < 4 || s.length > 300) return null;
  if (ASSET.test(s) || NOISE.test(s)) return null;
  return s;
}

/**
 * Whether an address carries a key: a parameter named like one (`key`, `token`, `hash`, `sha256`, `client_id`, `signature`…) whatever its
 * value, one the privacy rules take for a credential, or a path that looks to hold one. Such an address is never asked for and never offered:
 * it would be kept, exported and logged as the source's address.
 */
export function carriesAKey(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    const bare = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^(?:.*(?:key|token|hash|signature|secret)|sha\d+|sig|clientid|auth)$/.test(bare) || mayBeCredentialParam(name, value)) return true;
  }
  return privateUrlReason(url.href) !== null;
}

/** An address named in a script, as a web address of the page's site or another host, or null when it is none. */
function resolve(raw: string, page: URL): URL | null {
  const s = cleanAddress(raw);
  if (!s) return null;
  let u: URL;
  try {
    if (s.startsWith("//")) u = new URL(`${page.protocol}${s}`);
    else if (/^https?:/i.test(s)) u = new URL(s);
    else if (s.startsWith("/")) u = new URL(s, page.origin);
    else if (/^(api|wp-json|rss|feeds?)\b/.test(s)) u = new URL(`/${s}`, page.origin);
    else return null;
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  u.hash = "";
  return u;
}

const isFeedAddress = (u: URL): boolean => (FEED_PATH.test(u.pathname + u.search) && !/\.json$/i.test(u.pathname)) || /feed\.json$/i.test(u.pathname) || /(^|[/._-])rss([/._-]|$)/i.test(u.pathname);

/** What an address is worth asking for: the page's own words and a list's words in it, and what says it is not a list. */
function worth(u: URL, kind: "feed" | "page", page: URL, words: string[]): number {
  const path = u.pathname.toLowerCase();
  let score = kind === "feed" ? 100 : 50;
  if (sameSite(u.hostname, page.hostname)) score += 20;
  if (u.origin === page.origin) score += 10;
  for (const w of words) if (path.includes(w)) score += 25;
  if (/(news|nieuws|post|article|blog|jobs?|vacanc|events?|release|changelog|press|latest|recent|publication)/i.test(path)) score += 15;
  if (/\/(\d{3,}|[0-9a-f]{16,})(\/|$)/.test(path)) score -= 40; // a record, not a list
  if (/(detail|single|by-id|byid|slug|related|comment|author|tag|category|menu|nav|footer|header|config|settings|translation|session|login|auth|user|(?:^|\/)me(?:\/|$)|analytics|track|collect|beacon|log\b|metrics|consent|cookie)/i.test(path)) score -= 30;
  return score;
}

/** A path without its language folder (`/fr/news` → `/news`), to tell a page's own language versions from its siblings. */
const withoutLanguage = (path: string): string => path.replace(/^\/[a-z]{2}(?:[-_][A-Za-z]{2,4})?(?=\/|$)/, "").replace(/\/+$/, "") || "/";

/** `fromMarkup`: named only in the page's own markup, not in any of its scripts. */
export type ScriptAddress = { url: string; kind: "feed" | "page"; score: number; fromMarkup?: boolean };

/**
 * The addresses the scripts name, best first. Feeds: an address written out that looks like a feed's (`/feed/rss/nieuws/`, `/api/rss`), and a
 * feed route a script builds on an API root it names (`${base}/rss` with `…/api` written elsewhere in the scripts). Pages: any other address of the
 * page's own site that is not an interface or a file, not the page itself or its language version, not the site's front page, and whose address
 * shares a word with the page's (`/latest` for `/latest/news`, `/en/search-publications` for `/en/publications`). An address that carries a key is dropped.
 */
export function namedAddresses(texts: readonly string[], pageUrl: string): { feeds: ScriptAddress[]; pages: ScriptAddress[] } {
  const page = new URL(pageUrl);
  const words = pageWords(page);
  const own = withoutLanguage(page.pathname);
  const found = new Map<string, ScriptAddress>();
  const put = (u: URL, kind: "feed" | "page", bonus = 0) => {
    if (carriesAKey(u)) return;
    const key = `${kind}:${u.origin.replace(/^(https?:\/\/)www\./, "$1")}${u.pathname.replace(/\/+$/, "")}`;
    const score = worth(u, kind, page, words) + bonus;
    if (!found.has(key) || found.get(key)!.score < score) found.set(key, { url: u.href, kind, score });
  };
  const literal = (raw: string) => {
    const u = resolve(raw, page);
    if (!u) return;
    if (isFeedAddress(u)) {
      if (!(u.origin === page.origin && ASKED.has(u.pathname) && !u.search)) put(u, "feed");
      return;
    }
    // A page: of this site, not an interface, and not the page or its own language version, nor the front page.
    if (!sameSite(u.hostname, page.hostname) || NOT_A_PAGE.test(u.pathname)) return;
    const path = withoutLanguage(u.pathname);
    if (path === "/" || path === own) return;
    // A page of the site that the scripts happen to name is only a sibling when its address is about what the page is about.
    if (!sharesAWord(words, u.pathname)) return;
    put(u, "page");
  };
  for (const text of texts) {
    for (const m of text.matchAll(/https?:(?:\\?\/){2}(?:[^\s"'`<>\\)}\]]|\\\/|\\u002[fF]){4,300}/g)) literal(m[0]);
    for (const m of text.matchAll(/["'`](\/{1,2}[A-Za-z0-9_\-./~%@:+,;=?&[\]]{3,300}|(?:api|wp-json|rss|feeds?)\/[A-Za-z0-9_\-./~%@:+,;=?&[\]]{0,200})["'`]/g)) literal(m[1]!);
  }
  for (const u of feedsOnApiRoots(texts, page)) put(u, "feed", 15);
  const ranked = [...found.values()].sort((a, b) => b.score - a.score);
  return { feeds: ranked.filter((a) => a.kind === "feed"), pages: ranked.filter((a) => a.kind === "page") };
}

/**
 * A feed route a script builds on a base it does not write out (`` `${this.apiUrl}rss?language=${l}` ``), tried on the API roots the scripts do write
 * out: an address that ends in `/api`, `/rest` or `/wp-json` of the page's site, or a configured `apiUrl: "https://…"`. At most three roots and three routes.
 */
function feedsOnApiRoots(texts: readonly string[], page: URL): URL[] {
  const routes = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/`\$\{([^}`]{1,60})\}\/?((?:[\w-]+\/){0,3}(?:rss|feeds?|atom))(?:\.xml)?(?=[?/`])/gi)) {
      if (/(url|base|host|endpoint|root|origin|api|server|service)/i.test(m[1]!)) routes.add(m[2]!);
    }
  }
  if (!routes.size) return [];
  const roots = new Set<string>();
  const addRoot = (raw: string) => {
    try {
      const u = new URL(raw, page.origin);
      if ((u.protocol === "https:" || u.protocol === "http:") && sameSite(u.hostname, page.hostname) && !u.search && !carriesAKey(u)) roots.add(`${u.origin}${u.pathname.replace(/\/+$/, "")}`);
    } catch { /* not an address */ }
  };
  for (const text of texts) {
    for (const m of text.matchAll(/["'`]((?:https?:\/\/[\w.-]+)?(?:\/[\w.-]+)*\/(?:api|rest|papi|site-api|wp-json|services?)(?:\/v\d+)?)\/?["'`]/g)) addRoot(m[1]!);
    for (const m of text.matchAll(/["']?[A-Za-z_$][\w$-]*?(?:api|backend|endpoint|baseurl|base_url|service)[\w$-]*["']?\s*[:=]\s*["'`](https?:\/\/[^"'`\s]{6,200})["'`]/gi)) addRoot(m[1]!);
  }
  const out: URL[] = [];
  for (const root of [...roots].slice(0, 3)) {
    for (const route of [...routes].slice(0, 3)) {
      const u = resolve(`${root}/${route}`, page);
      if (u && isFeedAddress(u)) out.push(u);
    }
  }
  return out;
}

/** An address as a reader shows it: the host and path, without the scheme, `www.` or a trailing slash. */
export function readableAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}
