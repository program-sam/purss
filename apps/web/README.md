# Web app

The responsive PURSS web app: the approved A3 design (calm, sky accent, Nunito, mist
sidebar, soft top-lit headers) as a React 19 app with TanStack Router and Query. It talks only
to the product API (`/api`, contract in `packages/domain/src/api.ts`); it never reaches FreshRSS
or the worker, and ships no third-party requests (the font is self-hosted, the API serves a strict
CSP).

## Run and build

```text
npm run build -w @purss/web      # vite build -> apps/web/dist, served by the API at /app/
npm run dev -w @purss/web        # vite dev server, proxies /api to the API
```

For development start the API with `PURSS_PUBLIC_ORIGIN` set to the dev server's origin so its
origin and passkey checks match (defaults: dev server `http://localhost:5173`, API
`http://127.0.0.1:8940`; override with `PURSS_WEB_PORT` and `PURSS_API_URL`).

## Layout

| Path | What lives there |
| --- | --- |
| `src/main.tsx`, `src/routes.tsx` | Context providers, router, route guards driven by `/api/session` (setup, sign-in, invite, your PURSS) |
| `src/plugins.ts` | **Registration point** for pages built separately (see below) |
| `src/api/` | Typed fetch client (CSRF, error messages), query keys and fetchers, item cache helpers |
| `src/state/` | Toasts with Undo, popups, overlays, selection, item actions, preferences, live events |
| `src/shell/` | Sidebar, header, item panel, notifications, storage, keyboard handling |
| `src/pages/` | Home (four layouts) and the collection/source/basket page |
| `src/views/` | List, Cards, Board, Table and Timeline |
| `src/dialogs/` | Add source, collections, baskets, settings, search, delete previews |
| `src/lib/` | Pure helpers with tests: query builder, key rules, quiet hours, formatting |
| `src/sw/` | The service worker: request policy, the offline service worker class and its tests; built to `/sw.js` |
| `src/offline/` | The page's side of offline reading: setting, service worker link, the offline pack, install prompt, Settings field |
| `src/player/` | The in-app audio/video player: platform backend interface and the web backend, controller, Media Session, mini-player, the item panel's media box |
| `src/platform/` | What differs between the browser, the mobile app (`native/`) and the desktop app (`desktop/`): transport, offline copies, player backend, downloads, share intake (below) |
| `src/downloads/` | "Downloaded" in the mobile and desktop apps: the download manager, automatic rules, the reader section, the Downloaded page, Settings → This device, and the article read from a publisher's page for a summary-only item (`readable-page.ts`: Readability on an inert document, then a strict allowlist) |
| `src/share/` | Links shared into the mobile app: finding the link, Keep link or Add as source |
| `src/annotations/` | Highlights and notes: anchoring (`anchor.ts`, pure), drawing and selection (`highlight-dom.ts`), the offline outbox (`outbox.ts`, `outbox-store.ts`), hooks and the reader UI |
| `public/` | Copied to the site root: web manifest and icons |
| `src/app.css`, `src/extra.css` | A3 layout CSS ported from the prototype, plus real-app additions |
| `src/eink.css` | The e-ink display's rules for the app's own parts (tokens and primitives are in `packages/ui/src/eink.css`) |

Shared tokens and primitives are in `packages/ui`.

## Behaviour notes

- The URL is the source of truth: `/`, `/c/:id`, `/s/:id`, `/b/:id`, `/r/toread`, with the open item,
  view, filter, sort and source chip as search parameters (`?item=…&view=board&filter=toread`).
  `?dialog=add|settings|security|…` opens a popup once and is then removed.
- Every change that the API can reverse shows an Undo toast (`POST /api/undo`); item changes carry
  `expectedRevision` and a 409 refreshes the item and says so. The player's own moves to In progress and
  Finished (`player/player.ts`, `setPlaybackWorkflow` in `outbox/item-writer.ts`) are the exception: they carry a playback session
  and the workflow revision, say nothing and have no Undo, and go through the same outbox.
- Browser notifications are only requested from a button in Settings, only when the mode is
  "Browser alerts", and respect quiet hours and previews. Nothing is requested on load.
- E-ink display is a per-device choice (`src/lib/display.ts`, saved in local storage like Sounds):
  it sets `data-display="eink"` on `<html>` before the first paint, forces the light theme, and
  shows Page up / Page down buttons (`components/PageNav.tsx`) for the list and the article. Every
  e-ink rule is scoped to that marker, so the standard look never changes.
- The On this day card renders only when `GET /api/reminders` returns items.
- Article HTML is sanitised by the server and cleaned again in an inert document before display;
  a video page plays in the reader in its platform's own sandboxed player only once play is pressed
  there (`components/VideoEmbed.tsx`); nothing autoplays.
- Text that comes from feeds or people (titles, snippets, names) carries `dir="auto"` and is isolated by the
  stylesheet (`[dir="auto"]`, `bdi`); `lib/bidi.ts` isolates names inside plain strings such as toasts.
  A video card's play mark is part of the card: pressing it opens the item in the reader, like the rest of the card.
- Font sizes in the stylesheets are in `rem`; the Settings text size sets the root font size per device (`lib/text-size.ts`).

## Player

An item whose feed offers an audio or video file shows a media box in its panel: play it. The server stores
no media files, so it plays from the publisher's own address, over https only (the page's `media-src` is `https:`; the
reader says the publisher sees the listener's address). Only the item's first audio or video enclosure counts (by
declared type, or by file extension when untyped), never a streaming playlist, a web page or a platform's page; a private
source's item has no player and no file address, since a private feed's enclosure addresses can carry its owner's
secret. One `Player` (`src/player/player.ts`) lives above the pages in `PlayerProvider`, so the mini-player
(`PlayerBar.tsx`) keeps playing while you move around. It plays the download on this device when there is one (the apps)
and otherwise the publisher's file, and says which; skips back 15 s and forward 30 s (also from the system's "next" and
"previous"); offers 0.8× to 2× (remembered per device) and a sleep timer of 5 to 60 minutes (on this device's clock, ended
when the player closes); and saves the position on the server (`PUT /api/items/:id/playback`) on pause, every 15 s while
playing, on close and when the page is hidden (with `keepalive`). A position recorded while offline is sent late with
`recordedAt`; the server keeps the position recorded last, so an older one never replaces a newer one from another
device. `media-session.ts` keeps the operating system's media controls in step. Media requests are never touched by the
service worker. Rows and cards offer a quick download of the file only in the apps (`player/quick-download.ts`); a browser
has none.

Everything platform-specific is behind `PlayerBackend` (`src/player/backend.ts`): `supportsVideo`, `load(source,
{ startAt, rate, autoplay })`, `play`, `pause`, `seek`, `setRate`, `view()` (the element that shows video, or null),
`state()` (position, duration, playing, buffering, ended, failed), `subscribe` and `unload`. `HtmlMediaBackend` is the
browser's media element; a native shell passes its own backend to `<PlayerProvider backend={…}>`. The controller
(`player.ts`) chooses the source (the device download first, then the publisher), resumes, saves positions and owns the
speed; the UI (`PlayerBar.tsx`, `MediaSection.tsx`) and the Media Session wiring talk only to the controller.

**Workflow from playing.** An item that is New or To read/listen/watch becomes In progress after 30 seconds of real
playing (the clock counts only while the playhead moves forward at about the playing speed: seeks, pauses and stalls
add nothing), and Finished once it has played for three seconds at or after the finish point (95% of its length or its
last two minutes, whichever comes first, never before halfway); a seek into or past the finish point is not playing
there. With an unknown length only In progress happens. It only moves forward, never changes Ignored or Finished, and is
quiet: no message and no Undo, and the change goes through the same outbox as any workflow change, carrying the playback
session and the workflow revision so that a state the person set by hand (on any device, in bulk, by Undo or by a Smart
filter) is never overridden by playback.

**Video platforms.** A YouTube (no-cookie player), Vimeo, Dailymotion, Odysee or Twitch video page, or an Instagram post
(`/p/<code>/`, `/reel/<code>/`), plays or shows in the reader in the platform's own embedded player
(`src/lib/embeds.ts`, `components/VideoEmbed.tsx`, sandboxed, referrer policy `strict-origin-when-cross-origin`). A
video loads only when the person presses play, so opening an item asks nothing of the platform; an item with a publisher
file plays that file instead, and *Open on …* always stays. An Instagram post loads as soon as the item opens, since
there is nothing else to show; one a basket kept with its pictures shows those in a slideshow of the kept pictures
instead (`PictureSlideshow`), the embed behind *Show the post here*. Embedded videos have no position, mini-player or
media controls and are never marked Finished by themselves (the end can't be known without the platform's own script,
which the page's policy doesn't allow); pressing Play on a YouTube video marks it In progress. Twitch is embedded only
on an https page or `http://localhost`. In an app whose page isn't a web address (the desktop app on macOS and Linux at
`tauri://`, the mobile app on an iPhone at `capacitor://`) the players get no referrer and their framing rules refuse the page, so
only Odysee is embedded there and the rest open on the platform's site. PeerTube stays a link, since every instance has
its own origin. In the apps the page policy's `frame-src` lists exactly these players' origins; in a browser it allows
web pages for originals that allow PURSS to frame them (see below).

**An episode's original.** Listen or Watch leads the item's panel, above State and Keep. *Open original* is the item's own
page and never the audio or video file: a link that is the same address as one of the item's enclosures, or ends in a
media file name, is not a page (the server decides, `ItemDTO.linkIsMedia`, from the enclosures as the feed sent them, so
a private source never offers its file address). Such an episode offers *Open the show's website* (the source's
`siteUrl`, unless it is the feed's own address) and nothing when there is none.

The server keeps no media file: if the publisher removes one, only a device download may remain. Playback
positions are not part of the JSON export.

## Originals in the reader

*Open original* and links in an article or its excerpt (`data-inapp`) open inside the reader instead of leaving PURSS
(`src/lib/originals.ts`, `shell/WebPane.tsx`): in a browser, a frame over the reader when the page allows framing and
otherwise a new tab; in the desktop app, the app's own web view over the reader (see the [desktop README](../desktop/README.md));
in the mobile app, a browser tab over the app. Lists' *Open original*, video and audio links, and links elsewhere in
PURSS open outside PURSS. A bar above the page names the site and the rest of its address, says *Not secure* for plain
http, and offers reload and the page outside PURSS; *Article* or Esc goes back.

A browser refuses a frame when the page's headers say so, and the page around it can't tell, so the server reads the
page's headers (`GET /api/frame-check?url=`, `checkFraming` in `packages/connectors/src/frame-policy.ts`, through the
safe fetcher) and judges them against `PURSS_PUBLIC_ORIGIN` the way browsers do. It is asked when an item opens, for its
original, and for a link in the article when the pointer rests on it or it gets focus; a press decides on what is known
then, and no answer yet means a new tab (a new tab is the link's own behaviour, so no popup blocker interferes). Answers
are kept six hours per installation and checks are limited per account. The frame is
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"` with
`allow="fullscreen"` and never `allow-top-navigation`. Because a site sees PURSS as another site in a frame, its cookies
are kept apart: a login or paid membership usually doesn't show there, and *Open in a new tab* does. The real page loads
(its own address, ads and analytics), so the publisher is credited and gets the visit.

## Install and offline reading

The app is a progressive web app: `public/manifest.webmanifest` and the icons make it installable,
and a hand-written service worker (no libraries) provides the offline behaviour. The `purss-service-worker`
plugin in `vite.config.ts` builds `src/sw/sw.ts` to `/sw.js` after the app, injecting the list of
built files to save and a build name made from their contents; nothing is registered in `vite dev`.
The API serves `/sw.js` and the manifest with `Cache-Control: no-cache`.

- `src/sw/policy.ts` decides which requests the worker touches. The saved reads are an allow-list;
  everything else (live updates, sign-in, administration, exports, storage, search, public pages and every
  change) goes straight to the network.
- `src/sw/offline-worker.ts` holds the strategies (app shell per build; page loads and `/api` reads
  network first with a four-second limit, then the offline copy) and the privacy rules: personal answers are
  kept only while offline reading is on and an account is known, in a cache per account, and are wiped at
  sign-out, on a signed-out session answer or error, when the account changes and when the setting is
  turned off. Its tests run against an in-memory Cache Storage (`src/sw/testing.ts`).
- `src/offline/` registers the worker (`OfflineController`, mounted once in `main.tsx`), tells it who is
  signed in and whether the setting is on, runs the offline pack (`pack.ts` chooses the queue;
  `pack-runner.ts` fetches it through the same requests the pages make), and shows the Settings field and
  the offline notice. Changes to items go through the write outbox (below); highlights and notes have their
  own outbox (below); other changes made offline are not queued and fail with the usual message.
- A new build waits until the page shows **A new version is ready** and the person presses Reload.

## The write outbox

`src/outbox/` holds changes to items until PURSS confirms them: workflow changes, keep and un-keep,
and clearing New. `item-writer.ts` is how the page writes to an item. `showChange` is the one rule for what a change looks like on
an item, and follows what PURSS answers: a workflow change, keeping or taking out of a basket, and reading progress are doing something
with the item, so its New marker goes, while a change that changes nothing leaves it. The same rule builds the copy shown the moment a
change is made and, through `overlayItem`, the copy a reloaded list shows while the change still waits. `createItemWriter` is every
write the page makes (workflow, the player's own changes, keep, Mark as seen, opening, reading progress): it shows the change, sends it
through the outbox or, for opening and reading progress, one request at a time per item (`writeState`, which also moves waiting
workflow changes to the revision it produced), and tells the person how it ended, with Undo. It is given the page's copies of items,
the outbox and the requests, so its tests run without a browser; `state/actions.ts` only wires it to the query cache and the toasts.
`entries.ts` has the other pure rules (the read-on-conflict rule, which failures mean wait, stop or give up, the scope a queued change is filed under), `outbox.ts` the
`Outbox` class (order, retries, one pass at a time, one account's queue at a time), `store.ts` the IndexedDB store
(an index on scope = installation origin + account id; memory fallback), `sign-out.ts` the question asked when signing
out with changes unsent, and `instance.ts` the wiring to the API client. The page shows a change at once
(`item-writer.ts` updates the query cache and calls `outbox.submit`), `api/queries.ts` lays pending changes over
anything fetched meanwhile and tells the outbox who is signed in (from the session query), `OutboxController` resends on
`online`/visible/sign-in and asks before the page is left with changes unsent, and `PendingMark` is the small clock.
Several items at once (`batch.ts`) are one queued change each, kept with that item's own revision. Clearing New and recording an opening do not move an item's revision (the New marker is separate from workflow and progress), so queued workflow changes are not disturbed by them; because of that, the page orders its records of an item by `stateVersion` alone (`isNewerCopy`: the cache, Home and the offline pack's staleness check), a counter PURSS moves by one on every change to the item's state (keeping and un-keeping it in a basket included, since `basketIds` is part of the record), written in the same transaction as the change; no clock is involved, and conflict detection stays on the revision. Undo (`cancel(entryId, change)`) waits for the send lock: a queued change that never left is removed; one that may have reached PURSS (`tried`, kept on disk before the request leaves, or already sent and removed by another tab) is removed, and for a workflow change the item is read back, giving the revision to send the opposite change on, or `cancelled` when it never took effect; if the item cannot be read the Undo is kept as an `undoWorkflow` change that reads the item when it is sent, and the workflow changes queued after it move on to the revision its write produced, whatever revision the page had cached when they were made (changes written elsewhere are still caught, because the Undo reads the item first). An Undo belongs to the account that pressed it: if another account (or nobody) is signed in by the time it can be settled, `cancel` answers `away`, reads nothing and adds nothing to the current queue, and an Undo that had to be kept stays on disk under its own account. Keep and un-keep are idempotent. A workflow change is resent with the revision it was made against (the page's own
writes to the item, and the outbox's own sends, move waiting changes to the new revision); on a conflict the item is
read once: if its workflow already equals the target the change counts as done, otherwise it is dropped and the person
is told. No client timestamps and no comparison with the workflow the change started from. When the signed-in account
changes the previous queue is set aside untouched. Only the tab holding the `purss-outbox-send` Web Lock sends.

The PNG icons are rendered from `public/icon.svg` (the same artwork as the favicon): 192 and 512 for
any use, a 512 maskable with the artwork inside the safe zone, and a 180 Apple touch icon. To change
them, edit the artwork and render the PNGs again with Playwright's Chromium.

## Highlights and notes

`src/annotations/` holds the reader's annotations. A *highlight* is a passage with an optional comment, a *note* is text
about the whole item; both are stored apart from workflow, reading progress, collection and basket membership, and
retention. The article's text is read as its text
nodes with white space collapsed and block boundaries as one space (`anchor.ts`); a highlight stores
its passage (at most 5,000 characters), 32 characters on each side and its position there, and is found again by its
words, then context, then nearness, on exact words only (a guessed anchor could mark the wrong passage). A passage that
isn't in the text shown is listed as *Not found in the text shown* with its quote; it is never deleted or moved.
`renderHighlights` draws `<mark class="anno">` pieces into the prepared
article HTML (overlaps share pieces); the first piece of each is focusable and opens it with `Enter`.
The selection bar follows `selectionchange`, so mouse, touch handles and keyboard selection all work; it offers
**Highlight** and **Add comment** (`h` and `c` do the same). A comment or note is at most 10,000 characters and an item
holds at most 500 live annotations (`limits.ts` repeats the server's limits; a test keeps them equal).
Every change goes through the outbox (`outbox.ts`, IndexedDB in `outbox-store.ts`): recorded,
laid over the server's list for display (`mergeView`), then sent. A write carries the whole annotation and the time it
was made, the server keeps the later one per annotation, and a new change replaces any unsent change of the same
annotation. Offline, a busy server or an ended session leave it waiting and shown as *Waiting to sync* (also counted in
the item panel); a refusal (item deleted, too many, storage full beyond the headroom) marks it failed with the reason,
*Try again* and *Discard this change*, and a refused removal is dropped.
`AnnotationSync` (mounted in `main.tsx`) sends what waits at start, on reconnect, when the page is shown and every ten
seconds while something waits. The offline pack saves `/api/items/:id/annotations` for queued items that have
annotations (`ItemDTO.annotatedAt`). The outbox works whether or not *Offline reading on this device* is on.

Unsent changes belong to an account. In a browser, signing out deletes them after a warning in *Settings → Security* when any
wait, and another account signing in deletes the previous account's; an expired session keeps them. In the apps,
*Disconnect this app* deletes them after the same warning, but a lost connection keeps them, and so does connecting with
another account: they are sent when their account connects again, and *Settings → This device* offers to copy them as
text or discard them. Nothing unsent is deleted without the person's say in the apps.

Annotations pin no kept version and make no readable copy. Unfollowing with *Also delete the items you haven't kept* skips any item with a live
annotation; an explicit permanent delete names the items that carry annotations and needs the same
tick as kept items. Annotated items stay in lists and search after their source is unfollowed. Annotation text is
searchable, is in the JSON export, appears to assistants as the person's own writing (they can't write annotations) and
is never in a publication.

## Adding a page (data, sharing, admin)

Add a page to `featurePages` in `src/features/pages.tsx` (Discovery, sharing, your data, review and administration are
there), or push one onto `purssPages` in `src/plugins.ts` before the router is created:

```ts
purssPages.push({ path: "/sharing", title: "Sharing", component: SharingPage, nav: { label: "Sharing", icon: "link" } });
```

The route is mounted under the signed-in shell automatically; `nav` adds a sidebar link,
`adminOnly` hides it from non-administrators, `hostedOnly` hides the link on a self-hosted installation, and `parent`
supplies a breadcrumb parent. A page appears only when it is registered, so no link points at a route that renders
nothing.

## Platform layer and the apps

The same build runs in a browser, inside the mobile app (`apps/mobile`, see its
[README](../mobile/README.md)) and inside the desktop app (`apps/desktop`, `src/platform/desktop/`, see its
[README](../desktop/README.md)). Screens never ask which; they use `platform` from
`src/platform/index.ts`, which `main.tsx` sets up before anything renders (`initPlatform()`):

| Part | Web (`platform/web.ts`) | Mobile app (`platform/native/`) and desktop app (`platform/desktop/`) |
| --- | --- | --- |
| `transport` | `fetch` same-origin with the cookie; `EventSource` | The connected origin with `Authorization: Bearer`; `/api/events` read with fetch (`sse.ts`); copyable reads through the `OfflineServiceWorker`; downloaded items when nothing else answers (`native/transport.ts`) |
| `offline` | The service worker (`web-offline.ts`) | The same `OfflineServiceWorker` in the page, offline copies in IndexedDB (`copies.ts`) |
| `createPlayerBackend()` | `HtmlMediaBackend` | Mobile app: `AppPlayerBackend`, native audio with lock-screen controls and video in the page. Desktop: `HtmlMediaBackend` |
| `downloads` | none | `DownloadManager` (`src/downloads`) over the device's files |
| `connection` | none | The connected installation and which device it is on (`phone` or `computer`): disconnect, signed-out handling, opening pages in the browser |
| `keepsOtherAccountsUnsent` | `false`: a browser's storage is shared, so another account's unsent highlights, notes, playback positions and reading progress are deleted when someone else signs in | `true`: they stay, per account, for when it connects again |
| `passkeys` | The browser's | Mobile app: the phone's own, where the installation vouches for the app. Desktop: none |
| `saveFile` | A download | Mobile app: the share sheet. Desktop: a save dialog |
| `onShare`, `widget`, `push` | none | Mobile app: links shared in, the home-screen panels, notifications |
| `notifier`, `badge`, `onIntake`, `desktop` | The browser's alerts; no badge | Desktop: system notifications, the icon's count, feed links and OPML files, updates, the downloads folder |
| `interfaceUpdates`, `appUpdates` | none | Interface updates from the connected installation; the mobile app also learns of new versions of the app |
| `webView`, `frames` | `frames`: the reader may frame a page whose headers allow it | Desktop: its own web view shows any page. Mobile app: pages open in a browser tab over the app |

The apps' code is a separate chunk, loaded only inside the shell. Both apps start and stop in one place,
`platform/connected-app.ts`: `startConnectedApp(shell, page)` reads the saved connection, adds the connected
installation's policy to the page, makes the offline copies, transport, downloads and interface updates, and
forgets the device when it is disconnected or lost (`native/forget.ts` says what goes). A `ConnectedShell` is
only what differs: secure storage, the updater, audio, push, the web view, the icon's badge and the first screen
(`native/index.tsx` for the phones, `desktop/index.tsx` for the computer); a `Page` is the browser's part
(links, policy, storage, what the page keeps for PURSS; `browser-page.ts`), so `connected-app.test.ts` runs the start-up and
the disconnect and lost-device flows against fakes of both. The folder `native/` also holds what the
desktop app shares with the phones: the connect screen and flow, the transport and the live-update rules.
An app that isn't connected shows `native/ConnectScreen.tsx` instead of the router. `src/offline/service-worker-link.ts` and `store.ts` reach
the offline copies only through `platform.offline`, so the offline pack, its settings and notices are one
system on both.

## Tests The component map is in [architecture](../../docs/architecture.md#components).

`src/lib/*.test.ts`, `src/sw/*.test.ts`, `src/offline/*.test.ts`, `src/outbox/*.test.ts`, `src/platform/**/*.test.ts`, `src/downloads/*.test.ts` and `src/share/*.test.ts` are pure Node tests run by the root `npm test`. Browser behaviour is checked
against the real stack (see the [acceptance journeys](../../tests/acceptance/README.md) and [testing](../../docs/development.md#testing-and-acceptance)).
