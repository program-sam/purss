/*
 * Choosing and naming the feeds found on a page. Pure functions, so every rule can be tested
 * without a network: which feed a section page really means, what a feed is called when it
 * calls itself "Feed" or "Nieuws", which candidates are noise next to the posts feed.
 */

// ---------- names ----------

/** Titles that say nothing at all about the source. */
const NOISE = /^(?:[»›|:-]\s*)?(?:rss|atom|feed|rss feed|atom feed|rss 2\.0|home|index|untitled|latest)$/i;
/** Section labels: fine after a site's name ("RTV Utrecht – Nieuws"), meaningless alone. */
const LABEL = new RegExp(
  `^(?:${[
    "posts?", "news", "nieuws", "blog", "articles?", "artikelen", "updates?", "latest news", "headlines", "actueel", "nachrichten", "aktuelles", "actualit[ée]s", "noticias", "notizie",
    "stories", "berichten", "laatste nieuws", "recent posts", "new posts", "all posts", "front ?page", "top stories", "topnieuws", "algemeen", "general", "featured",
    "sport", "sports", "politics", "politiek", "economy", "economie", "business", "culture", "cultuur", "tech", "technology", "opinion", "world", "wereld", "regio", "local", "lokaal", "binnenland", "buitenland",
  ].join("|")})$`,
  "i",
);
/** "Comments for X", "Comments on: X", "Reacties op X". */
const COMMENTS = /^(?:comments?|reacties|reactions?|replies)(?:\s+(?:for|on|op|voor|to))?\s*:?\s*(.*)$/i;
/** WordPress names a feed link "Site » Feed" or "Site » Comments Feed". */
const DECORATED = /^(.*?)(?:\s+[–—-]\s+|\s*[»›|]\s*)(?:rss|atom|feed|rss feed|atom feed)$/i;

export function isGenericTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || NOISE.test(t) || LABEL.test(t);
}

/** The title with feed decorations removed ("Site » Feed" → "Site"); "" when nothing is left. */
function undecorated(title: string | null | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = DECORATED.exec(t);
  return m ? m[1]!.trim() : t;
}

/** Words a machine put around a name: "Subscribe via RSS", "Subscribe to X", "RSS feed for X". */
const MACHINE_HEAD = /^(?:subscribe(?:\s+(?:via|to|with|using))?|rss\s+feed\s+(?:of|for|from)|atom\s+feed\s+(?:of|for|from))\s+/i;
/** "QC RSS v2", "BBC Sport RSS feed", "Nature - RSS 2.0". */
const MACHINE_TAIL = /(?:\s*[-–—:|»›]\s*|\s+)\(?(?:rss(?:\s+(?:feed|v?\d+(?:\.\d+)*))*|atom(?:\s+(?:feed|v?\d+(?:\.\d+)*))+)\)?$/i;
/** GitHub's feed titles: "Release notes from node", "Tags from sqlite". */
const FROM_REPO = /^(release notes|releases|tags|commits)\s+from\s+(.+)$/i;

/**
 * A feed's own title without the words a machine put around it ("QC RSS v2" → "QC", "Release notes from node" →
 * "node releases", "Subscribe via RSS" → ""). "" when nothing meaningful is left.
 */
export function tidyFeedName(title: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  const repo = FROM_REPO.exec(t);
  if (repo) return `${repo[2]!.trim()} ${/^tags$/i.test(repo[1]!) ? "tags" : /^commits$/i.test(repo[1]!) ? "commits" : "releases"}`;
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(MACHINE_HEAD, "").replace(MACHINE_TAIL, "").trim();
    if (t === before) break;
  }
  return NOISE.test(t) ? "" : t;
}

function withSite(label: string, site: string | null, host: string): string {
  const base = site || host;
  return base.toLowerCase().includes(label.toLowerCase()) ? base : `${base} – ${label}`;
}

/**
 * What to call a feed. A specific title is kept; "Feed", "» Feed" and the like become the
 * site's name; a bare section label such as "Nieuws" becomes "<site> – Nieuws".
 */
export function nameFeed(input: { feedTitle?: string | null; linkTitle?: string | null; siteName?: string | null; host: string }): string {
  const site = input.siteName?.trim() || null;
  for (const raw of [input.feedTitle, input.linkTitle]) {
    const decorated = undecorated(raw);
    const t = tidyFeedName(decorated);
    if (!t) continue;
    // What is left of a machine name can be a bare abbreviation ("QC"); the site's own name says more.
    if (t !== decorated && site && t.length <= 3 && !site.toLowerCase().includes(t.toLowerCase())) return site;
    const c = COMMENTS.exec(t);
    if (c) return withSite("comments", c[1]!.trim() || site, input.host);
    if (NOISE.test(t)) continue;
    if (LABEL.test(t)) return withSite(t, site, input.host);
    return t;
  }
  return site || input.host;
}

/**
 * The site's own name from what its page says about itself: `og:site_name` or the
 * application name, else the part of the page title that matches the host ("France | The
 * Guardian" on theguardian.com; "Het laatste nieuws - RTV Utrecht" on rtvutrecht.nl).
 */
export function siteNameFor(facts: { siteName: string | null; title: string | null }, pageUrl: string): string | null {
  if (facts.siteName) return facts.siteName;
  const title = facts.title?.trim();
  if (!title) return null;
  const parts = title.split(/\s+[|–—·-]\s+|\s*[|·]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let core = "";
  try {
    const labels = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "").split(".");
    core = (labels.length > 2 ? labels.at(-3)! : labels[0]!).replace(/[^a-z0-9]/g, "");
  } catch {
    return null;
  }
  const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const match = parts.find((p) => core.length >= 3 && letters(p).length >= 3 && (letters(p) === core || letters(p).startsWith(core) || core.startsWith(letters(p))));
  if (match) return match;
  // No part names the host: a front page leads with the brand, a section page ends with it.
  return sectionPath(pageUrl) ? parts.at(-1)! : parts[0]!;
}

/**
 * What a section's feed is called when its title is only the site's name ("BBC Sport" for the Liverpool page):
 * the site and the section's own name from the page title ("Liverpool - Football - BBC Sport" → "BBC Sport – Liverpool").
 * Null when the page title adds nothing.
 */
export function sectionFeedName(pageTitle: string | null | undefined, siteName: string): string | null {
  const parts = (pageTitle ?? "").split(/\s+[|–—·-]\s+|\s*[|·]\s*/).map((p) => p.trim()).filter(Boolean);
  const letters = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const site = letters(siteName);
  const label = parts.find((p) => letters(p) && letters(p) !== site && !letters(p).includes(site) && !site.includes(letters(p)));
  if (!label || label.length > 60 || isGenericTitle(label)) return null;
  return `${siteName} – ${label}`;
}

/** True when two names are the same apart from case, spacing and punctuation. */
export function sameName(a: string, b: string): boolean {
  const letters = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return letters(a) !== "" && letters(a) === letters(b);
}

/**
 * The part of a source's name that says what it is, for comparing sources: "Football Weekly | The Guardian" and
 * "Football Weekly" are the same show. The text before the first " | ", " – ", " - " or " · ".
 */
export function coreName(title: string): string {
  const head = title.split(/\s+[|–—·-]\s+|\s*[|·]\s*/)[0] ?? title;
  return head.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// ---------- which of several feeds is the page's own ----------

const GENERIC_TOKENS = new Set(["feed", "feeds", "rss", "atom", "xml", "index", "www", "com", "org", "net", "html", "htm", "php", "json", "rss2", "default", "http", "https"]);

const tokensOf = (value: string): string[] =>
  value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !GENERIC_TOKENS.has(t));

/**
 * Does a feed that was listed on or next to a page belong to that very page? Its name is the page's title ("Nursing
 * Standard" for the page titled that), or the words of the last part of the page's address appear, whole and in order, in
 * the feed's address (`/journal/ns` and `/feeds/ns`; `/journal/nursing-standard` and `/feeds/nursing-standard`). A site's front page has nothing to match, so nothing matches there.
 */
export function linkMatchesPage(link: { url: string; title?: string | null }, page: { url: string; title?: string | null }): boolean {
  const letters = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const title = letters(link.title ?? "");
  if (title.length >= 4) {
    const names = [page.title ?? "", ...(page.title ?? "").split(/\s+[|–—·-]\s+|\s*[|·]\s*/)].map(letters).filter((n) => n.length >= 4);
    if (names.some((n) => n === title)) return true;
  }
  let slug: string[] = [];
  let linkTokens: string[] = [];
  try {
    const segments = new URL(page.url).pathname.split("/").filter(Boolean);
    slug = tokensOf(decodeURIComponent(segments.at(-1) ?? "").replace(/\.(?:html?|php|aspx?)$/i, ""));
    const feed = new URL(link.url);
    linkTokens = tokensOf(`${feed.pathname}${feed.search}`);
  } catch {
    return false;
  }
  return slug.join("").length >= 2 && containsRun(linkTokens, slug);
}

/** True when `run` appears in `list` as consecutive items, in order. */
function containsRun(list: string[], run: string[]): boolean {
  for (let i = 0; i + run.length <= list.length; i++) if (run.every((t, k) => list[i + k] === t)) return true;
  return false;
}

/** Links that belong to the page first, so a cut-off list keeps them. Stable. */
export function rankByPage<T extends { url: string; title?: string | null }>(links: T[], page: { url: string; title?: string | null }): T[] {
  return links
    .map((l, i) => ({ l, i, m: linkMatchesPage(l, page) ? 0 : 1 }))
    .sort((a, b) => a.m - b.m || a.i - b.i)
    .map((x) => x.l);
}

// ---------- sections ----------

const ROOTISH = /^(?:index(?:\.\w+)?|home|default\.\w+|[a-z]{2}(?:[-_][a-z]{2,4})?)$/i;

/** The path of a page that is part of a site rather than its front page ("/world/france"), or null. */
export function sectionPath(pageUrl: string): string | null {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return null; }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0 || (segments.length === 1 && ROOTISH.test(segments[0]!))) return null;
  return `/${segments.join("/")}`.replace(/\.(?:html?|php|aspx?)$/i, "");
}

/** Conventional places for a section's own feed, most likely first. */
export function sectionFeedPaths(path: string): string[] {
  return ["/rss", "/feed", "/rss.xml", "/feed.xml", "/atom.xml"].map((suffix) => `${path}${suffix}`);
}

/** The conventional paths of a site-wide feed. */
export const SITE_FEED_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/rss.xml", "/index.xml"];
/** Less common but still conventional: webcomic, blog and publisher software that puts the feed one folder down or names it after its format. */
export const MORE_FEED_PATHS = ["/rss.php", "/comic/rss", "/comic/feed", "/blog/feed", "/blog/rss", "/blog/rss.xml", "/blog/feed.xml", "/news/rss", "/news/feed", "/xml/rss2_0.xml", "/atom", "/feed.rss"];
const SITE_WIDE = new Set([...SITE_FEED_PATHS, ...MORE_FEED_PATHS, "/feed/atom", "/feed/rss", "/feed/rss2", "/feed/rdf", "/rss2", "/index.rss", "/feeds/posts/default", "/posts.rss", "/latest.rss"]);

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

export const WHOLE_SITE_NOTE = "This is the feed for the whole site, not just this page or section.";
export const WHOLE_SITE_FALLBACK_NOTE = "The feed for just this page or section didn't answer, so this is the whole site's feed.";

/** True when a feed covers the whole site although the page it was found from is a section or article. */
export function isSiteWideFeed(feedUrl: string, pageUrl: string): boolean {
  const section = sectionPath(pageUrl);
  if (!section) return false;
  let feed: URL;
  try { feed = new URL(feedUrl); } catch { return false; }
  if (bareHost(feed.hostname) !== bareHost(new URL(pageUrl).hostname)) return false;
  const path = feed.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  if (path.startsWith(`${section.toLowerCase()}/`)) return false;
  // PeerTube's feed of every video on the instance; with an account or channel in the query it is that one's.
  if (path === "/feeds/videos.xml") return feed.search === "";
  return SITE_WIDE.has(path) || (path === "/" && /(?:^|&)feed=/.test(feed.search.slice(1)));
}

/** Query parameters that say how to write the answer, not what to answer about. */
const FORMAT_PARAMS = new Set(["format", "feed", "type", "alt", "output", "view", "fmt", "mode", "media", "do", "action", "page", "rss", "atom"]);
/** Path words that introduce a name: `/users/atom`. */
const NAME_WORDS = new Set(["user", "users", "u", "profile", "profiles", "people", "person", "member", "members", "author", "authors", "channel", "channels", "creator", "creators", "artist", "artists", "account", "accounts"]);

/**
 * Did asking for a conventional address (`/atom.xml`) end at a thing the site looked up by that word? Some sites read the first
 * word of any path as a name and send it to that person's page or feed: Behance answers `/atom.xml` with the feed of the user
 * "atom". That is not the site's feed. The same address on the same site (https, www, a trailing slash, extra query noise) and
 * any other path that does not carry the asked-for word as a name (`/feed` → `/feed/atom/`, `/blog/feed`) are not lookups, and
 * neither is a feed the site keeps on another host (Feedburner).
 */
export function probeLandedOnName(asked: string, landed: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(asked);
    b = new URL(landed);
  } catch {
    return false;
  }
  const decode = (v: string) => { try { return decodeURIComponent(v).toLowerCase(); } catch { return v.toLowerCase(); } };
  const stem = decode(a.pathname.split("/").filter(Boolean).at(-1) ?? "").replace(/\.[a-z0-9]{1,5}$/, "");
  if (!stem) return false;
  const trimmed = (u: URL) => u.pathname.replace(/\/+$/, "").toLowerCase();
  if (bareHost(a.hostname) === bareHost(b.hostname) && trimmed(a) === trimmed(b)) return false;
  for (const [key, value] of b.searchParams) if (!FORMAT_PARAMS.has(key.toLowerCase()) && value.toLowerCase() === stem) return true;
  const segments = b.pathname.split("/").filter(Boolean).map((seg) => decode(seg).replace(/\.[a-z0-9]{1,5}$/, ""));
  return segments.some((seg, i) => seg === `@${stem}` || (seg === stem && i > 0 && NAME_WORDS.has(segments[i - 1]!)));
}

// ---------- order ----------

const ORDER = ["Latest topics", "Posts feed", "Releases feed", "Podcast feed", "Channel feed", "Playlist feed", "Section feed", "Tags feed", "Whole site feed", "All replies", "Comments feed"];

export function viaRank(via: string): number {
  const i = ORDER.indexOf(via);
  return i === -1 ? 1 : i;
}

/** Stable order by kind of feed. */
export function orderByVia<T extends { via: string }>(list: T[]): T[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => viaRank(a.c.via) - viaRank(b.c.via) || a.i - b.i)
    .map((x) => x.c);
}

/** Comment feeds are not offered when any other feed exists; alone they are shown, labelled. */
export function withoutCommentFeeds<T extends { via: string }>(list: T[]): T[] {
  const rest = list.filter((c) => c.via !== "Comments feed");
  return rest.length ? rest : list;
}

/** Discourse forums say so in their page head. */
export function isDiscourse(html: string): boolean {
  return /<meta[^>]+name=["']generator["'][^>]+content=["']Discourse/i.test(html) || /<meta[^>]+content=["']Discourse[^>]+name=["']generator["']/i.test(html) || /data-discourse-setup/i.test(html);
}
