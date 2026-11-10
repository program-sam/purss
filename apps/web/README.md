# Web application

The responsive PURSS frontend: the approved A3 design (calm, sky accent, Nunito, mist
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
| `src/main.tsx`, `src/routes.tsx` | Providers, router, route guards driven by `/api/session` (setup, sign-in, invite, workspace) |
| `src/plugins.ts` | **Registration point** for pages built separately (see below) |
| `src/api/` | Typed fetch client (CSRF, error messages), query keys and fetchers, item cache helpers |
| `src/state/` | Toasts with Undo, popups, overlays, selection, item actions, preferences, live events |
| `src/shell/` | Sidebar, header, item panel, notifications, storage, keyboard handling |
| `src/pages/` | Home (four layouts) and the collection/source/basket page |
| `src/views/` | List, Cards, Board, Table and Timeline |
| `src/dialogs/` | Add source, collections, baskets, settings, search, delete previews |
| `src/lib/` | Pure helpers with tests: query builder, key rules, quiet hours, formatting |
| `src/sw/` | The service worker: request policy, the offline worker class and its tests; built to `/sw.js` |
| `src/offline/` | The page's side of offline reading: setting, worker link, the offline pack, install prompt, Settings field |
| `src/player/` | The in-app audio/video player: platform backend interface and the web backend, controller, Media Session, mini-player, the item panel's media box |
| `src/platform/` | What differs between the browser and the phone apps: transport, offline copies, player backend, downloads, share intake (below) |
| `src/downloads/` | "Downloaded" in the phone apps: the download manager, automatic rules, the reader section, the Downloaded page, Settings → This device, and the article read from a publisher's page for a summary-only item (`readable-page.ts`: Readability on an inert document, then a strict allowlist) |
| `src/share/` | Links shared into the phone apps: finding the link, Keep link or Add as source |
| `src/annotations/` | Highlights and notes: anchoring (`anchor.ts`, pure), drawing and selection (`highlight-dom.ts`), the offline outbox (`outbox.ts`, `outbox-store.ts`), hooks and the reader UI |
| `public/` | Copied to the site root: web manifest and icons |
| `src/app.css`, `src/extra.css` | A3 layout CSS ported from the prototype, plus real-app additions |
| `src/eink.css` | The e-ink display's rules for the app's own parts (tokens and primitives are in `packages/ui/src/eink.css`) |

Shared tokens and primitives are in `packages/ui`.

## Behaviour notes

- The URL is the source of truth: `/`, `/c/:id`, `/s/:id`, `/b/:id`, `/q/:id`, with the open item,
  view, filter, sort and source chip as search parameters (`?item=…&view=board&filter=toread`).
  `?dialog=add|settings|security|…` opens a popup once and is then removed.
- Every change that the API can reverse shows an Undo toast (`POST /api/undo`); item changes carry
  `expectedRevision` and a 409 refreshes the item and says so.
- Browser notifications are only requested from a button in Settings, only when the mode is
  "Browser alerts", and respect quiet hours and previews. Nothing is requested on load.
- E-ink display is a per-device choice (`src/lib/display.ts`, saved in local storage like Sounds):
  it sets `data-display="eink"` on `<html>` before the first paint, forces the light theme, and
  shows Page up / Page down buttons (`components/PageNav.tsx`) for the list and the article. Every
  e-ink rule is scoped to that marker, so the standard look never changes.
- The anniversary reminder card renders only when `GET /api/reminders` returns items.
- Article HTML is sanitised by the server and cleaned again in an inert document before display;
  video items link out ("Play on YouTube"), nothing is embedded or autoplayed.
- Text that comes from feeds or people (titles, snippets, names) carries `dir="auto"` and is isolated by the
  stylesheet (`[dir="auto"]`, `bdi`); `lib/bidi.ts` isolates names inside plain strings such as toasts.
  The play mark of a video card is a link to the video, laid over the card's picture.
- Font sizes in the stylesheets are in `rem`; the Settings text size sets the root font size per device (`lib/text-size.ts`).

## Player

An item whose feed offers an audio or video file shows a media box in its panel: play it. The server stores
no media files, so it plays from the publisher's own address. One `Player` (`src/player/player.ts`) lives above
the pages in `PlayerProvider`, so the mini-player (`PlayerBar.tsx`) keeps playing while you move around. It
plays the download on this device when there is one (the apps) and otherwise the publisher's file, and says which; skips back 15 s and
forward 30 s; offers 0.8× to 2× (remembered per device); and saves the position on the server
(`PUT /api/items/:id/playback`) on pause, every 15 s while playing, on close and when the page is hidden
(with `keepalive`). `media-session.ts` keeps the operating system's media controls in step.

Everything platform-specific is behind `PlayerBackend` (`src/player/backend.ts`): loading a URL, play,
pause, seek, speed, the element that shows video, and state changes. `HtmlMediaBackend` is the browser's
media element. A native shell passes its own backend to `<PlayerProvider backend={…}>`. The contract is
in [plan/25](../../plan/25-media-playback.md). Media requests are never touched by the service worker.
Rows and cards offer a quick download of the file only in the apps (`player/quick-download.ts`); a browser has none.

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
  network first with a four-second limit, then the saved copy) and the privacy rules: personal answers are
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
and clearing New markers. `entries.ts` has the pure rules (what a change looks like on screen while it waits, the
read-on-conflict rule, which failures mean wait, stop or give up, the scope an entry is filed under), `outbox.ts` the
`Outbox` class (order, retries, one pass at a time, one account's queue at a time), `store.ts` the IndexedDB store
(an index on scope = installation origin + account id; memory fallback), `sign-out.ts` the question asked when signing
out with changes unsent, and `instance.ts` the wiring to the API client. The page shows a change at once
(`state/actions.ts` updates the query cache and calls `outbox.submit`), `api/queries.ts` lays pending changes over
anything fetched meanwhile and tells the outbox who is signed in (from the session query), `OutboxController` resends on
`online`/visible/sign-in and asks before the page is left with changes unsent, and `PendingMark` is the small clock.
Several items at once (`batch.ts`) are one entry each, kept with that item's own revision. Clearing New and recording an opening do not move an item's revision (the New marker is separate from workflow and progress), so queued workflow changes are not disturbed by them; because of that, copies of an item are ordered by `stateVersion` alone (`isNewerCopy`: the cache, Home and the offline pack's staleness check), a counter PURSS moves by one on every change to the item's state (keeping and un-keeping it in a basket included, since `basketIds` is part of the copy), written in the same transaction as the change; no clock is involved, and conflict detection stays on the revision. Undo (`cancel(entryId, change)`) waits for the send lock: an entry that never left is removed; one that may have reached PURSS (`tried`, kept on disk before the request leaves, or already sent and removed by another tab) is removed, and for a workflow change the item is read back, giving the revision to send the opposite change on, or `cancelled` when it never took effect; if the item cannot be read the Undo is kept as an `undoWorkflow` entry that reads the item when it is sent, and the workflow changes queued after it move on to the revision its write produced, whatever revision the page had cached when they were made (changes written elsewhere are still caught, because the Undo reads the item first). An Undo belongs to the account that pressed it: if another account (or nobody) is signed in by the time it can be settled, `cancel` answers `away`, reads nothing and adds nothing to the current queue, and an Undo that had to be kept stays on disk under its own account. Keep and un-keep are idempotent. A workflow change is resent with the revision it was made against (the page's own
writes to the item, and the outbox's own sends, move waiting changes to the new revision); on a conflict the item is
read once: if its workflow already equals the target the change counts as done, otherwise it is dropped and the person
is told. No client timestamps and no comparison with the workflow the change started from. When the signed-in account
changes the previous queue is set aside untouched. Only the tab holding the `purss-outbox-send` Web Lock sends.

The PNG icons are rendered from `public/icon.svg` (the same artwork as the favicon): 192 and 512 for
any use, a 512 maskable with the artwork inside the safe zone, and a 180 Apple touch icon. To change
them, edit the artwork and render the PNGs again with Playwright's Chromium.

## Highlights and notes

`src/annotations/` holds the reader's annotations (plan/26). The article's text is read as its text
nodes with white space collapsed and block boundaries as one space (`anchor.ts`); a highlight stores
its passage, 32 characters on each side and its position there, and is found again by its words,
then context, then nearness. `renderHighlights` draws `<mark class="anno">` pieces into the prepared
article HTML (overlaps share pieces); the first piece of each is focusable and opens it with `Enter`.
The selection bar follows `selectionchange`, so mouse, touch handles and keyboard selection all work.
Every change goes through the outbox (`outbox.ts`, IndexedDB in `outbox-store.ts`): recorded, laid over
the server's list for display (`mergeView`), then sent; offline it waits and shows *Waiting to sync*.
`AnnotationSync` (mounted in `main.tsx`) sends what waits at start, on reconnect and when the page is
shown, and deletes another account's entries; sign-out clears it. The offline pack saves
`/api/items/:id/annotations` for queued items that have annotations (`ItemDTO.annotatedAt`).

## Adding a page (data, sharing, admin)

Push an entry onto `workspacePages` in `src/plugins.ts` before the router is created:

```ts
workspacePages.push({ path: "/sharing", title: "Sharing", component: SharingPage, nav: { label: "Sharing", icon: "link" } });
```

The route is mounted under the signed-in shell automatically; `nav` adds a sidebar entry,
`adminOnly` hides it from non-administrators, and `parent` supplies a breadcrumb parent. While the
array is empty nothing is rendered and no link points at those routes.

## Platform layer and the phone apps

The same build runs in a browser and inside the Android and iOS apps (`apps/mobile`,
[plan/31](../../plan/31-mobile-apps.md)). Screens never ask which; they use `platform` from
`src/platform/index.ts`, which `main.tsx` sets up before anything renders (`initPlatform()`):

| Part | Web (`platform/web.ts`) | Apps (`platform/native/`) |
| --- | --- | --- |
| `transport` | `fetch` same-origin with the cookie; `EventSource` | The connected origin with `Authorization: Bearer`; `/api/events` read with fetch (`sse.ts`); copyable reads through the `OfflineWorker`; downloaded items when nothing else answers (`native/transport.ts`) |
| `offline` | The service worker (`web-offline.ts`) | The same `OfflineWorker` in the page, copies in IndexedDB (`copies.ts`) |
| `createPlayerBackend()` | `HtmlMediaBackend` | `AppPlayerBackend`: native audio with lock-screen controls, video in the page |
| `downloads` | none | `DownloadManager` (`src/downloads`) over the device's files |
| `connection` | none | The connected PURSS: disconnect, signed-out handling, opening pages in the browser |
| `fileExports` | yes | no: exports open in the browser |
| `onShare` | never fires | Links shared from other apps |

The apps' code is a separate chunk, loaded only inside the shell. An app that isn't connected shows
`native/ConnectScreen.tsx` instead of the router. `src/offline/worker-link.ts` and `store.ts` reach
the copies only through `platform.offline`, so the offline pack, its settings and notices are one
system on both.

## Tests

`src/lib/*.test.ts`, `src/sw/*.test.ts`, `src/offline/*.test.ts`, `src/outbox/*.test.ts`, `src/platform/**/*.test.ts`, `src/downloads/*.test.ts` and `src/share/*.test.ts` are pure Node tests run by the root `npm test`. Browser behaviour is checked
against the real stack (see the repository's `tests/` and `plan/13-validation.md`).
