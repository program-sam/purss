# Architecture

How the parts fit together today. Rationale and alternatives are in the plan:
[architecture](../plan/05-architecture.md), [FreshRSS integration](../plan/06-freshrss-integration.md),
[baskets and retention](../plan/07-baskets-and-retention.md),
[storage and ownership](../plan/17-storage-and-ownership.md),
[unified source pipeline](../plan/20-unified-source-pipeline.md),
[implementation decisions](../plan/22-implementation.md), [media and playback](../plan/25-media-playback.md) and
[the browser extension](../plan/32-browser-extension.md).

## Components

```text
 browser ──HTTPS──► api ── public listener :8940 ── website /, web app /app/, /api, /api/events (SSE), /p/<slug>
                     │
                     │  sole writer of product.db (SQLite, WAL, FTS5)
                     │
                     └─ internal listener :8948 ◄── worker   (service token)
                                                      │
                          GReader API + fixed admin ops│
                                                      ▼
 internet ◄── egress proxy :8946 ◄── all fetches ── FreshRSS (no other route out)
              feed gateway :8947 ──► FreshRSS (private feeds; no adapters registered)
              bridge router :8945 ──► FreshRSS (via the proxy alias) and api previews; asks RSS-Bridge
              control :8949 ◄── api (status, bridge fetch log)
 internet ◄── egress proxy + DNS (bridge network) ◄── RSS-Bridge (no other route out)
```

| Component | Code | Responsibility |
| --- | --- | --- |
| Web app | `apps/web` | React app served by the API at `/app/`; its requests go only to `/api` (feed images, and the audio and video it plays, load from publishers) |
| Phone apps | `apps/mobile` | The web app's build in a Capacitor shell for Android and iOS, talking to a connected PURSS's `/api` with a device token |
| Website | `apps/site` | Static public website, served by the API at `/` in hosted mode; self-hosted, `/` opens the app |
| API | `apps/api` | Sessions, authorization, product database, search, storage ledger, job queue, share pages, maintenance tick |
| Worker | `apps/worker` | Leases jobs over the internal listener; talks to FreshRSS; runs readable-text capture and media downloads; never opens the database |
| Egress | `apps/egress` | Forward proxy enforcing address rules for FreshRSS and RSS-Bridge; private feed gateway; bridge router and its fetch log; control listener |
| RSS-Bridge | `infra/compose.yaml` (`bridge`), `scripts/bridge.ts` | Turns the public pages of a few services without feeds (Telegram, Bandcamp, SoundCloud, Twitch, Mixcloud, Rutube, Apple Music) into feeds; pinned upstream image, only the catalogued bridges enabled |
| FreshRSS | `infra/engine` | Polls feeds on a schedule and holds recent entries; a bounded buffer, not a library |
| Push relay | `apps/push-relay` | Run by the project, apart from any PURSS: holds the phone apps' FCM and APNs credentials and wakes a phone by handle, without content |
| Browser extension | `apps/extension` | Popup, right-click menu, address-bar search and browser-assisted capture in the person's browser; talks only to the PURSS it is connected to, with a device token |
| Domain | `packages/domain` | IDs, workflow states, query tree, API and job contracts |
| Connectors | `packages/connectors` | Safe fetch, discovery, feed parsing, readable capture, OPML |
| FreshRSS adapter | `packages/freshrss` | GReader client, sync walk, fixed admin commands, local engine lifecycle |

## Ownership rules

- **The API is the only database writer.** The worker posts results; the API commits them.
- **Product data is tenant-scoped,** directly by `account_id`/`workspace_id` or through an owned
  parent row. Queries resolve a principal from the session first and enforce that ownership.
  Each account has its own FreshRSS user, but FreshRSS shares its fetch cache across users (keyed by feed address), so accounts following one public feed cost one request per refresh run, and each account still stores its own items.
- **FreshRSS is a black box:** reached only through its GReader API and a closed set of
  admin commands (`podman exec` locally, the token-protected helper under Compose). The
  product never reads its database.
- **Durable jobs are enqueued in the same transaction** as the change that needs them
  (`jobs` table), so a crash can't lose or half-apply a follow, sync or capture.

## Flows

**Adding a source.** The API runs discovery (`packages/connectors`, safe fetch) and holds the
candidates in memory behind opaque tokens. Following one inserts the source and an
`engine.subscribe` job in one transaction. Private feed URLs go to `secrets/source-urls/` and
never into the database or job payloads; the job refers to them by name. To recognise the same
private link a second time, the source row keeps `feed_key`: an HMAC-SHA-256 of the workspace and the
normalised link, made with `secrets/feed-key`. The database holds a fingerprint of that key
(`installation.feed_key_check`); when the file is lost, damaged or replaced, the API logs a warning at
the next start and makes every private source's key again from its link file.

**Installation news.** Administrators' posts live in `news_posts`. Publishing one (and the
maintenance tick) gives every usable PURSS that never had it a source with `builtin = 'news'`
and its newest three posts, then writes each published post into every followed, unpaused news
source created before it, through the same `insertItem` as feed items; `news_deliveries` records
each post per workspace, so nothing arrives twice and a deleted copy stays deleted. No engine
subscription exists for it, and discovery recognises the installation's own `/news` address
without fetching. Edits go through the feed edit path (a kept version stays); deleting a post
deletes the unkept copies. `/news`, `/news/<id>` and `/news/feed.atom` are public pages.

**Bridged sources** ([plan/41](../plan/41-source-bridges.md)). A page of a catalogued service
(`packages/connectors/src/bridges.ts`) is discovered as the descriptor `bridge:<service>/<key>`,
previewed by the API through the bridge router, and stored as the source's feed address; exports
write the service's page instead. Only the worker turns the descriptor into an engine address,
`http://feed-bridge.internal:8945/b/<service>/<key>/<HMAC>` under `secrets/bridge-key`, so the
router answers nothing a feed could redirect FreshRSS to. The router asks RSS-Bridge (one fetch
per source at a time, four at once, ten-minute cache, back-off after failures), gives every entry
the post's own id (`telegram:durov/552`) so a backend change keeps items, never serves a failure
as an empty feed, and records each answer in the fetch log the Service health page reads.

**Collecting items.** FreshRSS refreshes feeds on its cron (minutes 3, 18, 33, 48), fetching
through egress. The API's maintenance tick (every 15 s) enqueues an `engine.sync` per account
when the last attempt is older than `PURSS_SYNC_INTERVAL`. The worker walks the reading list
forward from the stored checkpoint, oldest first, and posts each page as one or more bounded
batches (only the last advances the checkpoint); the API commits the items, their mappings and
the checkpoint in one transaction. Batch keys are
deterministic, so a retried page is a no-op. A missing entry never deletes anything.

**Engine identity and review.** Each batch carries the engine's identity (derived from its
install salt). If it changes after history exists, for example when FreshRSS's data was
replaced, new entries go to a reconciliation queue instead of being added, and the owner resolves
them on the Review page.

**State.** Workflow, the New marker (`fresh`), reading progress, collection membership and basket membership
are separate fields and tables. State changes carry `expectedRevision` (409 on conflict) and
return an undo token (15 minutes). Opening an item or changing its workflow, progress or basket membership
clears its New marker in the same change, and Undo restores it. Finished and Ignored are mirrored to FreshRSS as read
through `engine.mark_read` jobs. Every workflow change (single, bulk, undo) also appends a row
to `state_log` in the same transaction; the private statistics (`/api/stats/...`) read it and
the item tables, and its rows go with their item and travel in the export.

**Coming back.** New markers are only the `fresh` field of an item's state. An entry a source already had when it
was followed (published, or undated, before the follow time, until a sync walk that began after the engine confirmed the
subscription has finished) is stored without one and tells no one. Opening an item, finishing it or ignoring it clears the marker in the same change; a pass in the
tick (`services/returning.ts`, throttled: every five minutes and every hour) expires markers older than the person's
choice, resumes sources whose pause ran out, makes the digest that has come due, tells about sources that stopped
working and failed text saves, and prunes notifications. `POST /api/activity/visit`, sent by the web app from any page on foreground interaction, records the start of a visit (after 30
minutes of quiet) and `GET /api/home` returns, read-only, what Home says before its boxes (Recently kept and filter collections
leave out what Home leaves out, `services/home-sources.ts`; an item is in the first section that has it). `GET /api/items?mix=home` is a list as Home shows it (its boxes
and its one feed, with `filter=open`: New and To read): only sources with a box on Home, New items first and then the rest, newest first within each, listed as two
runs in date order and paged from a snapshot of the newest item when paging began. Lists also take `type`, `length`, `source`, `without` (one source left out) and
`capture=failed`; with `mix=home` these narrow what Home would show (hidden collections stay out). Unless `muted=show`, lists leave out the items the PURSS's muted words match (title or summary, whole words, kept in the preferences; matched on the row
a query looks at by the SQL function `purss_muted`, so the cost follows the rows looked at, never other workspaces or how many items a word matches; words are
compared as the text index compares them, so accents are dropped from Latin letters only, and a section or page asks about the rows it takes once they are in
order); the first page says how many (`mutedHidden`, counted among the first 1,000 candidates; `mutedHiddenAtLeast` says when a longer list was counted in part,
and Home's To read `total` is then an upper bound, `totalAtMost`). `mix=home` refuses `q` and any order but newest.
The web app asks again for what it shows when the page or the app comes back to the front, so changes made on another device show up.
The search index records which version it is being rebuilt for and how far it got, for items and for the person's notes, so an interrupted rebuild is
never mistaken for one of a later version. `GET /api/activity` summarises the job queue, the sync checkpoint and recent
arrivals for the sidebar's activity line. `services/notifications.ts` is the one place that decides who is told what
and when; `digestFor` counts a digest for a window and is what email would reuse.

**Keeping.** An item's content lives in immutable `item_versions`. Keeping inserts a basket
membership that pins the current version, in one transaction with its storage record; an
edited feed entry becomes a new version and the pinned one stays. Unpinned superseded versions
are released. In a "Save readable text" basket, keeping also reserves storage and enqueues a
`capture.fulltext` job; the worker fetches the page and extracts readable text, and the API
settles the reservation to the real size or releases it on failure. A source with full articles
on (`sources.full_text`) gets the same capture for every new item, queued in the sync batch's
transaction and spaced a few seconds apart per PURSS. These optional copies reserve nothing,
so they never hold room the items themselves need: each is admitted when it completes if it fits,
and is otherwise dropped without marking growth paused.

**Is it the page?** A finished capture is checked before it is called the full text (`assessCapture` in
`@purss/connectors`, run by `completeCapture` with the length of the feed's own text for the item): a sign-in,
subscription, consent or security-check page (`gated`), a body that is mostly a reference list (`references`)
or one under 60% of the feed's own text (`short`) is stored as `quality = 'partial'` with its reason. It stays
stored and counted, but is not "Full text captured": the item's detail returns the feed's own text as
`contentHtml` and the capture as `partialCopy` for a toggle, and the capture sets no reading time and is not
searched. Captures from before the check are checked in the background at start-up; browser captures are the
person's browser's own text and are not checked. One meaning of "has a copy" runs through all of it
(`services/capture-state.ts`): an item has a *settled* copy when one is pending, or finished and passed the checks.
A partial copy is kept and shown but does not settle the item, so a try that fails after it is a failed copy: told
about in the bell and listed by `capture=failed`. Any finished copy, partial included, stops anything from fetching the
page again by itself (keeping the item into another basket, a source's full-articles setting); only Try again does.
Its result replaces the copy only when it is better: full beats partial, and a partial one ranks by its reason before
its length (a fragment of the article, `short`, then a bibliography, `references`, then a wall, `gated`; the length only
breaks a tie between the same reason), so real text is never replaced by a wall however long. A result that is no better
is not kept and the room held for it is given back, but it is recorded as a failed try carrying the reason: the item
stays listed and told about as failed to improve, and its panel says "Tried again, nothing better". A failed capture names its source in the bell, once per source and day, counting items,
and only where the person asked for text (`captures.requested`: Keep in a basket that keeps text, "Keep readable text
too", Try again; or the source's full articles; or a text basket holds the item) (`notifyCaptureFailures`); a kept link or
an item of an unfollowed source has no feed to open, so its notification names the basket instead. `GET /api/items?capture=failed`
lists the items such a notification opens.

**Pictures in kept copies.** An item held by a basket that keeps readable text also keeps its own picture and
the pictures in its text (those of the readable copy, or of the feed's text until a complete copy exists): keeping
it, or its copy completing or failing, or the person's browser replacing its text, queues one `capture.images` job (`queueItemImages`) naming the missing
addresses, at most 20 pictures and 10 MB per item. Pictures are optional: queueing them runs in its own savepoint and
logs instead of throwing, so it cannot break keeping, a copy completing or failing, or the recovery of expired leases. The worker fetches them with `fetchPictures` (safe-fetch rules,
type read from the bytes, no SVG) and answers with the bytes in the job result, which the API checks again and
stores in `item_images`, each counted once as an `image` object (no reservation: a picture that does not fit is
left out and growth is not paused). They belong to the item, not to a basket, so an item in two baskets has one
set; like readable copies they count as kept while a basket holds the item, and go with the item, the account, or
a cleanup that deletes it. The reader's text points at `GET /api/items/:id/images/:imageId` for stored pictures
and keeps the original address for the rest. Exports carry them in an optional `images` section.

**Media.** The server stores no audio or video files. An item whose feed offers one (an enclosure; never for
private sources) reports its address, kind and the type and size the feed declares; the web player streams it
from the publisher over `https`, and the mobile apps can download it to the device from the publisher too.
Playback positions are their own table, separate from reading progress, workflow and revisions. See
[plan/25](../plan/25-media-playback.md).

**Highlights and notes.** The person's annotations live in `annotations`, apart from workflow,
collections, baskets and retention (plan/26). The web app chooses each annotation's id, so it can be
made offline, and sends the whole annotation with the time it was changed: `PUT` and `DELETE`
`/api/items/:id/annotations/:annotationId` are idempotent and the later write wins. A removal clears the
text and leaves a tombstone, kept as long as the item, so an old offline change can't bring a removed
one back however late it arrives; an annotation the server has no row for is new, so it is accepted
whatever the device's clock says. A highlight stores its passage
with some text before and after it and its position in the reader's text, and names the capture or
version it was made on; the reader finds it again by its words and lists one it can't find as
detached. Annotations pin nothing; each live one is a small "Other" record in the ledger, admitted with
the control headroom. Search covers them through `annotations_fts`. Rule-based deletion (storage
cleanup, unfollow with delete) skips annotated items, which stay visible after their source is
unfollowed; an explicit permanent delete names them and removes their annotations with the item.
They are exported and imported, never shared, and the MCP `get_item` tool returns them labelled as
the person's own text.

**Source icons.** Every tick queues a `source.icon` job for followed sources that were never
checked or were last checked more than a week ago, with the feed link redacted for private
sources. The worker finds and re-encodes the icon (see the connectors README) and posts back
a WebP. The API checks it is one and stores it in `source_icons`, one per source. A check
that finds nothing keeps the stored icon. The web app loads it from
`/api/sources/:id/icon?v=<digest>`, which only the owning PURSS can read; the response is
cached privately and sent with a sandboxing CSP. Icons are re-derivable, so they are not
exported or counted against storage quota.

**Storage ledger.** Usage is the sum of measured, live stored objects (item versions, captures,
small records), classified once as kept, feed-only or other. Admission happens inside the
writing transaction against the allocation plus reservations; small state writes get a bounded
headroom. A full quota or low disk pauses growth (sync batches are retried later) and never
evicts kept content. Deletion releases at the last reference and is never blocked by quota.

**Account deletion.** Asking to delete an account (a recent sign-in plus the typed display name)
inserts an `account_deletions` row, `pending` for 7 days, in one transaction that also signs the
account out everywhere (`signOutEverywhere(…, "everything")`: sessions, connected apps' device
tokens, connection and OAuth codes, assistant tokens and OAuth grants, unused email links),
pauses its shared pages and puts its running jobs back in the queue with their attempt
refunded. An account is *usable* only when it is active and has no such row; sessions, device
tokens, assistant tokens, OAuth access and refresh tokens, job leasing,
heartbeats and results,
admin retries, scheduled syncs, icon checks and reminders all check that, so a suspended or
deleting account's jobs wait and resume intact. Requests re-check their session or token after
reading the body, and writes of new credentials re-check it in their transaction. Signing in
during the grace period starts no session; a single-use `purss_deletion` cookie (10 minutes, bound
to the request) lets that browser keep the account. When the row is due, the tick marks up to two
accounts a time `purging` with a manifest of their data-directory files (private feed links,
staged imports), removes
those files, then deletes every product row of the account in one transaction, children before
parents (annotations and their search rows and playback positions before
items; device tokens, codes, OAuth grants, email links and queued mail with the credentials; the
account's address cleared, its `mail_log` lines kept without the account id), and queues
`engine.delete_user`. The worker records an
attempt, runs FreshRSS's `delete-user.php`, confirms with `list-users.php`, deletes the engine
user's password file and asks the API to finalize, which deletes the engine bookkeeping, the
job, the workspace and the account. A user missing after an unconfirmed attempt waits for an
administrator to confirm instead. Only the audit log keeps the bare account id.

**Live updates.** The API keeps an in-process event emitter per account and streams changes to
open pages over `/api/events`; the web app refetches what changed.

**Offline reading.** The web app registers a hand-written service worker (`/app/sw.js`, built with the app, scoped to `/app/`). It saves
the app shell per build (page, built files, manifest and icons) and nothing personal. Only when
"Offline reading on this device" is on and an account is known does it also keep GET answers for the
person's own reading (session, bootstrap, preferences, notifications, reminders, item lists and
details, an item's annotations, statistics; never `/api/events`, sign-in, administration, exports,
storage, search or public pages) in a cache named for that account, serving them with an
`x-purss-offline` header when the network fails or is slow. The worker never intercepts or queues
changes. The page keeps the reading queue (To read, In progress, New and Undecided; up to 200 items)
saved by fetching the same lists, item details and annotations the pages use, at most every 15
minutes. Annotation changes alone go through an outbox in the page's IndexedDB (`purss-annotations`):
each is recorded there first, replaces any unsent change of the same annotation, and is sent in order
when the connection allows; entries belong to an account and are deleted at sign-out or when another
account signs in. Another account, sign-out, an expired session or
turning the setting off deletes the copies. Article images are not saved.

**Sharing.** A publication has its own membership and stores a share-safe snapshot per item.
The public listener serves `/p/<slug>` and `/p/<slug>/feed.atom` for published ones only,
rate-limited per address. Publishing is refused in hosted mode. Every page has one address: a
`GET` or `HEAD` of a page path with a trailing or doubled slash (`/p/<slug>/`, `/signin/`) is
redirected (301) to it; `/api` answers only at its exact paths.

**Export and import.** Export streams a JSON archive with a manifest of counts and hashes,
secret-free, and works over quota. Import stages and previews first (including whether it
fits the allocation), then applies.

**Assistants (MCP).** `POST /mcp` on the public listener is handled before cookies are read
(`apps/api/src/mcp`). A personal access token resolves to its account's principal (never an
administrator, never a recent sign-in) only while the installation and the account both have
assistant access on. Tools call the same services as the web routes, so scoping, storage
admission and bulk changes behave the same; write calls are audited. The server answers
both the current protocol (per-request version, `server/discover`) and the older `initialize`
handshake, with JSON and no sessions. See [plan/23](../plan/23-assistant-access.md).

**Assistant OAuth.** Where the installation offers it (hosted mode, or `PURSS_ASSISTANT_OAUTH=on`),
`/mcp` is also an OAuth 2.1 protected resource (`apps/api/src/oauth`): its 401 points to the
protected resource metadata, the API serves authorization server metadata, `/oauth/token` and
`/oauth/revoke` (no cookies, no CORS), and `/oauth/authorize` is a consent page of the web app.
Clients identify themselves with a client metadata document fetched through `safeFetch` (5 kB, 5 s,
no redirects, cached). Codes come from the same core as connected apps; access tokens last an hour,
refresh tokens rotate and a reused one revokes the grant. An OAuth access token resolves to the
same caller a personal access token of that level would, under the same two switches. See
[plan/33](../plan/33-assistant-oauth.md).

**Connected apps.** The mobile app and the browser extension connect through `/connect` in the
system browser: the signed-in person approves (same origin, CSRF, recent sign-in), the API issues a
one-time code bound to the app's PKCE challenge and fixed return address, and the app exchanges it
at `POST /api/connect/token` for a device token (`apps/api/src/connect`). On `/api`, a request with
`Authorization: Bearer purss_dev_…` is decided before cookies are read: cookies are ignored, the
Origin/CSRF check doesn't apply, CORS answers the apps' origins without credentials, and the token
reaches only its kind's routes (the extension an exact list; the mobile app everything but sign-in,
security, administration and app management). It is never an administrator or a recent sign-in.
Requests without it take the cookie path unchanged. See [plan/24](../plan/24-connected-apps.md).

**Phone apps.** `apps/mobile` bundles the web app's build in Capacitor. The connected server also
offers the build of the interface it runs (`GET /api/app/bundle`, packed by the server image), which
the app installs when it fits the app's native code; see [plan/39](../plan/39-live-updates.md). What differs from a browser is behind `apps/web/src/platform/`: requests go to the connected
origin with the device token (token in the Keychain or Android Keystore), live updates are read with
fetch, the offline worker that the web's service worker runs is called in the page with copies in
IndexedDB, audio plays in the system's player (a foreground media service on Android), and
*Downloaded* keeps device copies of items and their media on the device only (for an
item PURSS has only a summary of, the app reads the article from the publisher's `https` page
itself and keeps it on the device only; PURSS's own capture pipeline isn't involved). See
[plan/31](../plan/31-mobile-apps.md).

**Notifications on the phone.** A phone app that turns them on registers its push address with the
project's push relay (`apps/push-relay`, deployed on its own), gives PURSS only the relay's handle
(`push_devices`, per device token) and gets a narrow fetch credential for its native code. When a
notification is made or grows, the API (`services/push.ts`), outside quiet hours and unless notifications
are off, asks the relay through `safeFetch` to wake the phone; the push carries no text, and the phone
fetches the texts with `POST /api/push/pending`. See [plan/37](../plan/37-push-notifications.md).

**Keeping a link.** `items.url_key` is a comparison key of the item's address (scheme, case,
default port, trailing slash, fragment and tracking parameters normalised; `services/url-key.ts`),
indexed per workspace. Keeping a link PURSS already has keeps that item;
`GET /api/items/lookup` answers what PURSS has for a page.

**Browser extension and deep links.** `/?dialog=add&url=…`, `/?dialog=keep&url=…&title=…` and
`/?dialog=search&q=…` open Add source (filled in, nothing looked up until Find), a Keep dialog with a
basket choice, or search; a signed-out visit returns to them after sign-in. The bookmarklets in
Settings only open these. The extension (`apps/extension`, Manifest V3, one build for Chromium,
Firefox and Safari) reads the open page only when the person opens its popup or right-click menu
(`activeTab`): feed hints from `<link rel="alternate">` and YouTube addresses go to Add source by deep
link, never fetched by the extension. On request it extracts the page's readable text with
Readability and posts it to `POST /api/items/browser-capture`, which keeps the page like Keep link and
stores the sanitized HTML as a capture of kind `browser` (one per item, replaced in place, admitted
against storage, never fetched by the server). The reader labels it "Captured in your browser". See
[plan/32](../plan/32-browser-extension.md). Every HTML sanitizer and parser input (feeds, captures,
browser captures, imports, OPML) is first read once by `assertShallowMarkup` in
`packages/connectors/src/text.ts`, which counts nesting and parser events exactly as htmlparser2
reads them, in linear time; stored content beyond the bounds keeps only its text, as paragraphs.

**Outgoing email.** Optional (`PURSS_SMTP_*`, `PURSS_MAIL_FROM`; `apps/api/src/mail`). The API sends
through nodemailer: invitation links, and account address confirmation, password-reset links and
change notices. Account addresses exist only where email is set up (`accountEmailAvailable`), in
any mode; only hosted open sign-up requires one. Messages that must not reveal whether an account
exists are sent after the response, through a queue in the database (`mail_queue`, sealed with a key
from the secrets folder) that survives restarts and retries while the server is down. Links are single-use tokens stored as SHA-256 in `email_tokens`; `mail_log` keeps kind,
masked recipient, outcome and error code, never a body. The server is checked at start and every 10
minutes while failing; hosted open sign-up is open only while that check passes. See
[plan/27](../plan/27-outbound-email.md).

## Where data lives

| Data | Location |
| --- | --- |
| Product data, search index | `product.db` (SQLite) |
| Assistant tokens | `product.db`, `assistant_tokens` (SHA-256 of each token only) |
| Assistants connected with OAuth | `product.db`, `oauth_grants` (what was approved, the SHA-256 of its current refresh token and that token's generation), `oauth_access_tokens` (SHA-256 only), `oauth_refreshes` (the last hour's refreshes, for the limits); pending codes in `connect_codes` |
| Connected apps | `product.db`, `device_tokens` (SHA-256 only) and `connect_codes` (pending one-time codes, SHA-256 only, minutes long) |
| Phones' notification registrations | `product.db`, `push_devices` (relay handle, SHA-256 of the fetch credential, what was handed; goes with its device token); the push relay keeps its own `relay.db` |
| Account email | `product.db`: `accounts.email` (optional), `email_tokens` (SHA-256 of each link), `mail_queue` (messages waiting to be sent, sealed with `secrets/mail-queue-key`, at most a day), `mail_log` (no bodies, 90 days) |
| Account deletions | `product.db`, `account_deletions` (one row per account being deleted, gone with the account) |
| Installation news | `product.db`: `news_posts` (posts; the author link is cleared when that account is deleted), `news_deliveries` (which workspace got which post, for its copy and the counts) |
| Sites people couldn't follow | `product.db`, `discovery_misses`: per UTC day, the site (registrable domain) and the failure reason, with a count; 180 days. No account, workspace or address is stored, so it is no part of any account's data or export |
| Secrets | `secrets/`: service token, setup code, engine operator and engine-user passwords, private source URLs, `oauth-refresh-key` (signs OAuth refresh tokens) |
| Gateway state | `egress/gateway.db` (egress's own SQLite file) |
| FreshRSS data | `engine/` locally, the `engine-data` volume under Compose |
| Offline copies | The browser's own Cache Storage on each device (`purss-api:<account>`), plus a small record in its local storage; never on the server, deleted at sign-out |
| Browser extension | The browser's extension storage on each device: the PURSS address, its device token, basket names for the menu, settings; never synced |
| Unsent annotation changes | The browser's IndexedDB on each device (`purss-annotations`), until sent; deleted at sign-out |

Backups cover `product.db` and optionally `secrets/`; see
[self-hosting](self-hosting.md#backups-and-restore).
