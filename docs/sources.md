# Sources

How PURSS turns a pasted link into a source and keeps it fed. For contributors and for
operators who want to know what their server does for a source. The steps a person takes
are in the user guide's [Adding sources](user-guide.md#adding-sources); how items, keeps and
syncs flow is in [Architecture](architecture.md); the code is in
[connectors](../packages/connectors/README.md), [egress](../apps/egress/README.md) and
[the FreshRSS adapter](../packages/freshrss/README.md).

## Ground rules

- **FreshRSS collects; PURSS only looks.** Discovery fetches a few pages to find out what a
  link is. Recurring collection is FreshRSS's, and nothing in PURSS polls feeds. A source
  PURSS makes a feed for (a bridged page, a big feed's smaller copy) is still collected by
  FreshRSS, from an address PURSS serves it.
- **One way out.** Every fetch of a link a person or a feed supplied goes through `safeFetch`
  (public addresses only, every redirect hop checked, size and time caps). FreshRSS and
  RSS-Bridge reach the internet only through the egress proxy with the same rules. The
  [security](security.md) page has the address rules.
- **No connector code.** The catalogue of source kinds is declarative data in the repository, and
  adding a kind of source is a reviewed code change with recorded fixtures. No uploaded code or user
  script is ever run. A page list's recipe is a few expressions from a fixed grammar that can only
  select text and links on one public page; PURSS's detector writes it, and any recipe outside the
  grammar is refused, though a `bridge:page/…` address someone writes by hand within it is read like
  the detector's. The bundled RSS-Bridge's XPathBridge runs it behind the signed router
  ([Page lists](#page-lists)).
- **No credentials.** No source needs a password, a session cookie or an API key from the
  person, and nothing scrapes a login. A service that needs one stays unavailable, and the
  answer says so.
- **Honest previews.** A successful fetch is not proof that a feed is complete, and a failure
  is never turned into an empty source (below).

## From a link to items

1. **Paste.** `POST /api/discover` runs discovery in the API process, at most 120 lookups per
   account per ten minutes (a feed list imported from OPML uses a share of that and leaves the
   rest for Add source).
2. **Preview.** Discovery returns candidates, each with a title, kind, how often it publishes,
   up to three sample items and a note. They are held in memory behind opaque tokens for one
   hour (5,000 at most); a restart forgets them. A feed address that may carry a secret never
   reaches the database before the person decides how to follow it.
3. **Follow.** The chosen candidate becomes a source row and an `engine.subscribe` job in one
   transaction. A feed already followed is recognised first: by its address up to what never changes
   which feed a server sends (`http` or `https`, a trailing slash, tracking parameters: `urlKey`), or for
   a private source by its keyed hash under either scheme; following it again opens that source. A
   candidate at another address whose newest posts are a followed source's (at least 3 and 70% of its
   newest 10 among that source's posts, and as many of the source's newest among the candidate's,
   compared by post address without `www.` or tracking parameters) is shown as the same posts under
   another address, and can still be followed as a second source. The source keeps its own address; only what the engine is subscribed to can
   differ (a bridge's or the gateway's address).
4. **Subscribe.** The worker turns the stored address into the engine's (a private link from
   `secrets/source-urls/`, a bridged source's signed router address, or the gateway's address
   for a big feed) and adds it to the account's FreshRSS user. The engine fetches the feed
   when it adds it, so an empty feed is known at once and the source says *No posts yet*.
5. **Collect and sync.** FreshRSS refreshes on its schedule; the worker's `engine.sync`
   reads the reading list forward and the API stores the items.
   See [Architecture](architecture.md).

## Discovery

`discover()` in `packages/connectors` never throws: every outcome is a result, either
candidates (with an optional offer to keep a single video) or a failure with a reason
(`invalid`, `blocked`, `unreachable`, `nofeed`, `unsupported`, `toolarge`, `timeout`) and a
message that says what to do next. One lookup has 30 seconds and 40 requests (a redirect hop
counts as one), each request 15 seconds, and returns at most 8 candidates.

### A name instead of an address

Add source sends a name (no scheme, slash, `@` or port, and no dot inside a word) to two searches at
once, and a result chosen there is looked up like a pasted address:

- **Websites** (`POST /api/discover/sites`, `site-search.ts`): Wikidata's `wbsearchentities` for the
  name, then the official website (P856, a preferred one first, deprecated ones never) of up to ten
  matches, eight hits at most, the same site written another way once. Choosing one searches that
  website; when it has no feed, the registry fallback below can still find one Wikidata records for it
  (P1019). Only the typed name is sent. Answers are kept in memory for an hour by name, and while
  Wikidata limits requests (`429`), it isn't asked again for the time it said (at least a minute, at
  most an hour); its limit counts the installation's whole address. On a hosted installation, sources
  of the Discover graph whose shared name or site contains the name come first (`sourcesNamed`), only
  for a reader who shares: the same public, ten-reader sources Discover suggests, never a private one,
  and never with a count. A Wikidata failure still shows those.
- **Podcasts** (`POST /api/discover/podcasts`, `podcast-search.ts`): Apple's podcast directory.

Each search allows 60 a person per ten minutes. One failing still shows what the other found.

### What decides the route

The shape of the input decides, in this order:

| Input | Route |
| --- | --- |
| `bridge:<service>/<key>` | The bridged source itself, as an archive writes it (a page list is `bridge:page/<key>`). Refused where this installation does not run that service, and for a key that service does not accept |
| A DOI (`10.…`, `doi:…`, a doi.org link) | Crossref's record of the work names the journal ([Journals and Crossref](#journals-and-crossref)) |
| An ISSN (`1534-8687`, `ISSN 1534-8687`) | Crossref's record of the journal. Eight digits alone are a number, not an ISSN |
| A fediverse or Bluesky handle or profile link | [Social accounts](#social-accounts) |
| Anything else | A web address, below |

For a web address, the first of these that applies wins:

1. **Normalise.** A scheme is added (https first, with plain http as the fallback), `feed:` and
   `podcast:` links are unwrapped, a cookie-bounce parameter is dropped. Credentials in the
   address, non-web schemes and private or internal hosts are refused. An email address and a
   bare name each get their own message. A bare host that refuses automated readers or does not
   answer is asked again as `www.` before it is given up on.
2. **YouTube hosts** ([YouTube](#youtube)).
3. **A page of a bridged service** this installation runs ([Source bridges](#source-bridges)).
4. **A service that publishes no feeds** (`platforms.ts`: TikTok, Facebook, X, Threads,
   WhatsApp, Discord, Signal, Snapchat, Spotify, LinkedIn, Reddit, and Instagram, Telegram, Twitch and
   Bandcamp where they are not bridged). Reddit's own feed addresses (`/r/name/.rss`) answer "Not
   Found", so they are refused too rather than fetched. It is named at once without asking it for a feed, with
   the pointer to a YouTube channel, blog or newsletter the person may follow instead. The link
   can still be kept.
5. **Journal addresses** (and article links, through their DOI) on Wiley, Taylor & Francis,
   Chicago, Berghahn, Project MUSE and ScienceDirect, whose pages turn automated readers away
   but whose feeds answer at addresses made from the journal's code or ISSN (`journals.ts`).
6. **Known feed patterns** (`known-feeds.ts`, `services.ts`): a
   GitHub repository or account, an Apple Podcasts show (through Apple's public lookup), a
   Substack, Medium, Tumblr, Blogger, WordPress.com, Vimeo or Pinterest address, a Steam game,
   an arXiv listing, a Dailymotion, Odysee or PeerTube channel, a DeviantArt or Behance profile,
   and pages whose feeds the page does not link: NOS's and the BBC's news and sport sections (feeds on
   `feeds.nos.nl` and `feeds.bbci.co.uk`, a BBC section's feed named by its description, "BBC News –
   Technology", since each is titled "BBC News"), the European Commission's Press Corner (the
   `/commission/presscorner/api/rss` feed its own script reads, in the address's language) and
   Rijksoverheid's front and news pages (the news search feed its "RSS-link kopiëren" button makes).
   Substack (`substack.ts`): a publication, post or share link (`open.substack.com/pub/name/…`)
   is the publication's `/feed`; a section page (`/s/<slug>`) offers `/feed?section=<slug>` first,
   then the whole publication's; a podcast page is read as a page, since only it names the podcast
   feed on api.substack.com. A profile (`substack.com/@handle`, `/profile/<id>-<name>`, a note
   under it) has no feed: Substack's public profile record
   (`substack.com/api/v1/user/<handle>/public_profile`, read up to 4 MB because it also lists what the
   person reads) names the publications the person runs or writes for, and their feeds are offered,
   the primary one first and preselected (at most four). An unknown profile and one without a
   publication each get their own message. A post link under a profile (`/@handle/p-123`) redirects
   to the post on its publication and is searched like any page.
   The pasted address is only rewritten; the feed is then fetched and checked like any other, and an
   address with no feed there (a BBC section without one answers 404) goes on to the page search.
7. **Fetch the address.** A feed is a candidate. A page is searched, below. Anything else
   (an OPML list, a sitemap, JSON that is not a JSON Feed, a file) gets a specific message.

### Searching a page

In this order, stopping when posts have been found:

1. The feeds the page advertises (`<link rel="alternate">`), then, if there are none, links on
   the page that look like feeds, those about this page first, and feed addresses the page shows
   for copying (an input's value, a copy button's text, a lone address in code). A page that
   lists many sites' feeds is cut to the six most relevant.
2. For a journal: the journal on its publisher's platform that the page links to, an Open
   Journal Systems journal's announcements feed, and, from the ISSN the page states in its
   scholarly metadata, the feed a publisher makes from an ISSN.
3. For a section page, the section's own conventional feed addresses before any guess at the
   whole site's.
4. The site's conventional addresses (`/feed`, `/rss`, `/atom.xml`, `/feed.xml`, `/rss.xml`,
   `/index.xml`), tried three at a time. They stop after two hits, when a batch is sent to
   another host (a login wall, a parked domain), and for the rest of the lookup once the site
   answers a guess with "too many requests", an error of its own or nothing in time.
5. The site's "RSS feeds" pages, searched the same way, at most two: those the page links to,
   then a feed-looking link or conventional address (`/rss`, `/feeds`) that answered with a page,
   which is read as it came without asking again.
6. A longer list of addresses (`/rss.php`, `/comic/rss`, `/blog/feed`, …), tried like step 4.

Along the way:

- A page whose only feed is for comments is not offered as the site's posts; comment feeds are
  left out when a posts feed exists, and said so when they are all there is.
- A wiki's site-wide recent-changes feed, which every page of a wiki advertises, and an empty
  "Subscribe" feed are not taken for the page's own feed.
- A feed for the whole site found from a section page is labelled *Whole site feed*, and is not
  chosen silently over the section's own.
- Feeds whose entries are the same (RSS and Atom versions of one feed) are offered once.
- A front page that answers 403 or a 5xx still has its usual feed addresses tried, and the
  answer says the front page did not open.
- When the page's own feed is known (it advertises it, or the feed is named like the page) it is
  chosen; when nothing clearly is, nothing is chosen.

### Honest previews

- The preview shows when the feed publishes ("about 2 posts a week", from the dates of the
  sample items), three samples, whether the feed gives only summaries, and a private-link
  warning when the address looks like it holds a secret. It never claims completeness: a feed
  shows what its publisher includes, usually the latest items, and an empty feed does not prove
  that nothing was published.
- A timeout, a busy or limiting site and a site that refuses automated readers are each their
  own answer. None is ever "no feed". The lookup's request cap has its own message. A `401` that
  names no way to sign in (no `WWW-Authenticate`, as bot walls such as DataDome answer) is a refusal
  like a `403`, not a page that wants a password.
- A YouTube feed that did not answer when asked is offered with a note, and following keeps trying.
- A failed login or an unreachable service is never an empty feed: the bridge router and the
  feed gateway answer a failure as a failure, and the source says what is wrong.

### Where discovery ends

After the web address's own search, these can add a candidate, in this order: Wikidata when nothing was
found ([Registry fallbacks](#registry-fallbacks)), Crossref for a journal ([Journals and
Crossref](#journals-and-crossref)), and, last of all and only when none of them found a feed, what the page's own
scripts name ([The page's scripts](#the-pages-scripts)) and the lists of posts the page itself shows
([Page lists](#page-lists)). Within that last stage the first that finds something ends the search: a feed a script
names beats any list, and the page's own list beats a list on another page the scripts name. When all of them
find nothing, a page that is only a shell for its script says so, and any other page gets the usual "no feed" answer.
Failed lookups are counted per site and reason for the administrator, with the site's registrable domain only and kept 180
days (`discovery_misses`); which route found each source, and how the person got there, is counted too
([Discovery routes](#discovery-routes)).

## Social accounts

Inbound only, and FreshRSS stays the fetcher: discovery turns what was pasted into the
account's own public feed, and following it is the ordinary feed path.

| Input | Recognised as |
| --- | --- |
| `@name@server`, `name@server`, `acct:name@server` | A fediverse account. Without the leading `@` it may be an email address, and the answer says so when no account answers |
| `https://server/@name@other` | One server's view of an account that lives on another |
| A profile page with an ActivityPub actor link and a `/@name` path | A fediverse profile: only the feeds it advertises are offered, and its paths are never probed |
| `@handle.example`, `name.bsky.social`, `bsky.app/profile/<handle or DID>` (also `/rss` and post links) | A Bluesky account. A post link offers its author to confirm |

A bare domain stays a website, because a custom-domain Bluesky handle looks like any site.

- **Fediverse.** WebFinger on the handle's server (`/.well-known/webfinger`, redirects followed,
  each hop checked) names the profile page, and the profile page's advertised feeds are the
  candidates, at most three. There is no scraping of profiles or ActivityPub JSON. The preview
  is labelled *Mastodon account* when the feed's generator says Mastodon and *Fediverse
  account* otherwise.
- **Bluesky.** `https://bsky.app/profile/<handle>/rss`, which redirects to the account's DID
  form, so the followed address survives a handle change. The title is the display name.
- **What the preview says.** Public posts only; boosts, reposts and replies are not in the
  feed; a post deleted upstream stays in PURSS as it was collected. Posts have no titles, so
  the start of the text stands in.
- **Refusals**, each with its own message: an unknown account, a server that knows the account
  but links no profile, a profile that advertises no feed (GoToSocial publishes one only when
  the owner turns it on), a Bluesky account hidden from signed-out people (403), Bluesky custom
  feeds and lists, a fediverse post page, an internal or private server name. Bluesky does not
  document its feed, and its entry in the catalogue says so.
- **Bluesky pictures.** The feed carries none. On its maintenance tick the API asks Bluesky's public API
  (`public.api.bsky.app`, through `safeFetch`, `getPosts` 25 at a time, a handle's DID cached an
  hour) about the account's posts of the last three days that have no picture, at most 50 per
  pass and three tries each, 15 minutes apart. The first picture found (an image, a video's
  still, a link card; a quoted post's first picture when the post has none, one level only)
  becomes the item's picture, never replacing one the feed gave. A failure, a deleted post or a
  slow answer changes nothing, and no post is found or added this way: it is not a second
  collector. The feed's placeholder for a quote or attachment is shown as
  *[quote or attachment: open the post to see it]*.

## YouTube

Only YouTube's own public feeds are used (`videos.xml`).

| Pasted | Resolved to |
| --- | --- |
| `/channel/UC…` | That channel's feed |
| `/@handle`, `/user/…`, `/c/…` | The channel id read from the page, then the channel's feed. A page that points at more than one channel is refused; a cookie-consent page is reported, with the advice to paste the `/channel/UC…` address |
| A playlist (`PL…`, `UU…`, `OLAK5uy_…`, `FL…`) | The playlist's feed. Mixes, liked videos and watch-later lists have none, and the answer says so |
| A video (watch, `youtu.be`, Shorts, live, embed) | An offer to **keep the video** with its real title, channel and picture (YouTube's oEmbed), and its channel as a *Related channel — confirm* choice. A `list=` playlist is offered too |
| A `feeds/videos.xml` address | That feed, still a YouTube source |

The feed endpoint answers 404 and 5xx intermittently, more often to cloud servers, so a feed
request is retried up to twice and a page request once. A channel that is known but whose
feed did not answer is offered with a note. A handle YouTube has no page for is not called a
channel that does not exist, since handles are renamed. Search results, the home page,
subscriptions, history and `/feed/…` pages are refused with a message. A channel's feed lists
only its latest videos (about 15), never its history.

## Source bridges

Some services publish no feed. A bundled, pinned [RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge)
reads their public pages, and a router in front of it makes FreshRSS-readable feeds with
stable ids. FreshRSS stays the only thing that polls.

| Service | A source is | Key |
| --- | --- | --- |
| Telegram | A public channel (`t.me/name`, `t.me/s/name`, a post link) | The channel's name |
| Bandcamp | An artist or label (`name.bandcamp.com`), by release | The subdomain |
| SoundCloud | An account | The permalink |
| Twitch | A channel's past broadcasts | The login |
| Mixcloud | An account's own shows (the backend also lists shows it listened to; those are left out) | The user name |
| Rutube | A channel (dates are moved back three hours: the backend labels Moscow time as UTC) | The channel number |
| Apple Music | An artist's releases (up to 50, in no order) | The artist number |
| Instagram | A public account's latest six posts, as captions ([Instagram](#instagram)) | The user name |
| MangaDex | A title's latest chapters (`mangadex.org/title/<uuid>/…`), in every language the title has, each marked in its title (`[en]`); a chapter that only links to another site is left out | The title's uuid |
| VK Video | A channel (`vkvideo.ru/@name`, `vk.com/video/@name`) | The handle without the `@`, in lower case |
| Crossref | A journal's registered articles ([Journals and Crossref](#journals-and-crossref)) | The ISSN without its hyphen |
| Page lists | A list of posts read from a page that has no feed ([Page lists](#page-lists)); no pasted address names one, only the detector makes one | The page's address and recipe, encoded |

Patreon, GoComics and The Far Side were tried and left out: they refuse datacenter addresses.

Facebook, Threads, X and TikTok are not bridged: they need a session. A service enters the
catalogue only when its bridge returns real recent entries for popular accounts from both a
home and a datacenter address without credentials. A bridge can stop working when a service
changes its site, and the preview says so.

### Identity and signed addresses

A bridged source's feed address in the product is a descriptor, `bridge:<service>/<key>`
(`bridge:telegram/durov`): no host, port, backend or credential. The key is the service's
public handle, lower-cased where the service ignores case, and a renamed handle is a different
source (a VK Video channel that changes its handle, say); a page list's key is its page and recipe, written as
[Page lists](#page-lists) describes. The database, archives and job payloads carry the descriptor. A descriptor holds a key of at most
400 characters; each service's key pattern (and, for a page list, the reading of the key) is what a key must pass.

Only the worker turns it into an engine address, `http://feed-bridge.internal:8945/b/<service>/<key>/<signature>`,
where the signature is an HMAC-SHA-256 of `<service>/<key>` under `secrets/bridge-key`. The
router answers nothing else: a wrong or missing signature, an unknown service, a key that
does not match the service's pattern and a service whose backend this installation does not run
are the same `404`, so a public feed that redirects FreshRSS to the alias gets nothing.

- The key is created at install on every installation, kept with the other secrets and included in
  `--include-secrets` backups. It is never rotated: replacing it makes the router answer `404` to
  every address FreshRSS holds, and those sources go quiet. Following the page again
  re-subscribes with a fresh address and keeps the items, whose post ids do not change.
- An OPML export writes the service's page address, which imports as the same source (a page
  list's page address is looked up again, and the detector runs again: [Page lists](#page-lists)),
  and the account archive keeps the descriptor.
- An installation without the router (`PURSS_BRIDGE_URL` unset), or, for the RSS-Bridge services
  only, without `PURSS_RSS_BRIDGE=1`, does not offer a bridged service: its pages are searched
  like any web page (the services in `platforms.ts` get the "publishes no feeds" answer) and a
  `bridge:` descriptor is refused. Crossref needs the router and nothing else.

### The router

`apps/egress/src/bridge/router.ts`, on its own loopback or private listener (port 8945), reached
by FreshRSS through the proxy alias `feed-bridge.internal:8945` and by the API directly. It
runs whenever the bridge key exists. Each catalogue entry names the kind of backend that
collects it (RSS-Bridge, or Crossref's API), and the router asks the backends of that kind.

- **Stable ids.** Each entry's GUID is the service's id for the post taken from its canonical
  address (`telegram:durov/552`, `instagram:p/<code>`, `doi:10.1111/…`), per-service rules with
  fixtures; its link is the canonical address. An entry without one is dropped, so a source
  keeps its items when the backend changes. Output with entries none of which belongs to the
  source or is left out on purpose is a failure (`no_ids`).
- **Bounds.** At most four backend fetches at once (64 more may wait, then `503`), one per
  source at a time with concurrent requests sharing it, 50 entries per answer, 256 KiB per
  entry, good answers reused for ten minutes (24 MiB in all, least recently used dropped first).
- **Failure.** After a failed fetch the source is left alone for five minutes, doubling to an hour,
  and meanwhile the last good answer is repeated, or `503` with `Retry-After`. A failure is
  never an empty `200`. A real empty feed is `200`, except for a service whose backend answers
  empty when it misread the page (Instagram, and page lists, whose recipe matches nothing once a
  page's layout changes): no posts is asked again once at once and is otherwise a failure (`no_posts`).
- **RSS-Bridge's isolation.** It runs in its own container on a network shared only with
  egress, with no route out. Its proxy is the egress proxy and its name lookups go to egress's
  resolver, which answers only public addresses. Only the catalogued bridges are enabled
  (`RSSBRIDGE_system_enabled_bridges` in `infra/compose.yaml`), `error_output` is `http` so
  failures are HTTP errors, and the container's memory limit bounds a decompression bomb.
- **Redirects.** RSS-Bridge follows them (`RSSBRIDGE_http_follow`, at most three), as many sites serve a page only
  after one or two. RSS-Bridge itself checks only the first address, so what makes this safe is that each hop
  reaches egress's proxy as a new request and is resolved and checked there like any other (a hop to a private,
  link-local or metadata address, or to a name that resolves to one, is a `403`). That proxy has no internal
  destinations: egress's own aliases, the feed gateway and the bridge router, are reached only by FreshRSS, so a
  redirect can't send RSS-Bridge to them. RSS-Bridge's own refusal of a first address that is private or reserved
  (its `http` settings `allow_private_addresses` and `allow_reserved_addresses`, off by default and left off) is a second layer, not the one relied on.

### The failure log

Two administrator-only records, neither tied to an account:

- `bridge_fetches` (egress's `bridge.db`): service, key, backend, stage (`backend`, `parse`,
  `identity`), outcome (`ok`, `empty`, `no_posts`, `no_ids`, `http_<status>`, `timeout`,
  `too_large`, `parse_error`, `unreachable`), entry count, duration, and whether the answer
  came from the router's cache or back-off. Kept 30 days, at most 200,000 rows.
- `discovery_misses` (the product database): day, the site's registrable domain, reason and a
  count, for the sites people try to follow without success. Kept 180 days, no path, no
  subdomain, no account.

The administrator's Service health page reads both: per bridged service the last seven days'
success rate, and the keys currently failing and since when. FreshRSS's own per-feed errors are not
read, so a source whose fetches fail inside the engine looks quiet after the usual quiet period; for a
bridged source the administrator sees the failure at once in the log.

### Discovery routes

Every candidate discovery produces carries exactly one **route**: a short stable id for the way it was found. A lookup
also has an **entry**: how the person got to it. Both are closed lists in `packages/domain/src/discovery-routes.ts`, and an
id is never reused for something else. The administrator reads them on the Service health page to see which routes are used and
which could go; they are never shown to anyone else.

| Route | The candidate is… |
| --- | --- |
| `feed-address` | the pasted address, which is a feed |
| `alternate-link` | a feed the page advertises (`<link rel="alternate">`) |
| `page-anchor` | a link on the page that looks like a feed |
| `copy-address` | an address the page shows for copying |
| `listed-feed` | a feed on a page of the site's feeds |
| `section-path` · `conventional-path` · `more-paths` | a conventional feed address of a section, of the site, and the longer list |
| `discourse-latest` | a Discourse forum's latest topics |
| `known:github`, `known:apple-podcasts`, `known:guardian`, `known:substack`, `known:medium`, `known:tumblr`, `known:blogger`, `known:wordpress`, `known:vimeo`, `known:pinterest`, `known:steam`, `known:arxiv`, `known:dailymotion`, `known:odysee`, `known:deviantart`, `known:peertube`, `known:behance`, `known:nos`, `known:bbc`, `known:presscorner`, `known:rijksoverheid` | a feed made from the address of that service (one id per service) |
| `journal-platform` · `journal-issn` · `journal-ojs` | a journal's feed on its publisher's platform, one a publisher makes from an ISSN, an Open Journal Systems journal's announcements |
| `wikidata` · `crossref` | what the registry fallback or Crossref added |
| `youtube` · `fediverse` · `bluesky` | a YouTube channel or playlist, a fediverse account, a Bluesky account |
| `bridge:<service>` | a bridged source, one id per service of the catalogue (`telegram`, `bandcamp`, `soundcloud`, `twitch`, `mixcloud`, `rutube`, `applemusic`, `instagram`, `mangadex`, `vkvideo`, `crossref`, `page`) |
| `page-list` | a list of posts the page itself shows |
| `script-feed` · `script-page` | a feed a script names, a list on a page a script names |
| `markup-feed` · `linked-page` | a feed address written in the page's own markup (not as a feed link), a list on a page the page itself links to, read along with its scripts |
| `installation-news` | this installation's own news |

| Entry | The person got to the lookup by… |
| --- | --- |
| `paste` | Add source with a link (the default) |
| `site-search` · `podcast-search` | choosing a website or a show from the name search |
| `suggestion` | following a source suggested on the Discovery page |
| `shared-link` | a link shared to the app, or opened as a link to it (`?dialog=add&url=…`) |
| `opml-import` | a list of feeds imported (OPML) |
| `extension` | the browser extension's token (the server decides this) |
| `assistant` | an assistant connected over MCP |

The browser says only `paste`, `site-search`, `podcast-search`, `suggestion` or `shared-link` (the `entry` of `POST
/api/discover`); a lookup that is only to reconnect a private source's link (`reconnect`) follows nothing and is not counted.

The route and the entry are kept with the preview on the server, like a feed's `large` mark and its newest posts' addresses, and are
never sent to the browser or an assistant. Two records keep them:

- **On the source.** Following a source stores its route and entry (`sources.discovery_route`, `discovery_entry`) and, when it is
  unfollowed, when (`unfollowed_at`). Sources followed before this, and ones an archive brought in, have none. They are the account's
  own data, but not user content: they are in no export, archive or OPML file.
- **Daily counters.** `discovery_routes` holds, per UTC day, entry and route, how many candidates were shown ("offered", counted when the
  candidates are held for the person: a lookup, an import's chosen feed) and how many were followed. No account, workspace, source, address or
  title is in it. Rows older than 180 days are deleted when a new one is written.

The Service health page's **Discovery routes** table (`GET /api/admin/health`, `discoveryRoutes`) shows, for each route and then for each
entry over the last 90 days and across every account: offered, followed, the follow rate, the sources followed in those days that are still followed,
and, of those followed at least 30 days ago, how many were followed for at least 30 days. The routes with nothing at all in those days are listed
under the table, with the day counting began, so a route can be judged unused only once the counting has run long enough. Hosted and
self-hosted installations alike show it: it is the operator's own installation's data.

### Adding a service

A service is a `BridgeService` in `packages/connectors/src/bridges.ts`: id, name, origin, key
pattern, an example account (the monthly RSS-Bridge update check asks each service's example
through the real router), how a page address names a key, the page address of a key, the
backend and its parameters, the post-id rule, and optional clean-ups (title and text, a date
correction, a rule for entries to leave out on purpose, pictures to keep, a check a key pattern
can't make, a name for a source that has none of its own). It needs recorded
fixtures for the key and page rules, the post ids and the router's handling. An RSS-Bridge service
also needs its bridge added to the enabled list in `infra/compose.yaml` (a test checks that the list and the catalogue agree).

## The page's scripts

Some pages build their list of posts with script, and name where the posts are in that script: a feed address the page
doesn't link, or a page of the same site that shows the list as ordinary markup. When a pasted web page has no feed and nothing
else found one, PURSS reads the page's own scripts, and its own markup with them, **as text**. It never runs a script, and everything it asks for is an ordinary `GET`
through `safeFetch`. Two kinds of finding come of it, and nothing else (`script-scan.ts`, `discover.ts`):

- **A feed named in a script** (route `script-feed`). An address a script writes out that looks like a feed's (`/feed/rss/nieuws/`,
  `/api/rss`, `feed.json`, `https:\/\/…` as JSON writes it), or a feed route a script builds on a base it doesn't write out
  (`` `${this.apiUrl}rss` ``) tried on the API roots the scripts do write out (an address ending in `/api`, `/rest`, `/wp-json`, a
  configured `apiUrl`): at most three roots and three routes. The usual conventional feed addresses are not asked for again. Every
  such address is **verified like any feed**: it counts only when it answers as a feed with entries (the same probe, sniff and parse as any
  other), and is then offered as an ordinary feed candidate (a feed of comments is left out, one feed under two addresses once).
- **A list on a page the scripts name** (route `script-page`). Any other address of the page's own site that a script writes out and is
  not an interface or a file, not the page itself, its language version or the site's front page, and whose address shares a word of
  four letters or more with the page's (`/latest` for `/latest/news`, `/en/search-publications` for `/en/publications`; the same word, or
  a longer one that starts with it, never one that merely contains it, and not `index`, `html` or `home`). The pages that rank best (the
  page's own words, a list's words such as news or releases) are fetched, at most two, with a `GET`, and the same detector as for the
  page itself ([Page lists](#page-lists)) reads each; its lists go through the router and are offered exactly like the page's own, as
  `bridge:page/<key>` of the sibling page.

**What is read.** Only scripts of the page's own site, by registrable domain, so a CDN subdomain of the site counts and another company's
host does not (`<script src>`, and module and script preloads); the likeliest first (a word of the page's address in the file's name, a
page's own code before a library); at most 10 files, 2 MiB of one and 3 MiB of all of them, three at a time; and the page's inline scripts
(JSON-LD and application data included, which often name the parent pages) and the page's own markup as one more text (its links and attributes: a
breadcrumb or a menu names the parent and sibling pages that its scripts do not), all from the page already in hand. An address that carries a key
(a parameter called `key`, `token`, `hash`, `sha256`, `client_id`, `signature` or the like, whatever its value, a credential by
the privacy rules, a secret in the path) is never asked for and never offered, and neither is one outside what the rules above allow. At most six feed
addresses and two pages are asked for in all (eight addresses).

**Order and choice.** Last of all ([Where discovery ends](#where-discovery-ends)), after Wikidata and Crossref, and only when they found
nothing, the page opened as a web page and its address doesn't look to carry a key. The scripts are read first and a feed they name ends the
search; then the page's own lists; then the lists on the pages the scripts name, which are asked for only when the page showed none. PURSS can't
tell from the page that something found this way is the pasted page's own, so **none of it is ever chosen for the person**, even when it is the only
candidate: the candidate carries `fromScripts`, and the dialog's `preselect` leaves it unchosen. A list keeps the confidence the detector gave it
(`high` or `medium`). At most three are offered. The notes say it in plain words: *The page doesn't link to this feed; PURSS found its address
in the page's own scripts.* and *PURSS found this list on <page>, which the page's scripts point to.* (and, for a list, what every list read from a
layout says). A page that builds its list with JavaScript and has nothing found in its scripts still gets the message *PURSS couldn't find a list of
posts on this page. It may build its list with JavaScript, which PURSS doesn't run…*.

**Cost.** The step has an allowance of requests of its own (24: ten scripts, six feeds and two pages are 18 at most, and the rest is for
the redirects they follow), so a site whose usual addresses used up the lookup's 40 doesn't stop it. It has a time of its own too: at most 9 s, and only
when the lookup has more than 11.5 s left, so the lists that come after it still have the 8 s their previews need and the whole lookup still ends within
its 30 s. The step reads a site's scripts once per lookup, and only for a page nothing else could follow.

**What it leaves out, on purpose.** JSON interfaces the scripts call (they need a source type that reads a JSON list, which PURSS doesn't have), a list that is
inside the page's own data, a content management system's interface, and the scripts a script loads later. A measurement over 56 script-built list pages that
had none of PURSS's other ways found these to add nothing of what PURSS can follow, or to need that source type. It is a guess from text:
a script can name an address it never uses, and a page it names can show a list of something else; that is what "never chosen" and the plain notes
are for.

## Page lists

Many pages have no feed but show a list of posts: a news index, a blog's archive, a changelog, a
job board. When a pasted page has none, PURSS looks at the page it already read for such a list
and offers up to three as sources. FreshRSS collects each through the signed bridge router, and
RSS-Bridge's XPathBridge reads the page. No script of the page ever runs.

- **When it runs.** Last of all ([Where discovery ends](#where-discovery-ends)), and only when
  the installation's router serves page lists (the router and RSS-Bridge both run), the address
  opened as a web page, and nothing found a feed: not the page's own feeds, not the usual addresses,
  not Wikidata, not Crossref, not a script ([The page's scripts](#the-pages-scripts)). It also runs when the cap on requests
  ended the search for a feed. The page's own lists come before the lists on pages its scripts name, which are read by the same detector and offered the same
  way, but never chosen. A
  page that turned readers away, was slow or busy is answered as before, and a page whose address looks
  to carry a key is left out (its descriptor would be kept, exported and logged). Discovery reads the page once;
  the detector works on those bytes and fetches nothing.
- **The detector** (`page-lists.ts`, [connectors](../packages/connectors/README.md)). It reads
  the page's own markup: JSON-LD, microformats and microdata first, then groups of links that sit
  in the same kind of place. It returns up to three lists, each with a score, a confidence, reasons, its
  first posts and a *recipe*: four XPath 1.0 expressions (the item, and the title, link and date inside it)
  from a small fixed grammar that `validateRecipe` checks (class and attribute tests, child and
  descendant steps, one union or one `concat`; no `document()`, variable or extension function).
  A date goes into a recipe only when PHP's `strtotime`, which XPathBridge uses, reads it as the page shows it.
- **Confidence and choice.** `high` (only a clearly best first list): the page's own list, chosen for the person.
  `medium`: offered, and none is chosen, even when it is the only list found. `low`: no list was found, and
  the usual "no feed" answer stands. A page that draws its list with script (an application shell, an empty `<main>`) is told
  so: *PURSS couldn't find a list of posts on this page. It may build its list with JavaScript, which PURSS
  doesn't run. Paste the site's feed address if it has one, or keep this link.* (A nearly empty static page
  gets the same answer: the detector can't tell the two apart.)
- **Preview.** Each list is asked of the router as the source it would be, in parallel, and is offered
  only if the router read posts from it just now. The previews are the lookup's own allowance of three, apart
  from the request cap (a site whose usual addresses all redirect has used that up by then); each waits at most 25 s,
  none starts with less than 8 s of the lookup's time left, and the lookup's deadline stops them and says it took too long.
  Each list says plainly that PURSS reads it from the way the page is laid out; that it holds only the posts the page
  lists now, never older ones; that a post whose date isn't on the page is dated when PURSS first sees it; that it can
  stop working when the site changes its page; and why PURSS chose it, and what it doubts (words for the detector's reason
  codes, in the copy catalog).
- **The source.** `bridge:page/<key>`. The key is a compact JSON, `{"u": page address, "i": item, "t": title, "l": link,
  "d": date (when there is one), "e": 1 (when the page needs its character set repaired)}`, in that order, deflated (raw) and
  written in base64url: at most 380 characters, and the same recipe is always the same key. Over the detector's saved pages the
  keys are 96 to 238 characters long (median 164). Reading a key refuses anything the writer would not make: another spelling, another
  order or extra fields, a document that inflates to more than 4 KiB, an address that is not an http(s) address PURSS may fetch (no
  login in it, no private or internal host, none that looks to carry a key), or an expression outside the grammar. The engine address
  is `http://feed-bridge.internal:8945/b/page/<key>/<signature>`, and the signature covers the key; FreshRSS 1.30.4 keeps a feed address
  in a 32768-character column. A descriptor pasted from an archive is read the same way, so a hand-made one can say only what the grammar
  can: a selection of text and links from a public page, never code.
- **XPathBridge.** The router asks for the page, `item`, `title`, `uri` (the link) and `timestamp` (the date, when there is one), and for
  `fix_encoding` when the page names no character set of its own and is UTF-8 with letters outside ASCII (PHP reads such a page as
  Latin-1; repairing a plain-ASCII page, or one that names its set, would break it). XPathBridge decodes each expression once more, so
  `%` and `+` in one are written `%25` and `%2B`. It is given no cookie, regular expression or other parameter, and it fetches the page once
  per check, through the egress proxy, which checks every hop. It has no limit on posts: the router keeps the first 50. RSS-Bridge cuts a long
  title at 150 characters.
- **Ids.** A post's id is `page:` and its canonical address, written as the detector writes the ids of the samples it shows (https, no
  `www.`, no tracking parameters, no fragment, no trailing slash or `index.html`), so the id outlives a change of recipe; a link that is not an
  http(s) address is dropped. The entries of a changelog on one page are headings of that page, so their fragments are kept. Titles lose the
  whitespace of the page's markup. The source is named by the page's own title, or by the page's site when the page has no single title.
- **Dates.** A post has the date the page shows when the recipe carries it; otherwise it has none, and FreshRSS dates it when it first sees it.
- **Failure.** A recipe that matches nothing, or a page the bridge can't read, is a failure like Instagram's: asked again once, then a `503`
  with the back-off above, never an empty source, and the last good posts stay meanwhile. When a site changes its layout the source goes quiet
  and shows as failing, and the administrator sees it by its page. Following the page again finds a new recipe, which is another key and so
  another source: the first one keeps its posts.
- **Export.** The archive keeps the descriptor. An OPML export writes the page's address, which imports through discovery like any pasted address
  and runs the detector again, so it may offer a different recipe, or none.
- **Limits.** Only the posts the page shows now, the first 50 of them; no older posts. A page that needs script, a login or a cookie can't be read,
  and neither can one over 2 MiB. A site that refuses the bridge's fetch (a datacenter address) fails where it worked for the person. A stored key is
  read whatever made it, but the same recipe is the same key only for the same zlib: after an upgrade of Node a page followed again can make another
  key for the same recipe and show as a second source.

## Instagram

Public Instagram accounts are followed as a bridged source, through the profile's embed widget
(`instagram.com/<name>/embed/`), which RSS-Bridge falls back to and Instagram does not put behind
a login. It carries the latest six posts and can be closed by Instagram. Private accounts and
accounts that switched off embedding cannot be followed.

- Entries are captions. Instagram's picture servers refuse to be shown on other sites, and the
  widget gives videos no address, so a post's text holds no pictures.
- The backend occasionally misreads the widget and answers with no posts, which cannot be told
  from an account with no posts or with its widget switched off. An empty answer is therefore asked
  again once at once and otherwise counts as a failure that keeps the last good posts, so a source
  never looks empty by mistake. An account with nothing to show reads as failing too.
- **Reader.** A post opens with Instagram's own embed loaded above its caption (a reel's video
  plays there). Posts from a feed, on Instagram or Bluesky, are whole in the feed, so neither
  keeping one nor *Save full articles* fetches its page, which shows nothing without the site's
  script or a login.
- **Pictures.** An entry names its pictures for keeping only: the post's lasting
  `/p/<code>/media/?size=l` (the first picture, or a video's still, redirected to a freshly signed
  address) as its picture, then the rest of a carousel by the widget's signed addresses, which
  expire after a few days. A basket that keeps readable text stores them, shrunk to WebP at most
  720 px wide (about a quarter of Instagram's file). Addresses on Instagram's picture servers are
  never shown (`copyOnlyPicture`): lists, cards and the reader show a stored copy or nothing, so a
  post nobody kept has no picture there. A kept post shows its stored pictures as a
  slideshow, with Instagram's embed one press away.

## Journals and Crossref

Wiley, Taylor & Francis, the University of Chicago Press, Berghahn, Project MUSE and
ScienceDirect turn automated readers away, but each journal's feed answers at an address made
from the journal's code or ISSN. A pasted journal or issue page is turned into that address
without opening the page, and the feed is fetched and checked like any other. A DOI or an ISSN is
looked up in Crossref, which names the journal, its publisher and its ISSNs; for a publisher whose
feed address is made from an ISSN (Wiley, Elsevier) that gives the journal's feed. A journal's
feeds are separate choices only when they carry different articles (Wiley's *most recent* and
*current issue* feeds are one feed under two addresses; Early View is a choice of its own). Duke
University Press refuses automated readers and its feed addresses cannot be made from a page
address: discovery finds its journals in Crossref by the name in the address, and says how to copy
the RSS link from the journal's issue page when Crossref does not know it.

**Crossref** is the open registry where publishers register each article's DOI. It is offered as one
more choice for a journal, after the journal's own feeds, on every installation (it needs the
bridge router and not RSS-Bridge).

- **Identity.** `bridge:crossref/<issn>`, the ISSN without its hyphen and with an upper-case check
  character (`bridge:crossref/15348687`). Its page address, and what an OPML export writes, is
  `https://portal.issn.org/resource/ISSN/1534-8687`, which discovery reads back as the same source.
  A bare ISSN is a request for the journal's choices.
- **Which ISSN.** A journal's print and electronic ISSNs have different records in Crossref,
  so a source covers the records of the one it is made from. Discovery uses the first ISSN it
  learned, and Crossref's own lists name the electronic one first. Following the other ISSN
  makes a second source with its own items; the two are not merged.
- **Where the ISSN comes from.** A Wiley journal address whose code is an ISSN (the journal, its
  issues, its article index, its information pages); a DOI, through Crossref's work record; a
  page's scholarly metadata (`citation_issn`, `prism.issn`) or the `issn` of a schema.org
  `Periodical` in its JSON-LD; a pasted ISSN; Wikidata ([Registry fallbacks](#registry-fallbacks));
  or the journal's name searched in Crossref's journal list. A name is accepted only when exactly
  one journal's title matches it letter for letter ("Social Anthropology/Anthropologie sociale" is
  also tried as "Social Anthropology") and, on a platform, its publisher is the platform's (Project
  MUSE hosts many publishers, so the single exact title is enough there). Names come from a journal
  feed that answered on a platform, a Wiley code's feed channel (which still names the journal
  when the feed is switched off), Duke's address slug, and an Open Journal Systems site's own name.
  Other sites are never looked up by name.
- **Placement.** Crossref is added after discovery's ordering, so an unknown *Registered articles*
  label is not ranked above the publisher's feed, and it is never dropped for sharing DOI links
  with it. With a publisher articles feed it is marked an alternative, another way to follow the
  same journal, and never chosen first. Without one it is the journal's own feed and chosen. A
  journal Crossref does not know, or a router that cannot reach Crossref, leaves the answer as it was.
- **Entries.** The article's GUID is `doi:<doi lower-cased>` and its link the doi.org address with each
  part escaped (old DOIs hold `#`, `<` and `;`), so the id survives the router's round trip. The same
  article through the publisher's feed has another GUID, and following both shows both.
- **The request** (`apps/egress/src/bridge/crossref.ts`):
  `GET https://api.crossref.org/journals/<ISSN>/works?sort=created&order=desc&rows=40&select=…`. Sorting
  by `created` (when the DOI was registered) means an old article whose record is corrected does not
  return to the top. It goes through `safeFetch` to a constant origin with the ISSN as the only
  variable part, checked against the key pattern; no redirect is followed, there are 30 seconds and
  4 MiB, and `safeFetch`'s generic User-Agent is sent with no contact address.
- **Pacing.** Crossref's public pool allows one request at a time and five a second for everyone
  behind one address. The backend runs one request at a time across all journals, at least 250 ms
  apart. After a `429` or `503` it asks nothing for any journal until the `Retry-After` it was given
  has passed (at least a minute, at most a day), answering `429` meanwhile, and the router serves each
  journal's last good answer or its usual failure. A preview of a Crossref source goes through the
  same queue. Lookups made when a person pastes something (a DOI's journal, a journal name) are one
  request each and stay outside it.
- **Conversion** (`packages/connectors/src/crossref.ts`, a pure function). One item per
  `journal-article`; the title with its subtitle after a colon; authors as "given family", ten at
  most and then "et al."; the abstract's JATS reduced to plain paragraphs; the date is
  `published-online` when it names a day, else `created`. Other types and front matter (Issue
  Information, Cover Image, Masthead, Editorial Board, Table of Contents) are dropped. The channel is
  named after the journal, or "ISSN 1534-8687" for one without works. A `404` from Crossref is
  `http_404`, a failure.

The preview's note says that Crossref can arrive a few days after the publisher's own feed and that
some publishers send no abstracts.

## Registry fallbacks

When a web address found nothing, discovery asks Wikidata, the open knowledge base, what the page is.

**When it runs.** Only when discovery would otherwise fail, and only after its own answers: no feed
on the page, the lookup's cap on requests used up by the site's own addresses (the registry then gets four
more requests: its search, its items and two of the feeds it names; a redirect a feed answers with
counts once followed, so the step can go a few hops past the four), a page that turns automated readers away (403, 429, "busy or limiting") or is broken
(5xx). Not after a more particular answer (a fediverse post, a page that is not there, one that wants
a password, Duke's message), not for an address made of numbers, not for an address that looks
private, and not when the journal's ISSN is already known, which the Crossref step handles. Asking a
registry puts no load on the site, and whatever it names is checked like any feed.

**What is sent.** The page's address in its spellings (`http` and `https`, with and without `www.`,
with and without a trailing slash), and the site's front page when the page is not it, as one search
(`haswbstatement:P856=<address>|…`, `srlimit=5`), then one `wbgetentities` request for the matching
items. Never a query string or a fragment. A page address too long for one search
sends the front page alone. The requests are discovery's own fetches (`safeFetch`, counted against the
lookup's request cap, no redirects, 8 seconds each), so a slow Wikidata cannot use up the lookup's
time; a failure or timeout leaves discovery's own answer. Nothing is cached: it runs rarely and at a
person's pace. The user guide says what is sent.

**What is used.** Only items whose official website (P856) really is one of the spellings count,
since the search index can lag behind an edit; deprecated claims are ignored.

- **Feeds** (P1019, http and https addresses), at most four, are probed like any feed and offered when
  they answer, with a note that Wikidata, not the site, named them. A feed from the front page's item,
  for a section page, is offered as the whole site's.
- **ISSNs** (P236) of the page's own item (not the front page's, which is not one journal) join the
  journal's ISSNs, and the Crossref step offers the journal.

OpenAlex is not used: it cannot be asked which journal an address belongs to.

## Big feeds

FreshRSS parses a feed whole in PHP's 128 MB limit, and the largest podcast feeds are tens of
megabytes. Such a feed reaches the engine through the egress feed gateway, which reads it as a stream
and serves the engine the channel's metadata and the newest 50 items, otherwise byte for byte. Fifty is
the least the engine keeps of any feed. The gateway never inserts items.

- **Address.** `http://feed-gateway.internal:8947/t/<signature>/<address>`, the feed's address in
  base64url, signed with an HMAC-SHA-256 under `secrets/feed-trim-key`. The same feed always has the same
  address, so accounts that follow it share the engine's one fetch. The source's own address stays the
  feed's: it is what is shown, exported and compared. `sources.via_gateway` records that the engine
  holds the gateway's address.
- **When a feed goes through it.** At follow time, discovery reads a feed up to 4 MiB; a feed cut there,
  or one with more than 1,000 items in what was read, is marked large (never sent to the browser), and
  following it makes the subscription go through the gateway. RSS, Atom and RDF only: a JSON Feed is read
  by the engine as it is. A private link goes through the gateway the same way.
- **Subscriptions the engine fails on.** When the engine's own subscribe fails with no reason about the
  feed's site (an HTTP 500, a dropped connection, or its download limit) for a web address, the worker
  checks whether the feed really is that big (a streaming size check that stops at 4 MiB or 1,000 items)
  and, if so, subscribes at the gateway and the source is marked. The API's maintenance tick tries the
  sources stuck on *The site isn't answering right now* once more for the same. A source that works is
  left as it is.
- **What a person sees.** Nothing about size. A big feed is an ordinary source whose first items are its
  newest, and no message in the product speaks of it. Without the key, the engine gets the feed as it is
  and fails on it if it must, with the generic message.
- **Failures.** The feed's own `404`/`410`, `403` and `429` are passed on; an unreachable, slow or broken
  host is `502`/`504`; something that is not a feed, an unreadable encoding (UTF-16) or channel details
  over 1 MiB is `422`. Never an empty feed.

The trimmer, its limits, sharing and memory are in the [egress README](../apps/egress/README.md#feed-trimming-big-feeds).

## Keeping a source fed

- **Engine cache sharing.** FreshRSS keeps one HTTP cache for all its users, keyed by feed address and
  fetch options, so accounts that follow the same feed cost the engine one fetch, not one each. Two
  things close the remaining gaps: the worker serialises the first follows of one public address (a
  private link is excluded), so the followers after the first find its fetch in the cache, and the
  engine's minimum cache window is 800 seconds, so a feed that sends `no-cache` or `no-store` is not
  fetched again for each user within one refresh run. A private feed's address carries its own
  credentials, so its cache entries stay its own. A site's own per-address request limits are a separate
  matter.
- **Back catalogue.** What a source already had when it was followed is not New and sends no
  notification. A source is settled once a sync walk that began after the engine confirmed the
  subscription has finished; until then an entry published (or, with no date, crawled) before the follow
  is back catalogue, and so is every undated one. With *Start from now*, the choice Add source starts on
  and the one an OPML import uses, the back catalogue is stored as Ignored: hidden from lists by default,
  left out of Home, counts and digests, and found by search. With *Also show posts from the last week as
  New*, entries published in the seven days before the follow are New like any arrival. A source stored with
  the start choice `all` shows its back catalogue as ordinary older items; Add source does not offer it.
  Following the same feed again starts a fresh follow with its own choice. The user guide's [Sources](user-guide.md#sources)
  section describes it from the reader's side.
- **Retention.** FreshRSS purges entries by its own policy (90 days, at least 50 and at most 1,000 per
  feed) and offers no deletion signal, so a long outage can lose entries that were never passed on. PURSS
  never infers a deletion from an entry's absence, and the sync health notice says that a long gap cannot
  be filled in. See [the FreshRSS adapter](../packages/freshrss/README.md).
