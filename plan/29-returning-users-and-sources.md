# Returning users, calmer Home, and more followable sources

The owner asked for this after a 20-persona usage simulation and an inactivity investigation
(simulated build 8c222d3; findings re-checked against `origin/main` 2c9f67b). This document
records the build decisions. Finding IDs (F01…F110) refer to the consolidated list the
simulation produced; reports are kept outside the repository.

Not built here, because other work owns it: highlights and notes (plan/26, annotations
worktree), Mastodon and Bluesky sources (plan/28), saved media and the player (plan/25),
connected apps (adjacent/auth), account deletion (feature/account-deletion).

## 1. Performance and sync correctness

| Concern | Decision | Reason |
| --- | --- | --- |
| Storage classification (F01) | `categories()` matches a version to its item through `o.item_id` (`i.id = o.item_id AND i.current_version_id = o.ref_id`); migration adds `items(current_version_id)` and any other index the bootstrap path lacks | The old `EXISTS` scanned every item of every tenant per stored object: quadratic, and one account stalled the whole API |
| Dataset size | Acceptance gains a size gate: one account with 100,000 items and 300 sources, and a host with 20 such accounts; `/api/bootstrap` under 300 ms and item pages under 150 ms on the reference host. A generator script builds the dataset; a test asserts the storage query plan uses an index | plan/13 named no size; the defect only shows above a few thousand items |
| Batch size (F02) | Sizes counted in UTF-8 bytes (`Buffer.byteLength`), with the batch envelope included; the internal batch route sets its own body limit with headroom over the batch cap | Arabic/CJK text is 2–3 bytes per character; batches overflowed the 1 MB limit |
| Oversized entry | An entry that alone exceeds the cap keeps its summary, title, link and dates; its full content is dropped and the item says so ("The feed's full text was too large to store; open the original") | One feed must never block an account's whole sync |
| Failing sync visible | A sync that fails finally sets `last_error` in words a person understands; Home's engine notice names it; the activity view shows it | The account went silent for an hour with no sign |
| Engine refused a feed (F06, F07) | `429`/`503` from the origin at subscribe or refresh are retried with backoff (1, 5, 30 min, then the engine's normal cadence) and the source shows "The site is limiting requests; we'll keep trying"; a feed the engine can't parse because of size says so | Reddit throttled the shared address; the user saw a permanent "couldn't follow" |

## 2. Freshness, Home and notifications

New markers stay a separate field from workflow and reading progress.

| Concern | Decision |
| --- | --- |
| Back catalogue (F22) | Items a source already had when it was followed are not New and create no notification. Rule: on a source's first successful sync, entries published (or, without a date, crawled) before the follow time are inserted with `fresh = 0`; later entries are New as before. Counted per source, so following an old podcast never shows "1,359 new" |
| Opening and finishing (F20) | Opening an item, or setting it Finished or Ignored, clears its New marker (undoable with the action) |
| Expiry (F21) | Preference `freshDays` (1–365, or 0 = never), default 30. A maintenance pass clears markers on items that arrived longer ago than that. Only freshness changes |
| Clear all (F21) | "Clear all new" on Home uses the existing `home`/`all` scope, loops server-side past the 5,000 page cap in one transaction per page, and reports the total |
| Last visit | PURSS records `last_visit_at` (start of the previous visit, updated when a visit starts after 30 minutes without activity) |
| Home is the welcome back (F24, F25) | Every layout starts with a summary band when there is something to say: "Since your last visit (3 days ago): 412 new in 6 collections", then rows: **Continue** (In progress, then recently opened unfinished items), **To read** (all To read, oldest first, up to 6 with "Show all"), **Recently kept**, **Needs attention** (sources failing, paused, rate-limited), and **Start fresh** (clear all new, with Undo). Collapsible; nothing appears when empty |
| Built-in To read place (F25) | A sidebar entry "To read" (all items with that workflow, across collections), like a saved view; Continue also lists To read when nothing is In progress |
| Home's lists (F26) | Lists with `mix=home` (`GET /api/items`: Home's boxes and its one feed) show only sources with a box on Home and, with `filter=open`, New and To read items: New first, then To read, newest first within each (owner decision: the earlier turns per source and the per-source share of Home, *More* / *Normal* / *Fewer* / *Only in its own page*, were removed as confusing). The two runs are each read in date order; the cursor names the run, the position and a snapshot of the newest item when paging began, so items arriving meanwhile wait for a refresh |
| Pause for a while (F34) | Pause offers *for a week*, *for a month*, *until I resume*; `paused_until` resumes automatically |
| No collection by default (F27, F28) | Add source preselects **No collection**; following never requires naming one. Home shows sources not in a collection in an "Other sources" box, which Customise lists like a collection (shown by default) |
| Background activity (F109) | A small activity indicator in the sidebar footer: "Checking 3 sources…", "Saving text for 2 items…", or "Up to date · checked 4 min ago". Its panel lists recent engine work (subscribed, refreshed, new items per source), each source's last check and next expected check, and problems. Data from a new `/api/activity` endpoint and the existing event stream |
| Notification choice (F23) | Preference `notifications.frequency`: *off*, *daily digest* at a chosen time, *weekly digest* on a chosen day and time. `notifications.include`: new items (all or chosen collections), sources that stop working, reminders, saved-text failures. Digests are one notification: "Your daily digest: 54 new in 4 collections" with per-collection counts and top titles when previews are on. Hidden or collapsed Home collections are excluded unless chosen. Notifications older than 90 days, or beyond the newest 500, are deleted; notifications of unfollowed sources are deleted with the unfollow |
| First sign-in question | After sign-up (and once for existing accounts that never saw it) a short setup step asks how often to be told about new things (default *weekly digest* on Monday at 08:00 local) and how long New markers last (default 30 days). Both stay in Settings |
| Counts off (F29) | "Show counts" off hides every new count, including collection headers and the summary band numbers ("New items since your last visit") |
| Quiet settings together (F30) | Settings gets one "Notifications and New" section holding frequency, contents, quiet hours, New marker expiry and counts |

### Details settled while building §2

| Concern | What was built |
| --- | --- |
| First sync (F22) | A source is *settled* once a sync walk that **began after the engine confirmed the subscription** has finished, even when the feed was empty: the boundary is where the previous walk ended (`sync_checkpoints.last_walk_done_at`, stored with the checkpoint, so it holds across batches, retries and restarts), and a source confirmed during a walk is settled by the next one. Until then an entry published before the follow time is back catalogue, and so is every undated entry (it was already there the first time anyone looked). Migration 019 seeds both timestamps and settles sources that already have items. `notifyArrivals` is given only the New items |
| Same link again (F65) | Same source, same address (scheme, `www.`, trailing slash and tracking parameters ignored) **and** the same headline, within 30 days: the new engine entry is attached to the item it repeats. A feed that gives every post one address keeps them apart by headline |
| Visits | `POST /api/activity/visit` (origin and CSRF checked like every mutation) records that the person is here and moves the previous and current visit timestamps together in one transaction; the web app sends it from any page on a foreground press, key, scroll or return to the tab, at most every three minutes, and Home waits for its own page load's call before asking for the summary. `GET /api/home` only reads. `last_visit_at` is the start of the previous visit, so the summary stays the same all visit; "N new" counts items still marked New that arrived after it, from sources shown on Home (or in Other sources). Migration 019 starts existing workspaces from their last session activity; a first visit has no summary |
| Expiry (F21) | Measured from arrival (`discovered_at`), hourly, in batches of 1,000 per PURSS; the revision is not bumped (a tab showing the item is not told it conflicted). Items that arrived since the previous visit began keep their marker until the next visit, so someone away for 60 days still finds what came meanwhile |
| Seen items (F20) | Opening, Finished and Ignored clear the marker in the same change (single and bulk), with the marker restored by that change's Undo token; the response carries the updated item |
| Clear all (F21) | `POST /api/items/clear-fresh` clears 500 markers per transaction until none are left in the scope and returns one Undo for the whole |
| Pause (F34) | `pauseFor` week / month / until-resumed; a pass that runs every 5 minutes resumes the ones that ran out |
| Other sources | Preference `homeOther` (default on); Customise orders it with `"other"` in `homeCollectionIds`; its items use the scope `loose` |
| Reading list (F25) | The place `/r/toread` (scope `toread`) in the sidebar and rail; the Home rows send "Show all" there |
| Notifications (F23) | `notifications.frequency` is `off`, `daily` or `weekly` (plus `digestTime`, `digestDay`); `mode` now only says where (bell, or also browser alerts) and an older stored "off" becomes frequency `off`. An older stored or exported `arrivals` becomes `weekly`. A "Notify me" source's notifications within an hour are one row whose count grows. A digest counts items still New that arrived in its window (since the last digest or the change of frequency), per Home box; it comes at the first check after the scheduled moment in the person's time zone. "Collapsed" Home boxes are a per-browser layout hint the server cannot see, so only boxes hidden in Customise Home are left out (unless chosen). A digest is counted, its window moved and its notification recorded in one transaction; the window's end (`notification_state.window_end`) is the durable record of what was covered, so pruning notifications cannot make a digest be sent again, and a failure leaves the window where it was. Item titles appear in a digest only when titles are on and never for a private source, in every channel (`digestFor` applies this itself). Sources that stop working and failed text saves are looked for every 5 minutes and told about once per failure: the failure that was told about is kept on the source (what is wrong and since when it last worked; a source that recovered and fails again is told about after a day) and on the capture (the moment that attempt failed, so a new attempt that fails is new), not in the notification; failures more than two days old are not announced. Reminders respect `include.reminders`. `digestFor(app, workspaceId, window)` is the one place a digest is counted, for email later. No badge on the bell while the frequency is off |
| First question | Preference `welcomeAsked`; the dialog suggests a daily digest at 08:00 (or keeps "off" if that is what is set) and 30 days; *Not now* keeps what is set. It is shown by the sidebar, so it appears whichever page was opened |
| Activity (F109) | `GET /api/activity`: checking / setting up / saving text now, last and next check (next is an estimate from the last attempt and the sync interval), each source's note, arrivals in the last 24 h and recent events. The web app refreshes it on events but not within 30 seconds of its last answer |
| Export | The pause end is not in the export (a pause comes back as *until resumed*) |
| Counts off (F29) | Hides the sidebar counts, page-head counts, the collapsed-box count and the numbers in Home's summary and rows |
| Home box order (F32) | Columns are measured before the first paint and boxes keep the saved order; saves of preferences merge the server's answer only for the keys that were changed, so a second change made while a first is saving no longer flickers back |

## 3. Sign-up and sign-in

| Concern | Decision | Reason |
| --- | --- | --- |
| Sign-up limit (F10) | Every attempt is charged to a per-address attempt throttle (30 an hour) before any expensive work; capacity for a new account is checked next, and a successful sign-up is counted in the same transaction that creates the account (abandoned accounts still count) against 10 created accounts an hour per address; the installation's daily cap stays. A refusal names when a retry can succeed: the **latest** release time among all limits that block, sent as `Retry-After` (seconds, rounded up) and shown as a local time ("Try again after 14:05") | A first attempt was refused; shared addresses (campus, carrier, library) were locked out for an hour |
| Enrollment at sign-up (F11) | Every sign-up (the first-run claim, an invitation, open sign-up, the phone app's) takes an email address and password and creates the password together with the account in one transaction, so no account exists without a way in. There is no enrollment state, banner or time-limited permission. The passkey step follows (fingerprint, face or screen lock, shown where the browser supports it) and can be skipped; it can be added later in Settings → Security. The sign-up session counts as a recent sign-in for the usual ten minutes, so the step needs no further confirmation | Closing the tab skipped steps and nothing reminded; creating the password with the account leaves nothing unfinished |
| Adding a way in later (F12) | Adding or removing a sign-in method and changing the password need a recent sign-in; the screen asks to confirm it's you with the password or a passkey, then carries on. The password can be changed but never removed | An account-age exemption would let a stolen session add its own method |
| Failed fingerprint/face sign-in (F13) | Neutral wording, since the browser doesn't say why: "Sign-in failed. Try again, or use your password." | "Cancelled" was wrong, and claiming "no passkey on this device" would be a guess |
| Password wording (F14) | Passwords are described as a normal choice ("works on any computer, including borrowed ones") | They were framed as a home-server workaround |
| Shared computers (F15) | Sign-in has "This is a shared computer". The session's class is stored and enforced for every sign-in method: a browser-session cookie that is never upgraded to a persistent one, an absolute lifetime of 8 hours with no renewal, and its event stream closed at expiry. The signed-in devices list names browser, system and approximate last use, marks this device, and offers "Sign out everywhere else", which also closes those sessions' event streams; credential changes re-check that their session is still valid just before they commit. The sidebar shows the account's display name | Library and household use; a cookie flag alone was renewed to 30 days by the existing renewal path |
| Sign-in page (F17) | Names PURSS and says in one line what it is | People didn't know what they had opened |
| Words for passkeys | The interface never leads with "passkey". The choice reads **"Fingerprint, face or screen lock"** ("Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager"), with "(a passkey)" as the secondary term; sign-in buttons say "Sign in with fingerprint, face or screen lock" | Testers didn't know what a passkey is |
| Forgotten password | The sign-in page's "Can't sign in?" links to a reset by email where the installation sends email and an account has a confirmed address; otherwise it says to ask the server's administrator for a reset link, which the operator makes with `password-reset-link` (plan/21). Every sign-in screen leads with the email address and password form, then fingerprint, face or screen lock | A forgotten password needs a way back on every installation |

### Optional email

Follows plan/27 (outgoing email, account address, password reset by email; another worktree): email
exists only when `PURSS_SMTP_HOST` is set; hosted open sign-up then asks for an address and stays closed
while mail doesn't work; self-hosted accounts have no address at all; an address is never an identifier.
Through plan/27's mailer, digests also go by email to a confirmed address (§2 frequency; *Email me
the digest*, on by default, switchable in Settings). More important notices (sign-in method added,
sign-in from a new device, storage nearly full or full) by email are *not built*. Self-hosting needs nothing new.

## 4. Source compatibility

Discovery stays inside `safeFetch` and the address rules; nothing here weakens SSRF controls.

| Input | Behaviour |
| --- | --- |
| A YouTube video link (F48) | Default action **Keep this video** with its real title, channel and thumbnail (YouTube oEmbed); *Follow the channel* is the second choice |
| Any kept single link | Title, image and site name from the page (Open Graph/oEmbed) when the fetch succeeds; the title stays editable afterwards |
| reddit.com/r/x, /user/x (F46) | Follows `/.rss`, named "r/x" / "u/x" |
| github.com/owner/repo (F47) | Offers Releases and Tags feeds |
| Apple Podcasts link (F45) | Resolves the feed through the public iTunes lookup |
| Substack, Medium, Tumblr, Blogger, WordPress, Vimeo, Pinterest boards | Known feed paths for each |
| Site without advertised feed (F49) | Probes a short list of common paths (`/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml`, `/feed.xml`) within the existing request budget |
| Section pages (F50) | A section's own advertised feed is preferred; a site-wide guess is labelled as the whole site and never chosen silently |
| Platforms without feeds (F42) | Instagram, TikTok, Facebook, X, Threads, WhatsApp, Discord, Signal, Telegram, Snapchat, Twitch, Bandcamp, Spotify: "Instagram doesn't publish feeds, so it can't be followed here. If this creator also posts on YouTube, a blog or a newsletter, follow that instead." with *Keep this link* offered |
| An email address (F43), a name (F44) | Say what it is and what to paste instead |
| Timeouts and failures (F40, F41, F54) | A timeout is never reported as "nothing to follow"; the message doesn't blame the site; a host that doesn't exist says so |
| Feed choice and names (F51, F52) | Comment feeds are not offered when a posts feed exists; Discourse prefers latest topics; generic feed titles ("Feed", "» Feed", "Nieuws") get the site's name |
| Rates (F53) | Posting rate estimated from dated entries over their real span |

## 5. Content, search and interface fixes

Bidirectional text (`dir="auto"` and isolation on titles, snippets and names, F60); double-encoded
CDATA in summaries (F61); style text removed from captures (F62); DOI tracking queries stripped
(F63); duplicate items of one source with the same link merged at insert (F65); a play control that
plays or opens the video (F66); labels by kind (To watch / To listen; progress only for text, F67);
plain links in descriptions made clickable (F68); card images from the item or its content (F69);
the basket form says pictures aren't saved (F70); calendar-day relative dates and dates in the
browser's language (F71); exact times in provenance (F72); a summary-only label in the item panel
(F73); kept-state shown only after the server confirms, with a pending mark meanwhile (F74, F80);
caches refreshed after rename, Customise, basket creation, passkey changes and clean-up (F31, F81,
F95); search shows "Searching…" until results arrive and announces the count (F82, F90); search
folds Arabic diacritics and letter variants and matches word prefixes (F83); snippets and dates in
results (F84); filter headings in plain words and "all of these words" (F85); a board card dropped
on an excluded lane says why (F86); keyboard-reachable Undo and focus management (F87–F89); sounds
off by default (F91); header, toast and phone layout fixes (F92–F94, F97); an offline state instead
of endless skeletons (F96); a text-size setting (F105); retry for a failed text capture (F107).

**Writes that don't get lost (F03).** State, keep and New changes go through a persistent outbox
(IndexedDB), partitioned by installation and account: the change shows at once with a small pending
mark, is sent in order, survives a closed tab or lost signal, and is resent on the next load. Keep and
unkeep are idempotent. A workflow change is resent with the revision it was made against; on a
conflict the client reads the item: if its workflow already equals the target (the earlier send
committed but its answer was lost) the change counts as done, otherwise it is dropped and the person
is told. The queue pauses when the signed-in account changes; signing out with unsent changes asks
whether to send them first or discard them. Leaving the page with unsent changes asks first.

**Revision and state version.** `item_state.revision` guards workflow and reading-progress edits
only; changing just the New marker or recording an opening doesn't move it, so clearing New can
never invalidate a queued change. Every change to an item's personal state, and every keep or
unkeep, moves `item_state.state_version` (+1 in the same statement), which caches and the offline
copy use to pick the newer copy of an item; timestamps can't order changes made within one
millisecond. An Undo that couldn't read the item (offline, another tab already sent the change)
waits as its own outbox entry for the account that pressed it, reads the item when it can, and
restores only if the item still has the change it undoes; changes queued after it are sent on the
revision it produced.

## 6. Answers recorded for the owner

- **Shared fetching.** FreshRSS 1.30.4 reuses one HTTP cache across its users: entries are keyed by URL
  plus request options (`SimplePieCustom.php`), refreshes reuse a newer copy
  another user fetched, the per-feed lock is global, conditional GET is used, and a 429/503 Retry-After
  applies host-wide. N accounts cost N engine and product copies (baskets need the product copies),
  not N fetches. A shared engine user or a gateway cache would save almost no requests and add a
  cross-tenant path, so neither is built. Two small changes close the remaining duplicates: the worker
  serializes first follows of the same public URL (private `secret:` sources excluded), so later
  followers hit the engine's cache; and the engine's minimum cache window becomes the refresh cadence
  (800 s), which bounds per-user refetches of `no-store` feeds within a run (a very long run can still
  refetch); private feeds' URLs carry their own credentials, so their cache entries stay theirs. Per-address limits such as
  Reddit's are a separate matter (pacing, or a future authenticated adapter).
- **Recovery for hosted accounts.** The owner chose optional email (§3) for digests, important
  notices and recovery, provided self-hosted installations need nothing new.

## 7. Workstreams and file ownership

Migrations: 018 (WS1 indexes), 019 (WS2), 020 (WS4 search). 017 is account deletion; 025-032 are plan/24-28 and 31-33 (connected apps, saved media, annotations, outgoing email, assistant OAuth, browser captures, the mail queue).
Shared files (`packages/domain/src/api.ts`, `apps/api/src/routes/index.ts`, `apps/web/src/dialogs/Settings.tsx`,
`docs/user-guide.md`): small, additive edits only, re-read before each edit.

| WS | Scope | Owns |
| --- | --- | --- |
| 1 | §1 performance and sync; F06, F07 | `apps/api/src/services/{storage,jobs}.ts`, `apps/api/src/routes/internal.ts`, `packages/freshrss/src/**`, `apps/worker/src/**`, `apps/api/src/main.ts` tick, `scripts/dataset.ts`, plan/13, `EngineNotice` |
| 2 | §2: F20–F26, F29–F34, F65, F94, F109, in-app digests | `apps/api/src/services/{notifications,preferences,state,sync,home,activity}.ts`, new `routes/home.ts`, migration 019, `apps/web/src/pages/{Home,Listing}.tsx`, `dialogs/CustomiseHome.tsx`, `shell/Sidebar.tsx`, Settings "Notifications and New" section, new first-visit notification question, the New/count CSS rules |
| 3 | §3 sign-up and sign-in (after design review) | `apps/api/src/auth/*`, auth routes in `routes/public.ts`, `apps/web/src/auth/*`, Settings security section |
| 4 | §4 and F05, F43, F44, F48, F61–F63, F83, F104 | `packages/connectors/src/**` (new logic in `platforms.ts`; minimal edits to `discover.ts`/`input.ts`, which plan/28 also changes), `apps/api/src/services/{content,sources}.ts`, manual keep, search in `apps/api/src/services/items.ts`, migration 020, `apps/web/src/dialogs/AddSource.tsx` (incl. no-collection default, F27/F28) |
| 5 | §5 interface and outbox: F03, F04, F60, F66–F74, F82, F85–F93, F95–F97, F101, F105, F107, F108 | `apps/web/src/**` except WS2/WS3/WS4 files; `apps/api/src/services/captures.ts` (F107, F73 reading time) |
| 6 | email digests and notices (after plan/27 merges) | hooks into plan/27's mailer |

### Merging with parallel work

- **Account deletion** (feature/account-deletion, migration 017): a purge must release an account's
  stored objects through `releaseObject`, or delete its `storage_accounts` row in the same
  transaction, so the maintained `used_bytes` total (migration 023) stays exact; it must keep the
  session-class checks in `resolvePrincipal` (shared-computer sessions: browser-session cookie,
  8-hour absolute lifetime).
- **Outgoing email** (plan/27, migration 028): extend the isolated `signupHandler` in
  `routes/public.ts` for the hosted address; digests by email reuse `digestFor` in
  `services/notifications.ts`, which already applies the private-source title rule.
- **Annotations** (plan/26, migration 027): rule-based deletion in `cleanup.ts` and unfollow-with-delete
  must keep skipping annotated items; search writes go through `indexText` in `services/items.ts`
  (folded text).
- **Mastodon and Bluesky** (plan/28): `discover.ts` and `input.ts` conflict textually; this plan's
  additions are the platform table, known-feed rules and section-page logic in separate files plus
  one call after the YouTube branch.
