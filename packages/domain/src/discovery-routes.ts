/*
 * Which way discovery found a source (its route), and how the person got to the lookup (its entry). Both are closed lists of short, stable
 * ids: the administrator reads them in the Service health page's "Discovery routes" table to see which routes are used and which could
 * go, so an id is never reused for something else, and a route that is removed from the code is removed from this list too.
 * A route is kept with the preview on the server and with the source that was followed; it is never sent to the browser or an assistant.
 */

/**
 * Every way `discover()` produces a candidate, and every candidate carries exactly one. Grouped as the lookup runs.
 */
export const DISCOVERY_ROUTES = [
  // The pasted address itself.
  /** The address is a feed. */
  "feed-address",
  // Found on the page that was pasted.
  /** A feed the page advertises (`<link rel="alternate">`). */
  "alternate-link",
  /** A link on the page that looks like a feed's address. */
  "page-anchor",
  /** A feed address the page shows for copying (an input's value, a copy button's text, a lone address in code). */
  "copy-address",
  /** A feed named on a page of the site's feeds ("RSS feeds"), which the pasted page links to or a feed-looking address answered with. */
  "listed-feed",
  // The site's usual addresses, guessed.
  /** A section's own conventional feed address (`/category/x/feed`), for a section page. */
  "section-path",
  /** The site's conventional feed addresses (`/feed`, `/rss`, `/atom.xml`…). */
  "conventional-path",
  /** The longer list of conventional addresses (`/rss.php`, `/blog/feed`…). */
  "more-paths",
  /** A Discourse forum's latest topics (`/latest.rss`). */
  "discourse-latest",
  // Services whose feed addresses follow a fixed pattern, made from the pasted address (known-feeds.ts, services.ts).
  "known:github",
  "known:apple-podcasts",
  "known:guardian",
  "known:substack",
  "known:medium",
  "known:tumblr",
  "known:blogger",
  "known:wordpress",
  "known:vimeo",
  "known:pinterest",
  "known:steam",
  "known:arxiv",
  "known:dailymotion",
  "known:odysee",
  "known:deviantart",
  "known:peertube",
  "known:behance",
  "known:nos",
  "known:bbc",
  "known:presscorner",
  "known:rijksoverheid",
  // Journals.
  /** A journal on its publisher's platform, whose feed is made from the journal's address or code (Wiley, Taylor & Francis, SAGE…). */
  "journal-platform",
  /** A publisher's feed made from an ISSN, which the page's metadata, a DOI's Crossref record or the person gave. */
  "journal-issn",
  /** An Open Journal Systems journal's announcements feed, next to its articles. */
  "journal-ojs",
  // Registries, asked when the page gave nothing.
  /** A feed Wikidata lists for the site. */
  "wikidata",
  /** A journal's registered articles, read from Crossref through the router. */
  "crossref",
  // Accounts and channels.
  "youtube",
  /** A Mastodon or other fediverse account's feed. */
  "fediverse",
  "bluesky",
  // Source bridges (bridges.ts), for a bridged service's own address or a bridge descriptor. One id per service of the catalogue.
  "bridge:telegram",
  "bridge:bandcamp",
  "bridge:soundcloud",
  "bridge:twitch",
  "bridge:mixcloud",
  "bridge:rutube",
  "bridge:applemusic",
  "bridge:instagram",
  "bridge:mangadex",
  "bridge:vkvideo",
  "bridge:crossref",
  "bridge:page",
  // Reading what the page shows or loads when it has no feed.
  /** A list of posts the page itself shows, read from its layout (page-lists.ts). */
  "page-list",
  /** A feed address the page's own scripts name (script-scan.ts); the scripts are read as text, never run. */
  "script-feed",
  /** A list of posts on a page of the same site that the page's scripts name (script-scan.ts). */
  "script-page",
  // This installation.
  /** This installation's own news (its address or its feed). */
  "installation-news",
] as const;
export type DiscoveryRoute = (typeof DISCOVERY_ROUTES)[number];

type BridgeIdOf<T> = T extends `bridge:${infer S}` ? S : never;
/** The ids of the bridged services the routes name: the catalogue's services are typed by it, so a service the routes don't name does not compile. */
export type BridgeServiceId = BridgeIdOf<DiscoveryRoute>;

const ROUTES: ReadonlySet<string> = new Set(DISCOVERY_ROUTES);
export const isDiscoveryRoute = (v: unknown): v is DiscoveryRoute => typeof v === "string" && ROUTES.has(v);

/**
 * How the person got to the lookup. `paste`: Add source with a link; `site-search` and `podcast-search`: a result chosen from the name
 * search; `suggestion`: a source suggested on the Discovery page; `shared-link`: a link shared to the app or opened as a link to it;
 * `opml-import`: a list of feeds imported; `extension` and `assistant`: the browser extension and an assistant connected over MCP.
 */
export const DISCOVERY_ENTRIES = ["paste", "site-search", "podcast-search", "suggestion", "shared-link", "opml-import", "extension", "assistant"] as const;
export type DiscoveryEntry = (typeof DISCOVERY_ENTRIES)[number];

const ENTRIES: ReadonlySet<string> = new Set(DISCOVERY_ENTRIES);
export const isDiscoveryEntry = (v: unknown): v is DiscoveryEntry => typeof v === "string" && ENTRIES.has(v);

/**
 * What the browser says about a lookup (`POST /api/discover`'s `entry`). Only the entries the interface itself starts can be named
 * there; `reconnect` is a lookup for a private source's link, which follows nothing and is not counted. The others are decided by the
 * server (the extension's token, an assistant, an import).
 */
export const LOOKUP_ENTRIES = ["paste", "site-search", "podcast-search", "suggestion", "shared-link", "reconnect"] as const;
export type LookupEntry = (typeof LOOKUP_ENTRIES)[number];
