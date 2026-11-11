# Phone apps: downloads in the background, real cancelling, home-screen widgets

The phone apps ([plan/31](31-mobile-apps.md)) run the web app's code in a WebView. Three things need
native code that runs without that page: automatic downloads while the app is closed, stopping a
download on the wire, and home-screen widgets. This document records how they are built, the
contract between the page and the native side, and what is not built.

## Shape

```text
page (apps/web, in the WebView)                      native (apps/mobile)
  DownloadManager ── mirror(state) ───────────────►  PurssDevice plugin: background state, widget snapshot
    │  plan: POST /api/downloads/plan ◄──┐              │
    │  adopt record.json on start/sync   │              ├─ download/cancel (foreground transfers)
  DeviceRunner ── widget snapshot ───────┼───────────►  │
  OpenLinks ◄── purss://open?item=… ◄──────┼── widget tap │
                                         │              ▼
                                         └──── background job (WorkManager / BGProcessingTask)
                                                 token: secure storage (read only)
                                                 → plan → item, annotations, publisher's file
                                                 → downloads-incoming/… → downloads/<account>/<item>/ + record.json
                                                 → refreshes the widget's To read list
```

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| One download system | The rules (`packages/domain/src/downloads.ts`: what is wanted, sizes, the limit, cleanup) are shared. Which items to fetch is asked of PURSS, `POST /api/downloads/plan`, by both the open app and the background job; the server runs the same rules over the To read list (its first 200). The page adopts the job's results as its own download records | Kotlin and Swift never restate the rules; one decision for both paths |
| The plan endpoint | Body: the device's settings (`autoToRead`, `limitBytes`), `usedBytes`, and `have`: every item with a download record on the device, any state (at most 5000). Answer: the items to fetch in order, each with its expected size and the file to fetch (the publisher's https address, type, declared size, file name; PURSS keeps no media files). Nothing about the device is stored. Session or `mobile` device token; the extension's token is refused | Narrow: the existing list endpoints would need the rules on the device. A publisher's plain-http file is never planned (it would only fail) |
| Connection rule | Checked on the device before asking: Wi-Fi only by default, as in the app. Android: the job itself needs a connection, battery not low and storage not low (WorkManager constraints); Wi-Fi only is checked when it runs (Wi-Fi or Ethernet). iOS: `BGProcessingTask` with network required; the background URLSession refuses cellular when Wi-Fi only is on | The widget's refresh is a small request and may run on mobile data; files never do when the setting says Wi-Fi |
| What the job needs | The device token and the server's address: read from the same secure storage the page uses (Android Keystore entry `capacitor-storage_purss.connection`, iOS Keychain item of that account, after first unlock), never copied. The account, settings, `have` and `usedBytes`: the page mirrors them to native storage (`PurssDevice.setBackground`) whenever downloads or their settings change; a mirror whose server differs from the stored connection is ignored | One copy of the credential; the page stays the owner of download state |
| Where the files go | The job downloads into `downloads-incoming/<account>/<item>/` and, complete, moves the folder to `downloads/<account>/<item>/` (Android: the app's files folder; iOS: `Library/NoCloud`), with `item.json`, `annotations.json` (when the item has notes), the media file, and `record.json` written last. The page adopts a folder it has no record for when it starts and before each sync; damaged or unfinished folders are swept | Exactly where the download manager reads; a half-written folder is never in the downloads folder |
| `record.json` | `{itemId, title, sourceTitle, kind, state: "done"\|"failed", status, media: {file, bytes, type, kind}, textBytes, savedAt}`; `status` is the failure's HTTP status, 0 for a lost connection, -2 for too large; the page words it (`failureText`). A media `file` must lie in the item's own folder | No user-facing text in native code; a record can't point at another file |
| Limit and cleanup | The job never fetches more than the room left under the limit (it stops the transfer when the declared or received size passes it, as the page does) nor 4 GB. Adopted downloads count toward the device's total; *Remove downloads when finished* and removal of deleted items run when the app next syncs | The page's cleanup is the one place that removes downloads |
| App open | Android: the job does nothing while the app is in the foreground and stops its transfer (the partial folder is discarded) when the app comes to the front; the open app's own sync does the work. iOS runs `BGProcessingTask` only in the background | Two downloaders never write the same item |
| Schedule | Android: unique periodic work every hour (WorkManager's own back-off); scheduled while connected, replaced when Wi-Fi only changes, cancelled on disconnect. iOS: a processing request (earliest one hour later) submitted when the app goes to the background and after each run; the system chooses when | Within each system's budget; nothing runs when nothing is connected |
| Revoked token | A 401 from PURSS: the job deletes `downloads/` and `downloads-incoming/`, the mirrored state, the widget's snapshot and the notification code's fetch credential (plan/37), cancels its schedule, and leaves a flag; the page, on its next start, sees the flag and runs the app's own *lost* path (token, offline copies, downloads, the phone's notification registration with the relay; unsent highlights and notes stay, plan/31) | The native side holds nothing of an account PURSS refused |
| Disconnect | The page's wipe (which also unregisters the phone's notifications, plan/37) calls `PurssDevice.reset()` before removing the downloads and again after; a transfer that finishes meanwhile moves its folder in only while the mirrored state still names the account (checked under the same lock the wipe holds): cancels the schedule and any background transfer, deletes `downloads-incoming/`, the mirror and the widget snapshot, and redraws the widget as *not connected* | Wiped with everything else |
| Cancelling | A small plugin of the app's own, `PurssDevice` (Android `app.purss.device`, iOS `App/PurssDevice`), does every download: `download({id, url, path, maxBytes})` writes `<path>.part` and renames when complete, `cancel({id})` closes the connection and deletes the partial file, `progress` events. Too large stops at once (`too_large`). The page's start-up sweep stays for files a stopped app left | The transfer stops on the wire; nothing runs on after *Remove all downloads* |
| Widgets | Android `AppWidgetProvider`; iOS WidgetKit extension. Content: the next To read items (title, source; the To read page's order), the current or last played episode with play/pause on Android, *Open the app* when there's nothing to show. Light and dark follow the system unless the app's theme says otherwise; e-ink shows black on white | Plain, readable, the app's look |
| Widget data | A snapshot, `{appearance, toRead: [{id, title, sourceTitle}], toReadTotal, episode: {id, title, sourceTitle, playing, loaded, positionSeconds, durationSeconds} \| null, updatedAt}`, written by the page when its lists or the player change (`apps/web/src/device/widget.ts`), its To read part refreshed by the background job with the same request (`GET /api/items?scope=toread&filter=active&sort=newest&limit=5&exceptPrivate=1`). Items of private sources are never in it, as their titles are never in notifications: a widget shows on the home screen and, on iOS, the lock screen (and private sources have no episodes to play). Android keeps it in the app's private preferences; iOS in the app group's container (`widget.json`), the only thing the widget extension reads. It never holds the token or any address of the PURSS | A widget is drawn by another process; it gets titles, not credentials |
| Taps | `purss://open?item=<id>`: the app navigates to the item over Home and does nothing else; anything else after `purss://open` is ignored. One reader and one handler for these and tapped notifications (`platform/open-link.ts`, `shell/OpenLinks.tsx`). The episode's play/pause on Android goes to the app's running Media3 session; when the app isn't running it opens the episode instead | A deep link that only navigates can't be abused to act on someone's behalf |

## Verified

- Unit tests: the shared rules and the plan request (`packages/domain/src/downloads.test.ts`), the plan
  endpoint over HTTP and its reach (`apps/api/src/routes/downloads.test.ts`: session yes, `mobile` token
  yes, extension token no), the manager adopting the job's records, mirroring its state and stopping
  one download (`apps/web/src/downloads/manager.test.ts`), reading `record.json`
  (`downloads/background.test.ts`), the widget's snapshot and `purss://open` links
  (`device/widget.test.ts`, `platform/open-link.test.ts`), the stop order on disconnect (`platform/native/forget.test.ts`). Kotlin on
  the JVM (`./gradlew testFullDebugUnitTest`): the mirrored state, the plan and its unsafe entries, the
  records, the widget's To read refresh, stored connections and paths.
- Android 15 emulator (debug APK, a throwaway PURSS through a throttling proxy): with *To read podcast
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

## Not built and limits

- Play/pause on the iOS widget (interactive widgets need an App Intent that runs the player in the app's
  process); tapping the episode opens it.
- The background job doesn't apply *Remove downloads when finished* or refresh downloaded items'
  text; the app does both when it next syncs.
- Android's own rules: a force-stopped app has no scheduled jobs and its widget's taps do nothing until
  the app runs again (WorkManager reschedules then); WorkManager skips a periodic run asked for before
  its hour is up. The system decides when the job runs (battery, Doze, standby buckets).
- iOS is unverified (no Mac): the plugin, the background job (BGTaskScheduler, background URLSession,
  the Keychain read) and the WidgetKit extension were written without a compiler. To check on a Mac:
  `call.reject(_:_:_:_:)` with data and `notifyListeners`, `registerPluginInstance` in
  `capacitorDidLoad`, `URLSession.allTasks`, `withTaskCancellationHandler` with a checked continuation,
  `BGTaskScheduler.register`, `containerBackground(_:for:)`, the `NoRedirects` session delegate with the async `data(for:)`; see [apps/mobile/README.md](../apps/mobile/README.md).
- The page's own download records live in the WebView's local storage. On the emulator, a widget snapshot
  kept there was lost when the app was stopped seconds after writing it; the same would lose the record
  of a download finished just before (its files are then swept at the next start). Inferred, not
  reproduced for records. Background downloads don't depend on it (`record.json`).
