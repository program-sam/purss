# Connectors

Safe fetching, source discovery, feed parsing, readable capture, OPML and the connector
catalog. Recurring collection stays in FreshRSS; nothing here polls feeds. Everything is
exported from `src/index.ts`, except the icon resolver: it loads the native image library
(sharp), so only the worker imports it, from `@purss/connectors/icons`.

[Sources](../../docs/sources.md) describes what discovery does with a pasted link, from input
to candidates, and what the bridge, Crossref, registry and big-feed pieces mean for a source.
This page lists the modules.

| Module | What it does |
| --- | --- |
| `safeFetch(url, opts)` | The only way to fetch a user- or feed-supplied URL. http/https only, no embedded credentials, DNS resolved and every address validated (one forbidden answer rejects the name), connection bound to the validated address, manual redirects (max 5, each hop re-validated, credential headers never forwarded), per-stage and overall timeouts, response cap enforced while streaming and after gzip/deflate/br, generic User-Agent, `AbortSignal`. A `sink` reads a body as a stream without holding it. Never throws: returns `{ ok: false, reason: blocked \| unreachable \| toolarge \| timeout \| invalid \| aborted, message, detail }`. |
| `classifyAddress`, `isBlockedPort`, `resolveDestination`, `boundLookup` | The address rules, shared with the egress proxy. |
| `parseFeed(body, contentType)` | RSS 2.0, RSS 1.0/RDF, Atom and JSON Feed to one shape (podcast and YouTube aware, bounded, robust). Throws `FeedParseError` for non-feeds. |
| `discover(input, opts)` | Pasted text to `DiscoveryResult` minus the server-held `token`: input normalisation (an email address and a name each get their own message), a `bridge:` descriptor, a DOI or an ISSN, a fediverse or Bluesky handle, YouTube, the pages of a bridged service, platforms that publish no feeds named at once (`platforms.ts`), known feed patterns for GitHub, Apple Podcasts, Substack (a publication, section, share link, or a profile's publications through Substack's public profile record, `substack.ts`), Medium, Tumblr, Blogger, WordPress.com, Vimeo and Pinterest (`known-feeds.ts`) and for Steam, arXiv, Dailymotion, Odysee, PeerTube, DeviantArt, Behance, NOS, the BBC, the European Commission's Press Corner and Rijksoverheid (`services.ts`), journal pages on the large publishing platforms (`journals.ts`), feed detection, alternate links, a section page's own feed before any site-wide guess (a site-wide feed is labelled *Whole site feed*), conservative path fallback that stops once the site is strained, one hop into a site's "RSS feeds" page (also one a feed-looking link or `/rss` answered with), feed addresses shown for copying, comment feeds left out beside a posts feed, feed names (`feed-choice.ts`), YouTube channel/handle/video/playlist (a single video also carries a *keep* offer), cadence over the recent days, three samples, summaries-only, private-URL warning. A feed bigger than the engine can read whole is marked `large` (`trimmed.ts`). When nothing else found a feed, the registry fallback asks Wikidata (`wikidata.ts`), and a journal's Crossref choice is added last (`crossref.ts`). A timeout or a busy site is never reported as "no feed". |
| `BRIDGE_SERVICES`, `bridgeDescriptor`, `parseBridgeDescriptor`, `bridgeTargetForPage`, `bridgeRoutePath` (`bridges.ts`) | The catalogue of bridged services (Telegram, Bandcamp, SoundCloud, Twitch, Mixcloud, Rutube, Apple Music, Instagram, MangaDex, VK Video, Crossref, page lists): key pattern, how a page address names a key, the post-id rule, clean-ups, and the HMAC signature of the router address that the worker and API make and the egress router checks. `bridgeKeyValid` is what a key must pass (its pattern and the service's own reading of it). `copyOnlyPicture` names the picture addresses that can be shown only from a stored copy (Instagram's). |
| `crossrefWorksUrl`, `crossrefWorksToRss`, `issnFromInput`, `issnPortalUrl`, `findCrossrefJournal` (`crossref.ts`) | A journal's registered articles as RSS (pure; run by the egress Crossref backend), and the lookups that find a journal by ISSN or name. |
| `journalFromUrl`, `journalFeedsFor`, `planFromIssns`, `doiFromInput`, `normalIssn` (`journals.ts`) | The feed addresses of a journal on Wiley, Taylor & Francis, Chicago, Berghahn, Project MUSE and ScienceDirect, made from its code or ISSN, and DOI and ISSN handling. |
| `addressVariants`, `wikidataSearchUrl`, `readWikidataEntities` (`wikidata.ts`) | The registry fallback's requests and readers: which Wikidata items have a page as their official website, and their feeds and ISSNs. Pure; discovery makes the requests through `safeFetch`. |
| `TRIM_FEED_BYTES`, `TRIM_FEED_ITEMS`, `TRIM_ITEMS`, `trimRoutePath`, `isLargeFeed` (`trimmed.ts`) | The size from which a feed goes through the egress feed gateway, the signed gateway address, and a streaming size check. The trimmer itself is in `apps/egress`. |
| `detectPageLists(html, pageUrl, now?, options?)`, `validateRecipe(recipe)`, `markupDeclaresCharset(html)` (`page-lists.ts`) | The repeating list of posts on a page that has no feed (a blog index, a news section, a changelog, a job board), found from the page's own markup and nothing else: JSON-LD, microformats and microdata first, then groups of links that sit in the same kind of place. Up to three lists come back, each with a score, a confidence (`high` only for a clearly best first list, `low` for a guess; with no list better than a guess a `diagnosis` says why: `appShell`, `emptyMain`, `noRepeatedLinks`), reason codes (words come from the copy catalog, not from here), its first items as read from the page, and a *recipe*: XPath 1.0 expressions (`item` absolute; `title`, `link` and an optional `date` relative to it) that RSS-Bridge's XPathBridge runs unchanged. `validateRecipe` accepts nothing but that grammar (class and attribute tests, child and descendant steps, `preceding-sibling::*[1]` and its kin, one union or one `concat`, at most 200 characters each: no `document()`, variable or extension function) and is what the bridge router checks before it runs a stored recipe. A date goes into a recipe only when PHP's `strtotime`, which XPathBridge uses, reads it as the page does; otherwise the feed dates posts by when they were first seen (`datesInRecipe`, reason `undated`). A list made only from structured data is offered as not portable (no recipe). `markupDeclaresCharset` says whether PHP's HTML loader will read a page in the right character set. Pure and bounded: nothing is fetched, pages over 2 MiB, non-HTML and markup too large or too deep to read are refused. |
| `encodePageKey`, `decodePageKey`, `pageBridgeParams`, `pagePostId`, `needsCharsetRepair` (`page-feeds.ts`) | A page list as a bridged source (`bridge:page/<key>`): the key is the page's address, the recipe and whether the page needs its character set repaired, as a compact JSON in a fixed order, deflated and written in base64url (at most 380 characters; the same recipe is the same key). Reading refuses anything the writer would not make (another form, an inflate over 4 KiB, an address that is not an http(s) address PURSS may fetch or looks to carry a key, an expression outside the grammar). `pageBridgeParams` is what XPathBridge is asked, with `%` and `+` written for the second `urldecode` it applies. `pagePostId` is `page:` and the canonical address `detectPageLists` writes for its samples. Discovery's last step previews up to three lists of the page it read through the router, offers those that read posts (`high` chosen for the person as the page's own, `medium` never chosen) and says why and how it reads them ([Page lists](../../docs/sources.md#page-lists)). |
| `fetchLinkMetadata(url)` | What a page says about itself for a kept link: Open Graph tags, the oEmbed it advertises, YouTube's oEmbed for a video (title, site, channel, picture). `null` when it says nothing. |
| `captureReadable(url, opts?)` | Readability on a linkedom DOM, strict allowlist sanitizer, bounded. Nothing in the page is executed. |
| `generateOpml`, `parseOpml` | Export from validated product fields (private sources omitted); bounded import preview. |
| `resolveSourceIcon(input, opts?)` | A source's own icon: the feed's declared image, a YouTube channel's `og:image` avatar, or the site's advertised icons (apple-touch-icon, `<link rel=icon>`, manifest, `/favicon.ico`), falling back from the site link to its home page and the feed host's home page. At most 14 safe fetches. A podcast never takes its hosting platform's icon, and a YouTube source never takes YouTube's. |
| `normalizeIcon(bytes)` | Decodes PNG, JPEG, GIF, WebP, AVIF or ICO (BMP and PNG entries) and re-encodes a square WebP of at most 128 px and 64 KB. Refuses SVG, non-images, banners, blank and tiny images, and canvases over 16 megapixels. |
| `isStoredIcon(bytes)` | The API's check before storing: a WebP within the size cap. No decoder needed. |
| `classifySocialInput(text)` | Recognises a fediverse handle (`@name@server`, a `server/@name@other` link) or a Bluesky handle, `*.bsky.social` host or `bsky.app/profile/…` link (`social.ts`). `discover` then resolves it: WebFinger to the profile page to the feed it advertises, or bsky.app's profile feed by DID. A pasted page with an ActivityPub actor link and a `/@name` path is treated as a fediverse profile: only its advertised feeds are offered, with no path probing. |
| `lookUpPostPictures` (`bluesky.ts`) | The pictures of Bluesky posts, asked of Bluesky's public API through `safeFetch` for posts the feed already brought; never finds or adds a post. |
| `searchPodcasts` (`podcast-search.ts`) | Apple's podcast directory by name; a hit is a feed address that discovery then previews like any other. |
| `searchSites` (`site-search.ts`) | Wikidata by name: the official websites of the things called that; a hit is a website that discovery then searches like any other address. A `429` says how long Wikidata asked to wait. |
| `fetchPictures` (`pictures.ts`) | Pictures for a kept copy, through `safeFetch`, typed from their bytes (no SVG, no ICO), optionally shrunk to WebP at most 720 px wide. |

The package also holds the pure helpers the others share: privacy redaction and credential-like URL
heuristics (`privacy.ts`), frame policy of a page (`frame-policy.ts`), capture quality and consent-banner
and lazy-image clean-ups for readable capture, the sanitizer, and the AI-filter model client
(`jev.ts`).

## No arbitrary connector code

The catalogue is data. Nothing in this package loads, evaluates or runs code that a person, a feed,
a page or an upload supplies: no end-user JavaScript, no uploaded or user-written recipes, no plugin directory.
A page list's recipe is made only by the detector, from a fixed grammar, and is run by the bundled RSS-Bridge's
XPathBridge behind the signed router.
Pages and feeds are fetched, parsed and sanitised; a page's script never runs. Another kind of source or
bridged service is a reviewed code change here, with recorded fixtures. No connector uses a password, a
session cookie or an API key from the person; a service that needs one is not offered.

## Test-only escape hatches

`safeFetch` (and `discover`, `captureReadableWith`) accept `testAllowAddress`, `resolver`
and `testTlsCa` as **in-process function arguments** so tests can reach a local server.
No environment variable or configuration can relax the checks, and a test asserts it.

## Coverage honesty

A feed shows what the publisher includes, usually the latest items. A YouTube channel
feed lists only the most recent videos and never the full history. A social account's feed
carries public posts only, and posts deleted upstream stay where they were collected; the
preview says so. Discovery says "about 2 posts a week" from sample dates and never claims
completeness; an empty feed is not proof that nothing was published. No connector needs
credentials.

See also the [egress service](../../apps/egress/README.md) and [security](../../docs/security.md).
