# Architecture

How the parts fit together. Neighbouring pages: [security](security.md) for the threat model and the
controls behind it, [storage and retention](storage-and-retention.md) for what is kept, counted and
deleted, [sources](sources.md) for how pages become feeds, [assistants](assistants.md) for the MCP server,
and [development](development.md#testing-and-acceptance) for how the parts are tested.

## Principles

- **FreshRSS is the only ingestion engine.** It polls feeds; PURSS reads its entries through the GReader
  API. A service that has no feed is turned into one (the bridge router) and followed like any other, and a
  feed too big for the engine reaches it as a smaller copy (the feed gateway), so no connector writes
  product items itself. Only what has nothing to poll is written directly: pages the person keeps by hand
  and the installation's own news posts.
- **The product owns what a reader keeps.** Item IDs, workflow, baskets, annotations and search live in
  PURSS's own database. FreshRSS holds a bounded buffer of recent entries, not a library.
- **Separate facts stay separate.** Reading progress, workflow state, collection membership, basket
  membership and retention are different fields or tables. Opening an item never finishes it, putting a
  source in a collection keeps nothing, and only a basket pins content.
- **Nothing is ranked by engagement.** Lists follow the date, source, title or keep order the person
  picks. AI is optional: Smart filters run only where an administrator has added a key.
- **What is not supported is said to be.** A page with no feed PURSS can read is reported with the
  reason instead of becoming a source that stays empty.

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
              feed gateway :8947 ──► FreshRSS (big feeds, trimmed to their newest items)
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
| Worker | `apps/worker` | Leases jobs over the internal listener; talks to FreshRSS; runs readable-text capture, kept-picture and source-icon fetches and Smart-filter judging; never opens the database |
| Egress | `apps/egress` | Forward proxy enforcing address rules for FreshRSS and RSS-Bridge; feed gateway (trimmed copies of big feeds); bridge router and its fetch log; control listener |
| RSS-Bridge | `infra/compose.yaml` (`bridge`), `scripts/bridge.ts` | Turns the public pages of a few services without feeds (Telegram, Bandcamp, SoundCloud, Twitch, Mixcloud, Rutube, Apple Music, Instagram) into feeds; pinned upstream image, only the catalogued bridges enabled |
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

## Identity and reconciliation

Every item has a stable product ID (`itm_` and 26 characters: ten of time, sixteen random). Nothing the
engine does changes it: it survives the engine's replacement, unfollowing the source and the publisher
dropping the entry, and every other row refers to the item by it.

The link to the engine is a separate row in `external_ids`: the engine's entry ID, its stream and the engine
user it came from. Mappings are scoped to that engine user, never to a bare number. The entry ID is the
engine's first-crawl timestamp, and the GReader stream carries no publisher GUID, so matching works on
addresses, not GUIDs.

- **An entry with no mapping** is matched to an existing item of the same source before it becomes a second
  one: an imported item with the same link, or, for a post a feed reissues, the same normalised link
  (`items.link_key`: scheme, `www.`, tracking parameters and trailing slashes ignored) and the same title.
  The match is made only when it is unique; with several candidates the entry becomes an item of its own.
  Matching adds a mapping to the existing item. PURSS never merges two existing items.
- **A replaced engine** is recognised by its identity, a hash of the install salt FreshRSS generates once
  (`freshrss:` and 32 hex characters), which survives restarts, upgrades and a restore of the same data
  directory and changes for a fresh installation. Each sync batch carries it. When it differs from the stored
  one and the account already has history, the batch's entries go to the reconciliation queue
  (`reconciliation_queue`, one open row per entry) instead of becoming items, and the new identity waits as
  `pending_engine_identity`.
- **The Review page** lists the queue (`apps/api/src/services/reconcile.ts`). Each entry suggests *match*
  (the only item of that source with the same link), *new* (nothing matches) or *review* (several items share
  the link). The person decides one entry at a time (match it to an item, add it as a new item, or dismiss
  it), or accepts every entry that has one clear match; ambiguous entries are never matched for them. Each
  decision is one transaction and cannot be applied twice, and an entry for an item the person deleted is
  never added again. The replacement engine is adopted when the queue has no open entries.

## Data model

One SQLite file, `product.db`, written only by the API. Migrations are numbered SQL files in
`apps/api/src/db/migrations/`, applied in order whenever the database is opened, each in its own
transaction.

| Area | Main tables | Holds |
| --- | --- | --- |
| Accounts | `accounts`, `workspaces`, `sessions`, `sign_in_methods`, `auth_challenges`, `role_grants`, `invites`, `email_tokens`, `signup_requests`, `account_deletions` | One workspace per account (the unit every product row belongs to), sign-in methods, sessions, administrator grants, invitations, email links, deletion requests |
| Credentials of other programs | `device_tokens`, `connect_codes`, `assistant_tokens`, `oauth_grants`, `oauth_access_tokens`, `oauth_refreshes`, `push_devices` | Connected apps, assistants and phones; only SHA-256 of each secret |
| Sources and the engine | `sources`, `source_icons`, `engine_users`, `sync_checkpoints`, `applied_batches`, `external_ids`, `item_tombstones`, `reconciliation_queue`, `opml_imports`, `opml_import_entries` | What is followed (a private source's link is a file, not a column), each account's FreshRSS user, where the sync walk stands, the batches already applied, entry-to-item mappings, deleted entries, review entries |
| Items | `items`, `item_versions`, `item_state`, `state_log`, `captures`, `item_images`, `annotations`, `playback_positions`, `item_reminders`, `reminders` | An item (kind, link, `url_key`, `link_key`, date, current version), its immutable versions, its workflow state and progress, workflow history, readable copies, kept pictures, the person's highlights and notes, playback position, reminders |
| Search | `items_fts`, `annotations_fts`, `search_index_state` | Full-text indexes over items and the person's notes, and how far a rebuild got |
| Organising | `baskets`, `basket_items`, `collections`, `collection_sources`, `preferences`, `undo_tokens`, `confirm_tokens`, `import_stages` | Baskets and their pins (each names the version it keeps), collections and their query trees, preferences, 15-minute undo records, preview tokens for confirmed actions, staged imports |
| Sharing | `shares`, `share_notes`, `share_reports` | Public pages of baskets and collections, the person's public notes, reports about a page |
| Storage ledger | `storage_accounts`, `stored_objects`, `usage_events`, `reservations` | Allocation and used bytes per account, each measured stored object, its byte history, reservations held by jobs in flight |
| Work | `jobs` | Durable background work with leases, attempts and idempotency keys |
| Notifications and mail | `notifications`, `notification_state`, `mail_queue`, `mail_log` | The bell, digests, queued and logged outgoing messages |
| Smart filters | `ai_filters`, `ai_filter_verdicts`, `ai_usage` | Filters, what they decided about each post, weekly use |
| Installation | `installation`, `news_posts`, `news_deliveries`, `audit_events`, `discovery_*` | Installation settings, the news feed and its deliveries, the audit log, discovery aggregates (counts only) and the sites people could not follow |

Every table that holds a person's data carries `account_id` or `workspace_id`, or reaches one through
its owning row. [Storage and retention](storage-and-retention.md) says which of these rows are metered.

## Sync

FreshRSS refreshes feeds on its cron (minutes 3, 18, 33, 48), fetching through egress. The API's
maintenance tick (every 15 s) enqueues an `engine.sync` for each account whose last attempt is older than
`PURSS_SYNC_INTERVAL` (120 s by default; a run that keeps failing waits 1, 5, 15, then 60 minutes). The
worker walks the engine user's reading list forward from the stored checkpoint, oldest first, in pages of
200 entries (at most 500), and posts each page as one or more batches of up to about 700 kB; only the
last batch of a page advances the checkpoint. A pass starts an hour before the newest entry it saw, so
entries the engine committed late are read again and absorbed.

What holds however the walk is interrupted:

- **A batch and its checkpoint commit together.** The items, mappings, states, checkpoint and the
  batch's `applied_batches` row are one transaction. A crash re-reads at most the uncommitted page. Batch
  keys come from the page's coordinates and content, so a retried batch returns its first answer and
  changes nothing.
- **Absence never deletes.** FreshRSS purges by its own policy and cannot list what it removed, so a missing
  entry means nothing. Product items go only when the person deletes them, and each deletion leaves a
  tombstone (`item_tombstones`) so a later pass does not bring the entry back.
- **The engine's retention bounds what can be imported.** PURSS configures FreshRSS to keep each feed's newest
  50 entries and to drop the rest once they are older than 90 days or beyond 1,000, whether or not they
  are unread, starred or labelled (`DEFAULT_ARCHIVING`, `packages/freshrss/src/lifecycle.ts`). An entry
  that leaves before a walk imports it is gone, so an outage longer than that window, or more than 1,000
  new entries in one feed between two walks, leaves a gap that PURSS cannot detect and does not claim to
  fill. The service health page says when the sync has stalled.
- **Edits become versions.** An entry whose text changed upstream returns in the next pass; when its content
  hash differs, the item gets a new current version. A version a basket pins is never changed (see Keeping
  below).
- **A full quota or a low disk stops growth, not the person's data.** A batch that needs room it does not
  have rolls back whole, the checkpoint stays, and the pass is tried again by the tick; an edit to an
  existing item waits without failing the batch. See [storage and retention](storage-and-retention.md).
- **Read state goes one way.** Finished and Ignored are mirrored to FreshRSS as read, every other state as
  unread, through `engine.mark_read` jobs (up to 200 entries each) enqueued in the transaction that changes
  the state, so a failed call retries without undoing anything. FreshRSS's own read state never changes a
  product state, no basket is written to it as a star or a label, and no entry is starred.
- **A paused source collects nothing.** Entries of a paused source are skipped; items it already has still
  receive their edits.

## Query contract

Lists, filter collections, shared pages and assistants read items through one typed model
(`packages/domain/src/query.ts`, compiled in `apps/api/src/services/items.ts`).

- **A filter collection stores a query tree, never SQL or a pattern.** A leaf tests one field: text, source,
  collection, basket, kind, workflow state, author, New, opened, kept, capture level (saved details, feed
  text, full text, pending, failed) or a date (published, discovered or kept). `all`, `any` and `not`
  combine leaves. The server validates the tree when it is written and every time it is read: at most 4
  levels deep, 24 leaves and 12 children per node, each list of values bounded and de-duplicated. It
  compiles to parameterised SQL scoped to the workspace.
- **Sorts come from a fixed list:** newest, oldest, source, title and kept time. Ties break on the item ID, so
  an order is deterministic.
- **A page is addressed by an opaque cursor,** the last row's sort key and ID (for Home's lists also the run
  and the snapshot of the newest item when paging began). The next page starts after that row, so items that
  arrive or change while someone pages are never repeated or skipped. A malformed cursor is refused as
  expired.
- **Search uses SQLite FTS5** over titles, excerpts, authors, feed text and complete readable copies, plus the
  person's own highlights and notes; never text that was not stored. It runs on the server across the whole
  dataset, not over the cards a page has loaded.

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

**Bridged sources.** A page of a catalogued service
(`packages/connectors/src/bridges.ts`) is discovered as the descriptor `bridge:<service>/<key>`,
previewed by the API through the bridge router, and stored as the source's feed address; exports
write the service's page instead. Only the worker turns the descriptor into an engine address,
`http://feed-bridge.internal:8945/b/<service>/<key>/<HMAC>` under `secrets/bridge-key`, so the
router answers nothing a feed could redirect FreshRSS to. The router asks RSS-Bridge (one fetch
per source at a time, four at once, ten-minute cache, back-off after failures), gives every entry
the post's own id (`telegram:durov/552`) so a backend change keeps items, never serves a failure
as an empty feed, and records each answer in the fetch log the Service health page reads. The
services and how their pages are read are in [sources](sources.md).

**Big feeds.** FreshRSS parses a feed whole in PHP's 128 MB limit and the
largest podcast feeds are tens of megabytes, so a feed larger than 4 MiB (what discovery reads before it knows
its size) or with more than 1,000 items is followed through the egress feed gateway: `GET /t/<HMAC>/<address>` on the gateway listener, where
egress's `TrimService` streams the feed through `safeFetch` (a `sink` reads the body without buffering it),
`FeedTrimmer` reads the feed to its end (or to its 64 MiB ceiling, past which the newest items of what was read are the answer) and keeps the channel's metadata and the newest 50 items byte for byte, and FreshRSS gets that copy
(its root element carrying an `xml:base` of the publisher's address, so relative links keep resolving there). The trimmed answer is kept in memory per upstream address and
shared by every account that follows the feed, and a stale one is renewed with a conditional request (`304`) rather than a second full read.
The source row keeps the feed's own address and a flag (`sources.via_gateway`); only the worker turns the job's
`trim` instruction into the signed gateway address, under `secrets/feed-trim-key`. A subscription the engine itself fails on
(an HTTP 500 or a dropped connection, with no reason about the feed's site) is checked by the worker and moved to the gateway when the feed really is that big
(an import or a retry has no preview that says so). Size is never worded to a person: the gateway serves what it could read, and what the engine can't follow fails with the generic message.

**State.** Workflow, the New marker (`fresh`), reading progress, collection membership and basket membership
are separate fields and tables. State changes carry `expectedRevision` (409 on conflict) and
return an undo token (15 minutes). The player's own changes to In progress and Finished carry a playback session and the workflow
revision instead (see Media below), so only a change to the workflow can refuse them. Opening an item or changing its workflow, progress or basket membership
clears its New marker in the same change, and Undo restores it. Workflow changes are mirrored to FreshRSS as read state (see Sync). Every workflow change (single, bulk, undo) also appends a row
to `state_log` in the same transaction; the private statistics (`/api/stats/...`) read it and
the item tables, and its rows go with their item and travel in the export.
The counts behind the source and collection lists and the lists' totals (`services/counts.ts`) take most of an account's items as one cell (Undecided, not New)
from `items` and read every other cell (the items acted on, the New ones, the Ignored ones) from `item_state_rare`, a partial index of the state rows that
are not that cell; each state row repeats its item's source (`item_state.source_id`, stated by the two writers of the row) so the index alone answers, however
many items are Ignored (most of an account that followed its sources from now).

**Coming back.** New markers are only the `fresh` field of an item's state. An entry a source already had when it
was followed (published, or undated, before the follow time, until a sync walk that began after the engine confirmed the
subscription has finished) is stored without one and tells no one. What the person chose when following (`sources.start_from`) decides what else
happens to it: followed from now (the default, and what an OPML import does), it is stored with workflow Ignored (`arrivalOf` in `services/sync.ts`), so lists hide it
(their default filter leaves Ignored out; "Show ignored" has it), Home, collection totals and every count of items not looked at leave it out, a search
(`q`, which lists every state) finds it, and nothing marks it but the state itself: no log entry, no `engine.mark_read` job, and the person can move it to any
state like any other item; followed with the last week, entries published in the 7 days before the follow are New like any
arrival; a source whose choice is `all` shows its back catalogue as ordinary older items. Automatic full-text copies and Smart-filter
judging are for New arrivals only, so they skip it. Opening an item, finishing it or ignoring it clears the marker in the same change; a pass in the
tick (`services/returning.ts`, throttled: every five minutes and every hour) expires markers older than the person's
choice, resumes sources whose pause ran out, makes the digest that has come due, tells about sources that stopped
working and failed text saves, and prunes notifications. `POST /api/activity/visit`, sent by the web app from any page on foreground interaction, records the start of a visit (after 30
minutes of quiet) and `GET /api/home` returns, read-only, what Home says before its boxes (filter collections
leave out what Home leaves out, `services/home-sources.ts`; the put-aside rows are `toRead` for articles, `toWatch` for videos and `toListen` for podcasts, each the queue of its kind: In progress items first, then To read, oldest first). `GET /api/items?scope=toread` is that queue as a page: every To read and In progress item of the workspace, In progress first (two runs, as Home's lists have, each in the list's own order), found by state in the workspace's `item_state` index. `GET /api/items?mix=home` is a list as Home shows it (its boxes
and its one feed, with `filter=new`: Undecided items only; the *Only new* layout's with `filter=fresh`): only sources with a box on Home, Undecided items first and then the rest the filter allows, newest first within each, listed as two
runs in date order and paged from a snapshot of the newest item when paging began. Lists also take `type`, `length`, `source`, `without` (one source left out) and
`capture=failed`; with `mix=home` these narrow what Home would show (hidden collections stay out). Unless `muted=show`, lists leave out the items the PURSS's muted words match (title or summary, whole words, kept in the preferences; matched on the row
a query looks at by the SQL function `purss_muted`, so the cost follows the rows looked at, never other workspaces or how many items a word matches; words are
compared as the text index compares them, so accents are dropped from Latin letters only, and a section or page asks about the rows it takes once they are in
order); the first page says how many (`mutedHidden`, counted among the first 1,000 candidates; `mutedHiddenAtLeast` says when a longer list was counted in part,
and Home's To read `total` is then an upper bound, `totalAtMost`). `mix=home` refuses `q` and any order but newest.
The web app asks again for what it shows when the page or the app comes back to the front, so changes made on another device show up.
The search index records which version it is being rebuilt for and how far it got, for items and for the person's notes, so an interrupted rebuild is
never mistaken for a finished one of another version. `GET /api/activity` summarises the job queue, the sync checkpoint and recent
arrivals for the sidebar's activity line. `services/notifications.ts` is the one place that decides who is told what
and when; `digestFor` counts a digest for a window; `runDigest` puts it in the bell and, when allowed, emails it.

**Keeping.** An item's content lives in immutable `item_versions`. Keeping inserts a basket
membership that pins the current version, in one transaction with its storage record: if the record
cannot be stored, nothing is kept and the person is told. An edited feed entry becomes a new version and
the pinned one stays. A superseded version that no basket pins is released. In a *Readable copy too*
basket (capture mode `text`), keeping also reserves storage and enqueues a `capture.fulltext` job; the worker fetches the page
and extracts readable text, and the API settles the reservation to the real size or releases it on
failure. When the reservation does not fit, the keep still stands and says that no readable copy was made. A source with full articles
on (`sources.full_text`) gets the same capture for every new item, queued in the sync batch's
transaction and spaced a few seconds apart per PURSS. These optional copies reserve nothing,
so they never hold room the items themselves need: each is admitted when it completes if it fits,
and is otherwise dropped without marking growth paused.

**Is it the page?** A finished capture is checked before it is called the full text (`assessCapture` in
`@purss/connectors`, run by `completeCapture` with the length of the feed's own text for the item): a sign-in,
subscription, consent or security-check page (`gated`), a body that is mostly a reference list (`references`)
or one under 60% of the feed's own text (`short`) is stored as `quality = 'partial'` with its reason. It stays
stored and counted, but is not "Full text saved": the item's detail returns the feed's own text as
`contentHtml` and the capture as `partialCopy` for a toggle, and the capture sets no reading time and is not
searched. Readable copies stored without a verdict are checked in the background at start-up; browser captures are the
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
an unfollow that deletes the source's unkept items. The reader's text points at `GET /api/items/:id/images/:imageId` for stored pictures
and keeps the original address for the rest. Exports carry them in an optional `images` section.

**Media.** The server stores no audio or video files, and has no download job for them. Every item
carries `media: ItemMedia | null` (`packages/domain/src/api.ts`):

```ts
type ItemMedia = { url: string; kind: "audio" | "video"; type: string | null; length: number | null };
```

`url` is the address of the item's first audio or video enclosure, chosen by its declared type, or by file
extension when the type is missing or generic; `type` and `length` are as the feed declares them and may be
missing or wrong. Streaming playlists, web pages and platform video pages are never media, and an item of a
private source carries none, because enclosure addresses can hold the subscriber's secret. `linkIsMedia`
marks an item whose own link is its file (the same address as an enclosure, or ending in a media file name),
so the reader does not offer the file as the item's page; a private source's items are judged the same
way. The web player streams the file from the publisher over `https` (the page's policy allows media only
from `https:`), the phone apps can also download it to the device, and a YouTube, Vimeo, Dailymotion, Odysee
or Twitch page plays in the platform's own embedded player, loaded when the person presses play.

| Method and path | Does |
| --- | --- |
| `PUT /api/items/:id/playback` | Saves `{ positionSeconds, durationSeconds?, recordedAt? }` and answers with the stored position; `ItemDetail.playback` returns it |

A position is its own row (`playback_positions`), separate from reading progress, workflow, revisions and
baskets, and one small record in the ledger admitted with the control headroom. The position recorded last
wins: a late write from a device that played offline carries `recordedAt`, capped at the server's clock, and
does not replace a position recorded after it. Positions are not in the export.

The player's own changes of state follow the rules of `PATCH /api/items/:id/state`: after 30 seconds of real
playing an item that is New or To read becomes In progress, and after playing at least 3 seconds at or past
the finish point (95% of the length or its last two minutes, whichever comes first, never before halfway)
an item that is New, To read or In progress becomes Finished; an unknown length gives In progress only. Such a
change carries `playbackSessionId`, `expectedWorkflowRevision` and `playbackStartedWorkflowRevision`, only
with In progress or Finished, and the server accepts it only if the workflow has not been changed by
hand since playback started (any device, a bulk change, an Undo or a Smart filter all count, even when
the state was set back to what playback had made) and only forward. Otherwise it answers 409 and the
session ends.

**Highlights and notes.** The person's annotations live in `annotations`, apart from workflow,
collections, baskets and retention. The web app chooses each annotation's id, so it can be
made offline, and sends the whole annotation with the time it was changed: `PUT` and `DELETE`
`/api/items/:id/annotations/:annotationId` are idempotent and the last write wins. A removal clears the
text and leaves a tombstone, kept as long as the item, so an old offline change can't bring a removed
one back however late it arrives; an annotation the server has no row for is new, so it is accepted
whatever the device's clock says. A highlight stores its passage
with some text before and after it and its position in the reader's text, and names the capture or
version it was made on; the reader finds it again by its words and lists one it can't find as
detached. Annotations pin nothing; each live one is a small "Other" record in the ledger, admitted with
the control headroom. Search covers them through `annotations_fts`. Rule-based deletion (unfollowing with
*Also delete the items you haven't kept*) skips annotated items, which stay visible after their source is
unfollowed; an explicit permanent delete names them and removes their annotations with the item.
They are exported and imported, never shared, and the MCP `get_item` tool returns them labelled as
the person's own text. Limits: a comment or note up to 10,000 characters, a passage 5,000, 64 characters
of context on each side, 500 live annotations per item and 96 kB per request; a write over a limit is refused
and the web app's outbox keeps it as failed with the reason.

**Source icons.** Every tick queues a `source.icon` job for followed sources that were never
checked or were last checked more than a week ago, with the feed link redacted for private
sources. The worker finds and re-encodes the icon (see the connectors README) and posts back
a WebP. The API checks it is one and stores it in `source_icons`, one per source. A check
that finds nothing keeps the stored icon. The web app loads it from
`/api/sources/:id/icon?v=<digest>`, which only the owning PURSS can read; the response is
cached privately and sent with a sandboxing CSP. Icons are re-derivable, so they are not
exported or counted against storage quota.

**Storage ledger.** Usage is the sum of measured, live stored objects (item versions, readable copies,
kept pictures, small records). Admission happens inside the
writing transaction against the allocation plus reservations; small state writes get a bounded
headroom. A full quota or low disk pauses growth (a sync batch that needs the room is tried again by the next
pass) and never evicts kept content. Deleting an item releases its objects and is never blocked by quota.
[Storage and retention](storage-and-retention.md) has the rules.

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
turning the setting off deletes the copies. Pictures PURSS serves whose address changes with their
bytes (a source's icon, versioned by its digest, and a picture stored with a kept copy) are kept in a
second cache of the account's (`purss-pictures:`), served from there before the network, and deleted
with the copies; the pack saves every source's icon and the stored pictures of the kept items it saves,
and lets go of the rest. Publishers' own images in an article are not saved.

**Sharing.** A basket or a collection can be shared as a public page and an Atom feed (`shares`,
`share_notes`; `apps/api/src/services/shares.ts`). The page is a live projection of what the owner's own list
of it shows, built on each request: per item only the title, link, a short plain-text summary, the source
name and date and the owner's public note, never reading state, private notes, highlights or saved text,
and never items of private sources or links that carry a key. A filter collection whose rules read reading
state cannot be shared. The public listener serves `/p/<slug>`, `/p/<slug>/feed.atom` and a report form for
published pages only, rate-limited per address; the slug is the title followed by 12 random letters. On
hosted installations sharing is part of Plus, and an administrator can take a reported page down, which
pauses it until restored. Every page has one address: a
`GET` or `HEAD` of a page path with a trailing or doubled slash (`/p/<slug>/`, `/signin/`) is
redirected (301) to it; `/api` answers only at its exact paths.

**Export and import.** Export streams a JSON archive with a manifest of counts and hashes,
secret-free, and works over quota. Import stages and previews first (including whether it
fits the allocation), then applies. What the archive holds and leaves out is in
[storage and retention](storage-and-retention.md#export-and-import).

**Assistants (MCP).** `POST /mcp` on the public listener is handled before cookies are read
(`apps/api/src/mcp`). A personal access token resolves to its account's principal (never an
administrator, never a recent sign-in) only while the installation and the account both have
assistant access on. Tools call the same services as the web routes, so scoping, storage
admission and bulk changes behave the same; write calls are audited. The server answers
both the current protocol (per-request version, `server/discover`) and the older `initialize`
handshake, with JSON and no sessions. [Assistants](assistants.md) covers the tools and what an assistant can reach.

**Assistant OAuth.** Where the installation offers it (hosted mode, or `PURSS_ASSISTANT_OAUTH=on`),
`/mcp` is also an OAuth 2.1 protected resource (`apps/api/src/oauth`): its 401 points to the
protected resource metadata, the API serves authorization server metadata, `/oauth/token` and
`/oauth/revoke` (no cookies, no CORS), and `/oauth/authorize` is a consent page of the web app.
Clients identify themselves with a client metadata document fetched through `safeFetch` (5 kB, 5 s,
no redirects, cached). Codes come from the same core as connected apps; access tokens last an hour,
refresh tokens rotate and a reused one revokes the grant. An OAuth access token resolves to the
same caller a personal access token of that level would, under the same two switches.

**Connected apps.** The phone app, the desktop app (which connects as kind `mobile`) and the browser
extension are other programs, not pages of PURSS, so they cannot use the session cookie with its same-origin
and CSRF checks. They connect through `/connect` in the system browser: the signed-in person approves, the API
issues a one-time code bound to the app's PKCE challenge and fixed return address, and the app exchanges it
at `POST /api/connect/token` for a device token (`apps/api/src/connect`). Nothing is registered or configured:
the client kinds, return addresses and reach are fixed in code.

| Concern | Rule |
| --- | --- |
| Flow | Authorization code with PKCE (S256 only), no client secret, `iss` on the redirect. An app that cannot receive a redirect (Safari's extension API) leaves the return address out and the page shows a typed code (`xxxx-xxxx-xxxx`) that the person enters in the app |
| Return addresses | Mobile: exactly `purss://connect`. Extension: `https://<32-letter id>.chromiumapp.org/…` or `https://<SHA-1 hex of the add-on id>.extensions.allizom.org/…`, in normal form with no query, fragment, port or credentials. The approval page never redirects anywhere else |
| Codes | Five minutes, single use, SHA-256 stored, bound to the challenge, kind and return address; a failed exchange burns the code. Exchanges are limited to 30 per 10 minutes per address, approvals to 30 per 10 minutes per account |
| Approval | Same-origin POST with the CSRF header, a recent sign-in (a step-up when the last is older than 10 minutes), on a page that cannot be framed |
| Token | `purss_dev_` and 32 random bytes, SHA-256 stored, shown once, up to 20 per account; it ends after 90 days without use, and the person or the app (`DELETE /api/connect/device`) can revoke it. It is looked up on every request, so revocation applies to the next one and closes that app's event stream |
| Reach | The phone and desktop token is a full sign-in, an administrator's included, with its own `auth_at` clock for recent-sign-in checks (*confirm it's you* refreshes it); it cannot approve another app's connection (`/api/connect/request`, `/approve`) or an assistant's sign-in (`/api/assistant/oauth/*`). The extension reaches an exact list (session, baskets, collections, URL lookup, keep a link, browser capture, search, finding and following a source, disconnecting itself), is never an administrator and never counts as a recent sign-in |
| Before a token exists | `GET /api/connect/info` names the connect page, the token address, the return addresses and the feature flags (`urlLookup`, `browserCapture`); sign-in and sign-up for the apps are open endpoints that read no cookie |

On `/api`, a request with `Authorization: Bearer purss_dev_…` is decided before cookies are read: cookies are
ignored and the Origin/CSRF check does not apply, since a browser never attaches a bearer token by itself.
CORS answers only the apps' origins (Capacitor and Tauri pages, extension pages), only for requests that carry
a token or use the open endpoints, and never with credentials. Requests without a bearer token take the cookie
path unchanged. [Security](security.md) has the threats these rules answer.

**Phone apps.** `apps/mobile` bundles the web app's build in Capacitor. The connected server also
offers the build of the interface it runs (`GET /api/app/bundle`, packed by the server image), which
the app installs when it fits the app's native code. What differs from a browser is behind `apps/web/src/platform/`: requests go to the connected
origin with the device token (token in the Keychain or Android Keystore), live updates are read with
fetch, the offline worker that the web's service worker runs is called in the page with copies in
IndexedDB, audio plays in the system's player (a foreground media service on Android), and
*Downloaded* keeps device copies of items and their media on the device only (for an
item PURSS has only a summary of, the app reads the article from the publisher's `https` page
itself and keeps it on the device only; PURSS's own capture pipeline isn't involved). The app's own
behaviour is in [apps/mobile](../apps/mobile/README.md).

**Notifications on the phone.** A phone app that turns them on registers its push address with the
project's push relay (`apps/push-relay`, deployed on its own), gives PURSS only the relay's handle
(`push_devices`, per device token) and gets a narrow fetch credential for its native code. When a
notification is made or grows, the API (`services/push.ts`), outside quiet hours and unless notifications
are off, asks the relay through `safeFetch` to wake the phone; the push carries no text, and the phone
fetches the texts with `POST /api/push/pending`. The relay is described in [apps/push-relay](../apps/push-relay/README.md).

**Keeping a link.** `items.url_key` is a comparison key of the item's address (`services/url-key.ts`),
indexed per workspace as `(workspace_id, url_key)`, so a page PURSS already has is kept once. The key:

- exists only for http and https addresses and leaves out the scheme, so `http://x/a` and `https://x/a`
  match;
- lower-cases the host (international names as punycode), drops a trailing dot, keeps `www.` and a port that
  is not the scheme's default, and keeps a user name and password if there are any;
- drops the fragment except routes that look like `#/…` or `#!…`, and one trailing slash from a path other
  than `/`;
- removes `utm_*` and the click ids `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `yclid`,
  `twclid`, `igshid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi` and `mkt_tok`; other parameters keep their order and
  spelling, and path case is left as it is.

`POST /api/items/manual` keeps the item PURSS already has for that key (one a basket already holds first, then
one shown in lists, then the oldest) in the chosen basket and answers `existing` and `alreadyInBasket`; only a
page PURSS has no item for becomes a saved link, which asks the page what it calls itself (Open Graph or
oEmbed, through `safeFetch`) for a title, picture and site, and keeps the address when the page says nothing.
`GET /api/items/lookup?url=` answers the best match (id, title, address, workflow state, baskets, when its text
was captured in a browser) and the followed sources whose site address contains the page (same host ignoring
`www.`, within the site's path, so a YouTube channel does not claim every video). Following a site never
means that every page of it was collected. A looser `items.link_key` (scheme, `www.`, tracking parameters,
parameter order and trailing slashes ignored) is used only by sync, to recognise a feed reissuing a post.

**Browser extension and deep links.** `/?dialog=add&url=…`, `/?dialog=keep&url=…&title=…` and
`/?dialog=search&q=…` open Add source (filled in, nothing looked up until Find), a Keep dialog with a
basket choice, or search; a signed-out visit returns to them after sign-in. The bookmarklets in
Settings only open these. The extension (`apps/extension`, Manifest V3, one build for Chromium,
Firefox and Safari) reads the open page only when the person opens its popup or right-click menu
(`activeTab`): feed hints from `<link rel="alternate">` and YouTube addresses go to Add source by deep
link, never fetched by the extension. On request it extracts the page's readable text with
Readability and posts it to `POST /api/items/browser-capture`, which keeps the page like Keep link and
stores the sanitized HTML as a capture of kind `browser` (one per item, replaced in place, admitted
against storage, never fetched by the server). The reader labels it "Saved from your browser". Every HTML sanitizer and parser input (feeds, captures,
browser captures, imports, OPML) is first read once by `assertShallowMarkup` in
`packages/connectors/src/text.ts`, which counts nesting and parser events exactly as htmlparser2
reads them, in linear time; stored content beyond the bounds keeps only its text, as paragraphs.

**Originals in the reader.** A page from another site opens inside the reader only when the page lets itself
be framed. `GET /api/frame-check?url=` reads the page's headers on the server (`checkFraming` in
`packages/connectors/src/frame-policy.ts`, through `safeFetch`: the first 16 kB, 8 s) and judges them against
`PURSS_PUBLIC_ORIGIN` as a browser would: `Content-Security-Policy: frame-ancestors` by CSP Level 3 source
matching, otherwise `X-Frame-Options` `DENY` and `SAMEORIGIN` (unknown values such as `ALLOW-FROM` allow).
Only a 2xx answer counts, a download (`Content-Disposition: attachment`) is never framed, and an https PURSS
never frames a plain-http page. The answer is `{ frame: true, url }`, where the page's redirects ended, or
`{ frame: false }`. Answers are remembered for 6 hours, separately for each PURSS and address (fragment
dropped, at most 5,000 in all), and a failed check is remembered as "no frame", so one account cannot learn
from timing which pages another opened. Only a check the server has to make counts against the limit of 300 per
account per 10 minutes. The web app asks when an item opens, for its original, and when the pointer rests on
or focus reaches a link in the article; a press that comes before an answer opens a new tab, which no popup
blocker interferes with. The frame is sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups
allow-popups-to-escape-sandbox`, never `allow-top-navigation`) and sends PURSS's origin as referrer; the
server's and the bundled page's policy allow frames from `https:` and `http:`, the apps' connected policy
narrows frames back to the video players, and the desktop app shows originals in its own web view
([apps/desktop](../apps/desktop/README.md)).

**Discovery (hosted only).** A co-follow graph of what accounts that share follow together
(`services/discover.ts`) is rebuilt in the API process every 6 hours, or within a minute of someone changing
the sharing preference, and a self-hosted installation builds and keeps none. Only usable accounts that share
count, and only their public feed, YouTube and podcast sources, matched across accounts by `urlKey`. A source
enters the graph only when at least 10 accounts follow it, and a pair only when 10 follow both; the two
aggregate tables (`discovery_sources`, `discovery_pairs`) hold counts and no account. A candidate scores the
sum over the reader's sources of `together(a, b) / sqrt(followers(a) * followers(b))`, so popular sources do
not crowd out closer matches. Each score gets Gumbel noise seeded by the workspace and the UTC date, so the
order holds within a day and changes between days; every fourth place is a wildcard drawn from popular
sources, a reader whose sources match nothing gets popular sources with noise, and at most 20 suggestions
show, each naming the reader's own sources that led to it. The rebuild is quadratic in each account's followed
sources.

**Outgoing email.** Optional (`PURSS_SMTP_*`, `PURSS_MAIL_FROM`; `apps/api/src/mail`). The API sends
through nodemailer: invitation links, sign-up links, address confirmation, password-reset links and
change notices. Every account signs in with its email address, one account per address
(`accounts_email`, without regard to case); where email is set up (`accountEmailAvailable`) addresses
are proven by links: open sign-up makes the account only from its link (`signup_requests`), and a new
address takes over only once confirmed. Messages that must not reveal whether an account
exists are sent after the response, through a queue in the database (`mail_queue`, sealed with a key
from the secrets folder) that survives restarts and retries while the server is down. Links are single-use tokens stored as SHA-256 in `email_tokens` and `signup_requests` (the operator's `password-reset-link` command makes the same kind of reset token at the server and sends nothing); `mail_log` keeps kind,
masked recipient, outcome and error code, never a body. The server is checked at start and every 10
minutes while failing; hosted open sign-up is open only while that check passes. Setting it up is in
[self-hosting](self-hosting.md#outgoing-email).

## Where data lives

| Data | Location |
| --- | --- |
| Product data, search index | `product.db` (SQLite) |
| Assistant tokens | `product.db`, `assistant_tokens` (SHA-256 of each token only) |
| Assistants connected with OAuth | `product.db`, `oauth_grants` (what was approved, the SHA-256 of its current refresh token and that token's generation), `oauth_access_tokens` (SHA-256 only), `oauth_refreshes` (the last hour's refreshes, for the limits); pending codes in `connect_codes` |
| Connected apps | `product.db`, `device_tokens` (SHA-256 only) and `connect_codes` (pending one-time codes, SHA-256 only, minutes long) |
| Phones' notification registrations | `product.db`, `push_devices` (relay handle, SHA-256 of the fetch credential, what was handed; goes with its device token); the push relay keeps its own `relay.db` |
| Account email | `product.db`: `accounts.email` (the sign-in address), `email_tokens` and `signup_requests` (SHA-256 of each link), `mail_queue` (messages waiting to be sent, sealed with `secrets/mail-queue-key`, at most a day), `mail_log` (no bodies, 90 days) |
| Account deletions | `product.db`, `account_deletions` (one row per account being deleted, gone with the account) |
| Installation news | `product.db`: `news_posts` (posts; the author link is cleared when that account is deleted), `news_deliveries` (which workspace got which post, for its copy and the counts) |
| Sites people couldn't follow | `product.db`, `discovery_misses`: per UTC day, the site (registrable domain) and the failure reason, with a count; 180 days. No account, workspace or address is stored, so it is no part of any account's data or export |
| Secrets | `secrets/`: service token, setup code, engine operator and engine-user passwords, private source URLs, `oauth-refresh-key` (signs OAuth refresh tokens) |
| FreshRSS data | `engine/` locally, the `engine-data` volume under Compose |
| Offline copies | The browser's own Cache Storage on each device (`purss-api:<account>`), plus a small record in its local storage; never on the server, deleted at sign-out |
| Browser extension | The browser's extension storage on each device: the PURSS address, its device token, basket names for the menu, settings; never synced |
| Unsent annotation changes | The browser's IndexedDB on each device (`purss-annotations`), until sent; deleted at sign-out |

Backups cover `product.db` and optionally `secrets/`; see
[self-hosting](self-hosting.md#backups-and-restore).
