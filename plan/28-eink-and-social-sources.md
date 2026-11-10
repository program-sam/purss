# E-ink display and social accounts as sources

Two small owner-approved additions (2026-11-05). E-reader delivery (EPUB, OPDS) was dropped:
installing the app on an Android e-reader covers it, so the app needs a display mode for one.
Following Mastodon and Bluesky accounts as sources stays in scope; the outbound fediverse bridge
was dropped.

## E-ink display

| Concern | Decision | Reason |
| --- | --- | --- |
| Scope | A per-device setting, *Settings → General → E-ink display*, saved in local storage like Sounds | The same account reads on a laptop and on an e-reader; the look belongs to the screen |
| Detection | Never switched on by itself | E-reader browsers don't identify themselves reliably (some report an ordinary Android Chrome); a wrong guess would grey out a colour screen |
| Look | Pure black on white tokens; no animations, transitions, shadows, gradients, blur or see-through layers (scrims become solid white); links underlined; 3 px focus ring; chosen items get a 2 px edge; row actions always shown; 40 px buttons and 20 px checkboxes | Each redraw on e-ink is slow and ghosts; colour, shading and hover don't exist there |
| Theme | Forced light on that device; the account's theme is unchanged and returns when the mode is off | Dark mode on e-ink ghosts badly |
| Paging | A Page up / Page down bar under the list and under the article (never over the text) moves one screen less one line, instantly; disabled at either end | Smooth scrolling smears on e-ink; reading progress still follows the scroll position |
| Isolation | Every rule is under `[data-display="eink"]`, which the standard display never sets; the acceptance check compares the standard look's computed styles before and after | Other looks must not change |

Not built: tap zones on the screen edges (buttons are easier to find and work with a keyboard),
the e-reader's page-turn keys (not reachable from a web page), and greyscale treatment of images.

## Mastodon and Bluesky accounts

Inbound only, and FreshRSS stays the fetcher: discovery turns what was pasted into the account's
own public feed, and following it is the ordinary feed path. Platform behaviour was checked on
2026-11-05 against the source (mastodon/mastodon `accounts_controller.rb`, `show.rss.ruby`,
`webfinger_serializer.rb`; bluesky-social/social-app `bskyweb/cmd/bskyweb/rss.go`) and live answers
from mastodon.social and bsky.app; the tests replay trimmed recordings and never reach the network.

| Concern | Decision | Reason |
| --- | --- | --- |
| Inputs | `@name@server`, `name@server`, `acct:`; `server/@name@other` links; profile pages with an ActivityPub actor link and a `/@name` path; `@handle` (a domain), `*.bsky.social`, `bsky.app/profile/<handle or DID>` (also `/rss` and post links) | What people copy from these apps. A bare domain stays a website, because a custom-domain Bluesky handle and a website look the same |
| Fediverse lookup | WebFinger on the handle's domain (redirects followed, each hop checked) names the profile page; only feeds that page advertises are offered, and a profile page is never probed for usual feed paths. A post on a fediverse server (`/@name/<id>`, `/users/name/statuses/<id>`, `/notice/<id>`) without a feed link asks for the profile instead; any other page that names an ActivityPub actor (a blog with an ActivityPub plugin) is searched like an ordinary website | Works for Mastodon and any server that advertises a feed; no scraping of profiles or ActivityPub JSON |
| Bluesky lookup | `https://bsky.app/profile/<handle>/rss`, which redirects to the DID form; the DID address is followed | It survives handle changes; bsky.app also resolves DNS-based handles, which a safe fetch can't |
| Safety | Every request goes through `safeFetch`; a handle on an internal name is refused before any request; an advertised feed on an internal address is refused | AGENTS.md: no SSRF weakening |
| Labels and limits | Origin "Mastodon account" (by the feed's generator), "Fediverse account" or "Bluesky account"; the preview's note says public posts only, what is left out (boosts/reposts, replies) and that a post deleted upstream stays in PURSS; catalog entries `fediverse-account` and `bluesky-account` carry the full limits | Honest previews (plan/04); absence never deletes (plan/06) |
| Refusals | Unknown account, no profile link, no advertised feed (GoToSocial leaves it off unless the owner opts in), a Bluesky account hidden from signed-out people (403), custom feeds and lists, a fediverse post page: each has its own plain message | Never an empty source |
| Titles | The account's display name (Bluesky's "@handle - Name" becomes "Name"); untitled posts use the existing excerpt fallback | No new item model |

Not built: hashtag feeds (Mastodon's are per server), Bluesky custom feeds, lists and hashtags
(they have no feed; a public-API adapter would be the first proprietary connector), raw DIDs
pasted on their own, item kind `post` for these sources (they arrive as articles), and any
outbound posting or following. Open question for the owner: whether to offer Mastodon's
`/with_replies` and `/media` feeds as extra choices.
