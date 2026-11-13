# Phone apps: downloads in the background, real cancelling, home-screen widgets

The phone apps ([plan/31](31-mobile-apps.md)) run the web app's code in a WebView. Three things need
native code that runs without that page: automatic downloads while the app is closed, stopping a
download on the wire, and home-screen widgets (*panels*: To read, To listen, New, a chosen collection, a
chosen source). This document records how they are built, the
contract between the page and the native side, and what is not built.

## Shape

```text
page (apps/web, in the WebView)                      native (apps/mobile)
  DownloadManager ── mirror(state) ───────────────►  PurssDevice plugin: background state, panels' look and episode
    │  plan: POST /api/downloads/plan ◄──┐              │
    │  adopt record.json on start/sync   │              ├─ download/cancel (foreground transfers)
  DeviceRunner ── look, episode, refresh ┼───────────►  │
  OpenLinks ◄── purss://open?item=…|list=… ◄──── panel tap
                                         │              ▼
                                         ├──── background job (WorkManager / BGProcessingTask)
                                         │       token: secure storage (read only)
                                         │       → plan → item, annotations, publisher's file
                                         │       → downloads-incoming/… → downloads/<account>/<item>/ + record.json
                                         └──── panel refresh (WorkManager / BGAppRefreshTask, every 15 min asked)
                                                 token: secure storage (read only)
                                                 → GET /api/items for each placed panel's list (+ /api/bootstrap for chosen ones)
                                                 → the panels' lists → redraw
```

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| One download system | The rules (`packages/domain/src/downloads.ts`: what is wanted, sizes, the limit, cleanup) are shared. Which items to fetch is asked of PURSS, `POST /api/downloads/plan`, by both the open app and the background job; the server runs the same rules over the To read list (its first 200). The page adopts the job's results as its own download records | Kotlin and Swift never restate the rules; one decision for both paths |
| The plan endpoint | Body: the device's settings (`autoToRead`, `limitBytes`), `usedBytes`, and `have`: every item with a download record on the device, any state (at most 5000). Answer: the items to fetch in order, each with its expected size and the file to fetch (the publisher's https address, type, declared size, file name; PURSS keeps no media files). Nothing about the device is stored. Session or `mobile` device token; the extension's token is refused | Narrow: the existing list endpoints would need the rules on the device. A publisher's plain-http file is never planned (it would only fail) |
| Connection rule | Checked on the device before asking: Wi-Fi only by default, as in the app. Android: the job itself needs a connection, battery not low and storage not low (WorkManager constraints); Wi-Fi only is checked when it runs (Wi-Fi or Ethernet). iOS: `BGProcessingTask` with network required; the background URLSession refuses cellular when Wi-Fi only is on | The panels' refresh is a few small requests and may run on mobile data; files never do when the setting says Wi-Fi |
| What the job needs | The device token and the server's address: read from the same secure storage the page uses (Android Keystore entry `capacitor-storage_purss.connection`, iOS Keychain item of that account, after first unlock), never copied. The account, settings, `have` and `usedBytes`: the page mirrors them to native storage (`PurssDevice.setBackground`) whenever downloads or their settings change; a mirror whose server differs from the stored connection is ignored | One copy of the credential; the page stays the owner of download state |
| Where the files go | The job downloads into `downloads-incoming/<account>/<item>/` and, complete, moves the folder to `downloads/<account>/<item>/` (Android: the app's files folder; iOS: `Library/NoCloud`), with `item.json`, `annotations.json` (when the item has notes), the media file, and `record.json` written last. The page adopts a folder it has no record for when it starts and before each sync; damaged or unfinished folders are swept | Exactly where the download manager reads; a half-written folder is never in the downloads folder |
| `record.json` | `{itemId, title, sourceTitle, kind, state: "done"\|"failed", status, media: {file, bytes, type, kind}, textBytes, savedAt}`; `status` is the failure's HTTP status, 0 for a lost connection, -2 for too large; the page words it (`failureText`). A media `file` must lie in the item's own folder | No user-facing text in native code; a record can't point at another file |
| Limit and cleanup | The job never fetches more than the room left under the limit (it stops the transfer when the declared or received size passes it, as the page does) nor 4 GB. Adopted downloads count toward the device's total; *Remove downloads when finished* and removal of deleted items run when the app next syncs | The page's cleanup is the one place that removes downloads |
| App open | Android: the job does nothing while the app is in the foreground and stops its transfer (the partial folder is discarded) when the app comes to the front; the open app's own sync does the work. iOS runs `BGProcessingTask` only in the background | Two downloaders never write the same item |
| Schedule | Android: unique periodic work every hour (WorkManager's own back-off); scheduled while connected, replaced when Wi-Fi only changes, cancelled on disconnect. iOS: a processing request (earliest one hour later) submitted when the app goes to the background and after each run; the system chooses when | Within each system's budget; nothing runs when nothing is connected |
| Revoked token | A 401 from PURSS: the job deletes `downloads/` and `downloads-incoming/`, the mirrored state, everything the panels kept (their lists, chosen collections and sources, the page's snapshot) and the notification code's fetch credential (plan/37), cancels its schedule and the panels' refresh, and leaves a flag; the page, on its next start, sees the flag and runs the app's own *lost* path (token, offline copies, downloads, the phone's notification registration with the relay; unsent highlights and notes stay, plan/31) | The native side holds nothing of an account PURSS refused |
| Disconnect | The page's wipe (which also unregisters the phone's notifications, plan/37) calls `PurssDevice.reset()` before removing the downloads and again after; a transfer that finishes meanwhile moves its folder in only while the mirrored state still names the account (checked under the same lock the wipe holds): cancels the schedule and any background transfer, deletes `downloads-incoming/`, the mirror and everything the panels kept, and redraws them as *not connected*. A generation number, bumped under the panels' lock by every wipe, stops a refresh or setup that started before from writing the old account's titles back, and a refusal that arrives late from wiping a newer connection | Wiped with everything else |
| Cancelling | A small plugin of the app's own, `PurssDevice` (Android `app.purss.device`, iOS `App/PurssDevice`), does every download: `download({id, url, path, maxBytes})` writes `<path>.part` and renames when complete, `cancel({id})` closes the connection and deletes the partial file, `progress` events. Too large stops at once (`too_large`). The page's start-up sweep stays for files a stopped app left | The transfer stops on the wire; nothing runs on after *Remove all downloads* |
| Panels | Five kinds, each its own entry in the launcher's widget list: **To read** (To read articles and videos, newest first, as the To read page; Android's provider keeps its first class name and iOS its widget kind, so panels placed before stay), **To listen** (To read podcast episodes, oldest first, as Home's row, under the current or last played episode with play/pause on Android), **New** (New items from every source), **Collection** and **Source** (the Active list of one the person chooses). In the app's look: a card header (the app's soft tint and line, as its dialogs and sign-in card) with the logo, the panel's name and the count when PURSS gives one (typed lists have none); rows as the app's lists, the source's tile (its initials on its hue, as the app makes both) before the title in bold over *source, age*. Light and dark follow the system unless the app's theme says otherwise (every colour is set on each draw, as a launcher may apply an update onto what it shows); e-ink shows black on white with outlined tiles. Android draws as many rows as the panel's height holds (at most 8); iOS by family | The lists people asked for; each panel matches the page its heading opens |
| Lists | Fetched by the native side, which knows which panels are placed and what each shows; the page doesn't fetch them. One request per list, the table in `apps/mobile/widget-lists.json` (checked by the Kotlin and page tests; Swift follows it): `GET /api/items?…&limit=10&exceptPrivate=1`. A refresh asks each placed panel's list once; with a chosen collection or source it also reads `/api/bootstrap` for names and whether the choice still exists (a source no longer followed stays readable by id, so the catalogue is the check) or became private. A failed request keeps the last list. Kept as `{key: {rows: [{id, title, sourceTitle, at}], total, state: ok\|loading\|gone\|private, name}}` | One fetcher per platform for open and closed app alike; a configurable panel's list is only known natively |
| Refresh | Android: unique periodic WorkManager work every 15 minutes (the shortest it allows), needing only a connection, scheduled while any panel is placed, and one-time work when the app asks (`PurssDevice.refreshWidgets()`: on start and two seconds after items change), when a panel is placed or chosen. One refresh at a time; asking during one runs one more pass. iOS: a `BGAppRefreshTask` (earliest 15 minutes) and the open app's refreshes. The system decides when, within its battery rules; none is promised | Fresh enough for New without a server push |
| Choosing | Android: placing a Collection or Source panel opens a short list of the PURSS's collections, or its followed sources without the private ones (from `/api/bootstrap` with the device token); Android 12 and later reconfigure from the panel's long-press, and a panel whose choice is gone or became private opens the list when tapped. iOS: the widget's own configuration (iOS 17 and later), from the choices the app writes. The choice (which collection or source a panel shows) is the account's: wiped on disconnect, the panel then asks again | No free-form input; what is shown is what PURSS lists |
| Page's part | A snapshot, `{appearance, episode: {id, title, sourceTitle, playing, loaded, positionSeconds, durationSeconds} \| null, updatedAt}`, written by the page when the look or the player changes (`apps/web/src/device/widget.ts`). Items of private sources are never in a panel, as their titles are never in notifications: a panel shows on the home screen and, on iOS, the lock screen (and private sources have no episodes to play). Android keeps lists, choices and snapshot in the app's private preferences; iOS in the app group's container, the only thing the widget extension reads. They never hold the token or any address of the PURSS | A panel is drawn by another process; it gets titles, not credentials |
| Taps | A row opens `purss://open?item=<id>`: the app navigates to the item over Home. A heading opens `purss://open?list=<key>`: the list it shows (To read and To listen the reading list limited to their item types, a collection or source its Active list; New has no page of its own and opens Home). Nothing else is done; anything else after `purss://open` is ignored. One reader and one handler for these and tapped notifications (`platform/open-link.ts`, `shell/OpenLinks.tsx`). The episode's play/pause on Android goes to the app's running Media3 session; when the app isn't running it opens the episode instead | A deep link that only navigates can't be abused to act on someone's behalf |

## Verified

- Unit tests: the shared rules and the plan request (`packages/domain/src/downloads.test.ts`), the plan
  endpoint over HTTP and its reach (`apps/api/src/routes/downloads.test.ts`: session yes, `mobile` token
  yes, extension token no), the manager adopting the job's records, mirroring its state and stopping
  one download (`apps/web/src/downloads/manager.test.ts`), reading `record.json`
  (`downloads/background.test.ts`), the panels' snapshot, each list's request against the server's own query
  rules and where each heading leads (`device/widget.test.ts`, over `apps/mobile/widget-lists.json`), `purss://open`
  links (`platform/open-link.test.ts`), the stop order on disconnect (`platform/native/forget.test.ts`). Kotlin on
  the JVM (`./gradlew testFullDebugUnitTest`): the mirrored state, the plan and its unsafe entries, the
  records, stored connections and paths; the panels' requests (the same table), rows and their times, the
  catalogue leaving private sources out of setup and telling a gone or private choice, stored lists and
  choices, rows by height, and a write from before a wipe being dropped (`WidgetListsTest`).
- Android 15 emulator, for the single widget the panels replaced (debug APK, a throwaway PURSS through a throttling proxy): with *To read podcast
  episodes* on and the app closed (no activity, no WebView in the process), the job run on demand
  (`cmd jobscheduler run -n androidx.work.systemjobscheduler`) fetched the To read episode from the
  publisher into the downloads folder with `record.json`; opening the app showed it as *Downloaded
  automatically*, counted in *Downloads*, readable and playable. A run while the app was on screen did
  nothing. *Stop download* on a 4.8 MB file served at 150 kB/s closed the connection at 1.6 MB (the proxy
  saw the device hang up), left no partial file and no record. The widget on the home screen showed the
  To read list and the episode; its pause and play drove the app's Media3 session and the widget followed;
  tapping a row opened that item, also when the app's process wasn't running; dark mode follows the system.
  With the device disconnected in PURSS (Settings → Connected apps) and the app closed, the job's
  next run got 401, deleted the downloads, its state and the widget's snapshot (the widget then shows
  *Open the app to connect*), cancelled its schedule and left the flag; opening the app showed the
  *isn't connected any more* notice with the token gone from secure storage.
- Found on the device and fixed: binding to the media session from the widget's receiver context crashed
  (a receiver may not bind to services; the application context may); the settings checkboxes didn't
  redraw when only a setting changed; the widget lost the last played episode when the app was stopped
  right after a change (the page now reads the stored snapshot back from the native side).

- Android 15 emulator, the five panels (debug APK, a throwaway PURSS with five sources, one private, two
  collections and some 50 items): each kind placed from the launcher's widget list, whose previews show sample
  rows; Collection and Source opened their list (the private source not in it), showed the choice's name and
  then its rows; rows read *source, age*, as many as the panel's height holds; To read held no podcasts and none
  of the private source's To read items; To listen ran oldest first with the episode just opened above it; the
  To read heading opened the reading list limited to articles and videos, a row its item; an item marked
  Finished in the app left the To read panel within seconds; with the app's process stopped, the refresh job
  run on demand brought the New panel the items marked New meanwhile; the device's token revoked in PURSS, the
  job's next run (app closed) emptied every panel (*Open the app to connect*), and after connecting again
  Collection and Source asked for their choice anew.
- The look on the emulator: header, logo and source tiles in light, in the system's dark (followed without a redraw)
  and in the app's dark theme, and back to light when the theme returned to following the system. E-ink not seen on screen.
- Found on the emulator and fixed: a panel kept the colours of the app's dark theme after the theme went back to
  following the system (the launcher applied the new draw onto the old views); in portrait the panel took the launcher's smallest height (its landscape
  one) and drew two rows in a tall panel; the panels didn't follow the person's own changes (only the
  server's), as the app listened to the server's change signal alone and not to its lists going stale;
  after a refused token the providers scheduled the refresh again, and a new periodic job runs at once, so it
  was refused eleven times over before stopping (no refresh is scheduled now until the page has taken the
  report).

## Not built and limits

- Play/pause on the iOS widget (interactive widgets need an App Intent that runs the player in the app's
  process); tapping the episode opens it.
- iOS Collection and Source panels need iOS 17 (their configuration is an App Intent); on iOS 15 and 16 only
  the other three are offered. A new one shows *Loading…* until the app's next refresh, and it is chosen by
  editing the widget (iOS can't open a list from a tap).
- No search in the lists of collections and sources to choose from.
- The background job doesn't apply *Remove downloads when finished* or refresh downloaded items'
  text; the app does both when it next syncs.
- Android's own rules: a force-stopped app has no scheduled jobs and its widget's taps do nothing until
  the app runs again (WorkManager reschedules then); WorkManager skips a periodic run asked for before
  its hour (the panels' refresh: 15 minutes) is up. The system decides when each job runs (battery, Doze,
  standby buckets), so a panel may be older than 15 minutes.
- iOS is unverified (no Mac): the plugin, the background job (BGTaskScheduler, background URLSession,
  the Keychain read) and the WidgetKit extension were written without a compiler. To check on a Mac:
  `call.reject(_:_:_:_:)` with data and `notifyListeners`, `registerPluginInstance` in
  `capacitorDidLoad`, `URLSession.allTasks`, `withTaskCancellationHandler` with a checked continuation,
  `BGTaskScheduler.register`, `containerBackground(_:for:)`, the `NoRedirects` session delegate with the async `data(for:)`,
  and for the panels `AppIntentConfiguration` with `AppIntentTimelineProvider`, `if #available` inside the
  `WidgetBundle`, `WidgetCenter.getCurrentConfigurations` with `widgetConfigurationIntent(of:)`, the header band reaching the widget's edges (`widgetContentMargins` on iOS 17), the widgets' own asset catalog (`PanelLogo`), and App Intents
  metadata in an extension deployed at iOS 15; see [apps/mobile/README.md](../apps/mobile/README.md).
- The page's own download records live in the WebView's local storage. On the emulator, a widget snapshot
  once kept there was lost when the app was stopped seconds after writing it; the same would lose the record
  of a download finished just before (its files are then swept at the next start). Inferred, not
  reproduced for records. Background downloads don't depend on it (`record.json`).
