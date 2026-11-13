# Live updates of the phone apps' interface

The owner wants small changes to the interface to reach the Android and iOS apps without a store
release. A store release is needed only for native work: plugins, permissions, the Android and iOS
projects. The apps load the interface from the server they are connected to, so it matches the
PURSS that server runs. The official server is updated with every deploy. A self-hosted server is
updated when its owner upgrades it, and its apps follow. This document records how it works and why.
The apps themselves are described in [plan/31](31-mobile-apps.md). The desktop app takes the same builds by the same
rules at its own native level (the offer's `desktop` field), with its own updater ([plan/42](42-desktop-app.md)).

## Shape

```text
server image (infra/Containerfile)
  ├─ apps/web/dist         the browser's build, under /app/
  └─ apps/web/app-bundle   the same interface built for the apps' root (PURSS_WEB_BASE=/), zipped
                           with manifest.json (apps/mobile/scripts/app-bundle.ts)
        GET /api/app/bundle          what is on offer: version, native level, path, SHA-256, size
        GET /api/app/bundle/<file>   the zip (only the file on offer)

app (apps/web/src/platform/native/live-update.ts, @capgo/capacitor-updater 8.54.2)
  check: at start, then when shown again (at most every 30 minutes)
  → download the offer → switch to it at the next start, or when shown after an hour away
```

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Where updates come from | The connected PURSS, from the build of the interface it runs. Every server image packs one, so self-hosted servers offer theirs with no setup | The interface always matches the API it talks to. Updating the server updates its apps |
| Who may push code | Any server. Bundles are not signed. The official server's updates need no question. Any other server is asked about once, the first time it offers an update (*Let this server update the app?*), after the first-visit question. Closing the question counts as *Don't allow*. The answer is kept per server and can be changed in *Settings → This device → Updates of the app* | The owner's decision (2026-11-08): a signing key made self-hosting a chore. People are responsible for the servers they connect to, and the question makes that explicit for servers other than the official one |
| What the question can't protect against | Once a server's interface has been installed, it is code running in the app. If it is malicious, it can stay installed after the person disconnects or switches servers, read what is typed into the next sign-in, and ask for the phone's passkeys for servers that vouch for the app (the official one included); the system's passkey prompt names the site. It can't reach other servers' data by itself: the app holds one connection at a time and the page's CORS rules still apply. Reinstalling the app, or clearing its data, removes it | Recorded so the risk stays visible. The rejected alternative was a project signing key (only bundles signed in CI installed) |
| Plain http | Allowed (`httpsOnly: false`), the same as the connection itself: https, except on this device and the local network (plan/31) | A home server on plain http gets its updates too; anyone on that network could also swap the download, as they could read the token |
| Fitting the native code | Each build records the native level (`apps/mobile/native-level.json`). The app installs a build only if its native level equals the app's own, which it reads from its installed version (`native.built.0`, the plugin's `version`, written by the web build to `app-build.json` and set at `npm run sync`). Otherwise it runs the interface it was installed with | An interface that calls native code the app lacks would break. The installed interface still works with older and newer servers, as before |
| Remembering to raise the level | `native-level.json` also records a fingerprint of the native side (tracked files under `android/` and `ios/`, the plugins in `apps/mobile/package.json`, `capacitor.config.ts`). A test fails when it changes, naming the new fingerprint. Whoever changes native code then decides whether the interface depends on the change (raise the level) or not (update only the fingerprint) | Without the test, a missed bump would only show up on phones |
| When an update takes over | The app downloads the build and remembers it. It switches when the app starts, before anything is shown, or when the app is shown again after at least an hour away with nothing playing. It never switches while in the background | Switching reloads the page: it would stop the player (the native player doesn't outlive a reload, plan/31) and lose a half-written note. The plugin's own *next bundle* is installed when the app goes to the background, so the app doesn't use it |
| An update that doesn't start | The interface reports that it started (`notifyAppReady`) before anything else. If it doesn't within 15 seconds, the plugin goes back to the previous one. The app remembers that version and never installs it again | No loop of failing downloads |
| No update, or *Don't allow* | The app goes back to the interface it was installed with, at the next switch. Older downloads are removed | The phone keeps one interface besides the installed one |
| Disconnecting | Back to the installed interface straight away, before the first screen | The next server decides on its own interface |
| A store update of the app | Downloaded interfaces are removed (`resetWhenUpdate`); the new installed interface runs until the server's build fits it | The installed one is the newest the app knows works with its native code |
| Capgo's service | Not used: no update checks, statistics or channels go anywhere (`updateUrl`, `statsUrl` and `channelUrl` empty, `autoUpdate` off). The plugin's code was checked: with `statsUrl` empty it sends nothing | Privacy; the app talks only to the connected PURSS and the push relay |
| Plugin | `@capgo/capacitor-updater` 8.54.2 (MPL-2.0), in manual mode | Maintained for Capacitor 8 on Android and iOS, with checksum checks, rollback and resumable downloads. A plugin of our own would mean more native code to maintain and test on two platforms |

## New versions of the app itself

The screens follow the server; the app around them (its native code) comes from where it was installed. When the
native level goes up, only a new version of the app brings the server's newest screens.

| Concern | Decision | Reason |
| --- | --- | --- |
| Where it was installed from | `PurssDevice.installSource()` gives the build's flavor and the installing package (`app-updates.ts`, `sourceOf`). The FOSS build: F-Droid. Installed by Google Play (`com.android.vending`): Google Play. Any other full build (a browser, the package installer, adb, an APK updater): the GitHub releases. iOS: the App Store. An app built before the method existed can't tell, and is never told to download anything | Each source updates differently, and the GitHub APK can't replace an F-Droid build (another signing key) |
| The APK from the releases | Once a day (at start and when shown again) the app reads the newest release's `latest.json` through Capacitor's native HTTP (the page's own policy allows only the connected PURSS and the push relay); its `version` is the APK's, published with it. When it is newer than the installed version, a message says so once per version (*Version 2631532 of the app is out*, **Download**), and *Settings → This device → New version of the app* keeps it, with **Download version …**. Download opens `PURSS-android.apk` in the in-app browser and Android's installer installs it over the app, keeping its data. The last answer is kept, so an offline start still knows | Nothing else updates a downloaded APK. Installing it itself would need the *install unknown apps* permission, which the owner didn't ask for |
| Screens made for a newer app | `needsNewerApp` (live-update.ts): the server offers a build above the app's native level, and the person hasn't refused this server's updates. For a store, F-Droid or unknown source a message says so once per installed version (*… Update it in Google Play.*, with a button when the store listing is known), and Settings keeps it. For the GitHub APK, the newer-version message covers it; while no newer release is out, Settings says it isn't out yet | The person learns why the app's screens stay older than the server's |
| Stores | Google Play, F-Droid and the App Store update the app themselves; the app never asks them | Their own updates are the reliable path |

## App stores

Google Play allows apps to download JavaScript that runs in a WebView. Apple's guidelines (2.5.2,
and 3.3.1 of the developer agreement) allow interpreted code that doesn't change the app's main
purpose; plan/31's earlier reading of rule 2.5.2 is replaced by this. Whether App Review accepts
the iOS app with live updates is unverified until a store submission.

## Verified

- Unit tests: `platform/native/live-update.test.ts` (what to install, the question, refusing,
  rollback, switching only when nothing plays), `apps/mobile/src/bundle.test.ts` (the zip, read back
  from its central directory), `native-level.test.ts`, `routes/app-bundle.test.ts` (the offer, CORS
  for the apps, only the zip on offer served, a broken manifest offers nothing).

- On an Android 15 tablet (debug build) against `apps/mobile/scripts/emulator-workspace.ts`
  with `PURSS_APP_BUNDLE_DIR` set to a packed build that differed by one label: the question appeared after the
  first-visit question; *Allow updates* downloaded the build; going to the background and back didn't switch;
  the next start switched before anything showed, and *Settings → This device* showed the changed label;
  *Disconnect this app* went back to the installed interface with its notice, and the next start removed the
  download; connecting again downloaded without a second question; a build whose page loads no script was
  rolled back by the plugin after 15 seconds, deleted, and not downloaded again on the next two starts. The
  device log showed no request to Capgo.
- Found on the device and fixed: the plugin's *next bundle* is installed when the app goes to the background
  (after a "kill" delay is met at launch), which would stop the player; the app now keeps its own queue.

- New versions of the app (2026-11-13), Android 15 emulator, a full debug build labelled 2631524 and connected to the
  emulator PURSS: installed with adb (no installer), the app read the real newest release (2631532) and showed
  *Version 2631532 of the app is out* with **Download**, and *Settings → This device → New version of the app*.
  **Download** opened `PURSS-android.apk` in the in-app browser; after Chrome's warning for APKs and Android's
  one-time *install unknown apps* permission, the system installer asked *Do you want to update this app?* (it then
  refused the release APK over a debug build: another signing key). The release APK 2631532 installed over the
  release 2631524 as an update (first install time kept). Reinstalled as if from Google Play (`-i com.android.vending`)
  with the PURSS offering screens for native level 3: *This server's newest screens need a newer version of the app.
  Update it in Google Play.* (no button: no listing yet), Settings said the same, and the message didn't come back
  after a restart.

## Not verified

- Switching when the app is shown after an hour away, and *Don't allow*: unit-tested only.
- New versions of the app from F-Droid and on iOS: unit-tested only.
- iOS: not built (no Mac), as for the rest of the app.
