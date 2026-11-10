# Connectors

Safe fetching, source discovery, feed parsing, readable capture, OPML and the connector
catalog. Recurring collection stays in FreshRSS; nothing here polls feeds. Everything is
exported from `src/index.ts`, except the icon resolver: it loads the native image library
(sharp), so only the worker imports it, from `@purss/connectors/icons`.

| Module | What it does |
| --- | --- |
| `safeFetch(url, opts)` | The only way to fetch a user- or feed-supplied URL. http/https only, no embedded credentials, DNS resolved and every address validated (one forbidden answer rejects the name), connection bound to the validated address, manual redirects (max 5, each hop re-validated, credential headers never forwarded), per-phase and overall timeouts, response cap enforced while streaming and after gzip/deflate/br, generic User-Agent, `AbortSignal`. Never throws: returns `{ ok: false, reason: blocked \| unreachable \| toolarge \| timeout \| invalid \| aborted, message, detail }`. |
| `classifyAddress`, `isBlockedPort`, `resolveDestination`, `boundLookup` | The address rules, shared with the egress proxy. |
| `parseFeed(body, contentType)` | RSS 2.0, RSS 1.0/RDF, Atom and JSON Feed to one shape (podcast and YouTube aware, bounded, robust). Throws `FeedParseError` for non-feeds. |
| `discover(input, opts)` | Pasted text to `DiscoveryResult` minus the server-held `token`: input normalisation (an email address and a name each get their own message), platforms that publish no feeds named at once (`platforms.ts`), known feed patterns for Reddit, GitHub, Apple Podcasts, Substack, Medium, Tumblr, Blogger, WordPress.com, Vimeo and Pinterest (`known-feeds.ts`), feed detection, alternate links, a section page's own feed before any site-wide guess (a site-wide feed is labelled *Whole site feed*), conservative path fallback, one hop into a site's "RSS feeds" page, comment feeds left out beside a posts feed, feed names (`feed-choice.ts`), YouTube channel/handle/video/playlist (a single video also carries a *keep* offer), cadence over the recent days, three samples, summaries-only, private-URL warning. A timeout or a busy site is never reported as "no feed". |
| `fetchLinkMetadata(url)` | What a page says about itself for a kept link: Open Graph tags, the oEmbed it advertises, YouTube's oEmbed for a video (title, site, channel, picture). `null` when it says nothing. |
| `captureReadable(url, opts?)` | Readability on a linkedom DOM, strict allowlist sanitizer, bounded. |
| `generateOpml`, `parseOpml` | Export from validated product fields (private sources omitted); bounded import preview. |
| `resolveSourceIcon(input, opts?)` | A source's own icon: the feed's declared image, a YouTube channel's `og:image` avatar, or the site's advertised icons (apple-touch-icon, `<link rel=icon>`, manifest, `/favicon.ico`), falling back from the site link to its home page and the feed host's home page. At most 14 safe fetches. A podcast never takes its hosting platform's icon, and a YouTube source never takes YouTube's. |
| `normalizeIcon(bytes)` | Decodes PNG, JPEG, GIF, WebP, AVIF or ICO (BMP and PNG entries) and re-encodes a square WebP of at most 128 px and 64 KB. Refuses SVG, non-images, banners, blank and tiny images, and canvases over 16 megapixels. |
| `isStoredIcon(bytes)` | The API's check before storing: a WebP within the size cap. No decoder needed. |
| `classifySocialInput(text)` | Recognises a fediverse handle (`@name@server`, a `server/@name@other` link) or a Bluesky handle, `*.bsky.social` host or `bsky.app/profile/…` link (`social.ts`). `discover` then resolves it: WebFinger to the profile page to the feed it advertises, or bsky.app's profile feed by DID. A pasted page with an ActivityPub actor link and a `/@name` path is treated as a fediverse profile: only its advertised feeds are offered, with no path probing. |
| `connectorCatalog` | Declarative descriptors: native feed, YouTube channel resolver, fediverse account, Bluesky account. |

## Test-only escape hatches

`safeFetch` (and `discover`, `captureReadableWith`) accept `testAllowAddress`, `resolver`
and `testTlsCa` as **in-process function arguments** so tests can reach a local server.
No environment variable or configuration can relax the checks, and a test asserts it.

## Coverage honesty

A feed shows what the publisher includes, usually the latest items. A YouTube channel
feed lists only the most recent videos and never the full history. A social account's feed
carries public posts only, and posts deleted upstream stay where they were collected; the
preview says so. Discovery says "about
2 posts a week" from sample dates and never claims completeness; an empty feed is not
proof that nothing was published. No connector needs credentials, and no proprietary
service adapter exists.

See [onboarding](../../plan/04-source-onboarding.md),
[connector ladder](../../plan/08-connectors-and-discovery.md),
[security](../../plan/10-security-and-privacy.md) and the
[egress service](../../apps/egress/README.md).
