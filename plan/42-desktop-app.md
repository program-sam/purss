# Desktop app

The owner wants a desktop app for Windows, macOS and Linux, with the phone app's model: the same
interface, connected to a PURSS with a device token, its interface updated live from that PURSS,
and the app itself updated automatically from GitHub. The owner chose Tauri 2 for a small app and asked for
four things beyond the browser: the phone's capabilities (offline from a cold start, downloads, system
notifications, both kinds of update), running in the background (tray, start at login, unread badge),
downloads as real files in a folder you choose, and `feed:`/`podcast:` links and `.opml` files opening the
app. Releases are built by GitHub Actions monthly and on demand, unsigned for now. This document records
how it is built and what it does not do.

## Shape

```text
apps/web (one build)
 ├─ browser: platform/web.ts
 ├─ apps/mobile (Capacitor): platform/native/
 └─ apps/desktop (Tauri 2): platform/desktop/ ── invoke() ──► src-tauri (Rust)
        reuses from platform/native/: connect.ts (PKCE, callback, Connection), transport.ts,
        live-update.ts (Updater is already an interface), forget.ts, and ConnectScreen.tsx, whose
        shell-dependent parts (storage, the system browser, the callback, the device's name, passkeys)
        become a small `ConnectShell` each shell passes in
        reuses from the web app: OfflineWorker in the page (IndexedDB copies), DownloadManager,
        the media-element player, BrowserNotifier (alerts) through platform.notifier
```

`platform/index.ts` loads `platform/desktop/` when `window.__TAURI_INTERNALS__` exists, the way it loads
`native/` for Capacitor. Nothing outside `platform/` asks which shell it runs in; new capabilities are
nullable `Platform` members, as before.

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Framework | Tauri 2 (Rust shell, system WebView: WebView2, WKWebView, WebKitGTK 4.1) in npm workspace `apps/desktop`, Rust in `apps/desktop/src-tauri` | Owner's choice: small download, low memory |
| Interface | The web app built for the root (`PURSS_WEB_BASE=/`), embedded in the binary as the built-in interface | One interface, as for the phones |
| Page origin and serving | The page is served by Tauri's own protocol (`tauri://localhost`; Windows `http://tauri.localhost`) from a custom `Assets` provider (`Context::set_assets`) that reads the active downloaded interface from disk and falls back to the embedded one | The origin never changes when the interface does, so IndexedDB copies, local storage and the outbox survive updates; Tauri's own IPC trust and secure context apply unchanged |
| Connecting | Kind `mobile` (the whole user API, the phone's: some people use only an app), redirect `purss://connect` registered by the desktop app (`tauri-plugin-deep-link`), the same `/api/connect/*` flows and ConnectScreen; the device name says which computer (`<host name> (Linux)`, …). Settings → Connected apps calls the kind *App on a phone, tablet or computer* | No new client kind, server flow or data encoding; the token rules of plan/24 apply as they are |
| CORS | `isClientOrigin` adds `tauri://localhost` and `http://tauri.localhost`; the gate also answers the interface zip (`GET /api/app/bundle/<file>`) as open, with CORS | The desktop page calls the PURSS cross-origin with its token, as the phone's does, and fetches the interface itself |
| Older servers | A PURSS from before this change refuses the desktop's origin, so the desktop connects only to an updated one: to the app such a PURSS looks unreachable (a refused CORS answer can't be told from no answer), and the connect screen says it couldn't reach it. An offer without `desktop` means the built-in interface | The phones are unaffected |
| Token storage | The OS credential store through the `keyring` crate (macOS Keychain, Windows Credential Manager, Secret Service on Linux). Where Linux has no Secret Service, a file readable only by the user in the app's config folder, and Settings → This device says so. Every call to the store has 30 seconds, then counts as no store. A marker suppresses whatever the store may still hold when a disconnection can't confirm removing it (locked, not answering) or when the newest connection had to go to the file: such an entry is never used again, its removal is tried at every start, and storing a new connection in the store ends it | Never in local storage; a Linux desktop without a keyring still works, as other desktop apps do; a wallet waiting to be created or unlocked never hangs signing in 
| Trust | As for the phones (plan/39), an interface from a server the person allowed runs as the app's own code. On the desktop that code also reaches the app's commands, so they are narrow: no generic file system, shell or HTTP access; the downloads folder is chosen in a dialog Rust opens and kept by Rust, every path is resolved and checked to stay inside it (no `..`, no symlinks or junctions followed out); start at login, notifications, the badge and opening https addresses in the browser are the only other powers | A downloaded interface can do no more than the built-in one |
| Page policy | `PAGE_POLICY` and `workspacePolicy` allow Tauri's IPC (`ipc: http://ipc.localhost`) in `connect-src`; on the desktop the connected policy also allows the loopback server's exact origin (`http://127.0.0.1:<port>`) in `media-src` (`PAGE_POLICY` already allows `http:`) | Every policy a page carries must allow a request, so each one names what the desktop needs |
| Interface updates | `live-update.ts` unchanged in its rules (question for other servers, rollback, switch only at start or after an hour away with nothing playing), with a desktop `Updater`: the page fetches the zip from PURSS and checks its SHA-256, Rust unpacks it into `interfaces/<version>/` (paths checked, size capped) and switches the `Assets` provider. Rollback: a switched-to interface must call `interface_ready` within 15 s of loading, else Rust goes back to the previous one, records the version as failed and reloads. Before serving a downloaded interface Rust checks its `app-build.json` desktop level against its own, and an app update (a different app version) removes downloaded interfaces, as `resetWhenUpdate` does on the phones | Same behaviour as the phones; the Rust side never fetches anything for it |
| Native level | `apps/desktop/native-level.json` (level and fingerprint of `src-tauri/` and the desktop plugins, test like the mobile one). The web build writes both levels to `app-build.json`; the offer carries `desktop` next to `native`. The desktop compares `desktop` with its own; phones ignore the new field | One build of the interface serves both shells; installed phones parse the offer unchanged |
| App updates | `tauri-plugin-updater` against `releases/latest/download/latest.json` in this repo, signed with the project's updater key (minisign; private key a GitHub secret, public key in `tauri.conf.json`; publishing fails without the key, only the build check runs without it). Checked at start and every six hours; downloaded in the background and kept in the app's cache folder (`update/<version>.bin`). A downloaded version is announced with a notification and *Restart to update to …* at the top of the tray's menu, and shown in Settings → This device. It is installed when the person chooses *Restart to update* or quits from the tray; ending the session or shutting down kills the app without installing, so a version still waiting at the next start is installed then (the updater checks its signature again) and the app restarts into it with the same arguments (started at sign-in stays in the tray). Up to date, the folder is emptied | The app always updates itself, also for people who never quit it; signature checked by the updater, whatever the OS signing |
| Notifications | No relay. The page keeps running while the window is hidden, so the web's *alerts* (`BrowserNotifier`, the bell's rules: quiet hours, previews) work through `platform.notifier`: the web's is the `Notification` API, the desktop's sends system notifications through Rust (`notify-rust` on Linux, `tauri-plugin-notification` on Windows and macOS); on Linux a click shows the window and opens the item, on Windows and macOS it brings the app to the front. Settings → Notifications words *Also as notifications on this computer* | The persistent connection replaces the push relay; self-hosters set up nothing |
| Background | Closing the window hides it; the tray icon (*Open*, *Quit*) and a second launch (`tauri-plugin-single-instance`) bring it back. *Start when you sign in* (off by default, starts hidden): on Linux a `.desktop` file in `~/.config/autostart` written by the app, naming the AppImage when the app runs from one (`APPIMAGE`, trusted only when the app itself runs inside that AppImage's mount), elsewhere `tauri-plugin-autostart`. Unread bell count on the dock/launcher badge (macOS, Linux launchers that support it) and the tray tooltip | The page keeps the event stream, downloads and alerts going |
| Downloads | `DownloadManager` with desktop `DeviceFiles`: Rust streams the publisher's https file (https redirects only, 4 GB cap, `maxBytes`, `.part` then rename, cancel on the wire, progress events, a User-Agent naming the app: some publishers refuse requests without one). The folder is `PURSS` inside a folder the person chooses in a system dialog (default: the system Downloads folder); Rust creates it with a marker file and refuses an existing one without the marker. Rust lists and removes only entries of the app's own layout (`<account id>/<item id>/`), so anything else a person puts there is never deleted; removing everything removes only those. Settings → This device says downloads are removed when the app is disconnected. Changing the folder stops downloads and waits for every command using the folder (a move never runs beside a write, a removal or a transfer), copies them to the new folder, keeps the new choice on disk, and only then deletes the old copies; a current folder that isn't the app's is left untouched. Staging files (`.part`, writes) are created fresh, never through a link, and copies check their destination the same way. Played from a server on `127.0.0.1` (random port, a random secret in every address) that serves only those files, with range requests. *Show in folder* | Real files that never take a person's own with them. WebKitGTK doesn't play media from custom protocols (checked: `tauri://` and a custom scheme fail with error 4, http and blob play), so the player gets a loopback address |
| Files | Exports: a save dialog (`tauri-plugin-dialog`), written by Rust | As on the web, a file the person keeps |
| Links in | `feed:`, `podcast:` and `pcast:` links open *Add source* with the address filled in (nothing looked up until Find): `feed:http://…` and `feed:https://…` are unwrapped as they are, the shorthand `feed://host/…` (and `podcast://`, `pcast://`) becomes `https://host/…`, and Add source validates it as for a pasted address; `.opml` files (file association; the deb and rpm desktop entry passes them and links with `%U`, as paths or `file://` addresses; at most 5 MB) open the OPML import (`/api/opml/preview`, then the existing dialog). `purss://open` as on the phones | The desktop is where feed links are clicked |
| Links out | Other sites open in the default browser (`tauri-plugin-opener`), never in the app's window | As in the phone app |
| Passkeys | None in the app (the page's origin is not the PURSS's). Email address and password in the app, or *Connect in the browser* (the browser's passkeys on the PURSS's /connect page), or *Continue with Google* (an external sign-in, always in the system browser: Google refuses an embedded web view) | WebKitGTK has no WebAuthn; a passkey is bound to the PURSS's domain |
| Player | The web's media-element backend; the system media controls are the WebView's | No native audio needed: the page stays alive when hidden |
| Releases | `.github/workflows/desktop.yml`: monthly (1st, 06:00 UTC) and on demand builds Linux (AppImage, deb, rpm; the updater, pinned at 2.14, updates each in place: AppImage by replacing the file, deb and rpm through the system's installer), Windows (NSIS) and macOS (universal DMG, ad-hoc signed) and publishes a GitHub release `desktop-<dotted version>` with fixed file names (`PURSS-linux-x86_64.AppImage`, …) plus `latest.json`. A push to main that touches the desktop builds the three without publishing. Publishing needs the updater key; without it only the build check runs | Monthly is the owner's choice; the interface reaches the app sooner through PURSS |
| Version | The product's (plan/40), dotted (`26.312.14`) for Tauri; Windows uses NSIS only (MSI limits minor to 255) | One number |
| Site | One download section: a static list of every file; a few lines of script make the visitor's OS (from `navigator.userAgent`) the primary button. Without the script all links still show. The files and their fixed names are `DESKTOP_PACKAGES` in `distribution.ts`, shared by the site, Settings → Connected apps and the release script; the README links to the latest release | Simple and robust in any browser |

## Verified

- Unit tests: the offer's desktop level (`routes/app-bundle.test.ts`), the CORS origins (`connect/connect.test.ts`),
  the page policy (`platform/csp.test.ts`), feed links (`platform/desktop/feed-link.test.ts`), the release manifest
  (`apps/desktop/src/release.test.ts`), the main download button (`apps/site/src/desktop.test.ts`), the desktop level's
  fingerprint (`apps/desktop/src/native-level.test.ts`); in Rust (`cargo test`): the download layout and paths,
  a person's files left alone, links refused, moving the folder, ranges, installing, switching and rolling back
  interfaces, other levels and escaping zips refused, an app update removing downloaded interfaces, links and OPML
  files taken in.
- On Linux (Fedora 44, KDE, WebKitGTK 2.52), a debug build driven through WebDriver (`tauri-driver`) in a headless
  KWin and a private D-Bus session, against `apps/mobile/scripts/emulator-workspace.ts`: the first screen; connecting;
  Home; Settings → This device (start at sign-in, the downloads folder, the keyring note); the
  connection in the 0600 file when there is no Secret Service, and, in an earlier run on the owner's session, in the
  Secret Service; a publisher's file over https downloaded into `PURSS/<account>/<item>/` and played from
  the loopback server inside the connected page's policy, seeking included, and refused with a wrong secret; a system
  notification with its action, and its click reaching the page; a second start with `feed://…` opening Add source
  filled in and with an `.opml` file opening the choice of its feeds, one app running; PURSS forgetting the app
  (restarted empty): downloads and connection removed with the notice; the update question for another server,
  *Allow updates*, the build downloaded and unpacked, and the next start running it; a build that never starts rolled
  back after 16 s, recorded as failed and deleted; start at sign-in written and removed; the window closed by the
  window manager (KWin asked to close it) hiding the app with its page running, and a second start showing it again; *Disconnect this app* removing downloads, connection and interface and
  leaving a person's file in the folder.
- On realistic data (a copy of the local 24,000-item database served by this branch's API): connecting, Home with its
  collections, and an article in the reader.

## Found on the device and fixed

- Signing in hung when the keyring call started a wallet that waited for a prompt: every call now has 30 seconds.
- A publisher (Wikimedia) refused downloads without a User-Agent (403).
- Start at sign-in named another program: `APPIMAGE` was inherited from the AppImage that started the app; the app
  now drops inherited AppImage variables at start, so the updater and restarts can't take that program for itself.
- The packaged desktop entry started the app without the clicked link or file (no `%U`).
- Self-update on Linux (2026-11-13), with an AppImage of this code labelled 26.315.20 and the published release
  26.315.32: started hidden, the app downloaded the release (the kept file the same size as the release's AppImage),
  sent the notification (*A new version of PURSS is ready*, read on D-Bus) and put *Restart to update to 26.315.32* first
  in the tray's menu (read over D-Bus). Ending it with SIGTERM, as ending the session does, left the AppImage
  unchanged: that is why a waiting version is now installed at the next start. The next start replaced the AppImage with
  the release's, byte for byte, within five seconds, and the app came back in the tray. Choosing the tray item did the
  same. Found and fixed on the way: a restarted AppImage inherited the old one's mount in `PATH` and
  `LD_LIBRARY_PATH`, its handle on the mount and the pipe its runtime waits on, so the old runtime kept running
  beside the new version; the app now leaves those behind before it restarts, and only the new instance remains.

## Not verified

- WebKitGTK sometimes doesn't finish a second seek in the same Ogg file loaded again (its duration estimate differs
  between loads); the first load seeks, and the server's range answers are correct.

- Windows and macOS: built by the workflow only; never run. Their notifications, badge, tray, autostart,
  credential stores, link handling, file association and updates are unchecked.
- Self-update on Windows and macOS, and of the deb and rpm packages (their installer asks for a password, at the
  next start too when a version was waiting).
- Playing in the background with the window closed for a long time (WebView2 and WKWebView may slow hidden pages).

## Not built

- OS code signing and notarization (owner to-do): Windows SmartScreen and macOS Gatekeeper warn on first open.
- Arm Linux and Windows builds; Microsoft Store, Mac App Store, Flathub.
- Share targets, widgets, push through the relay, native passkeys.
- Notification clicks opening the item on Windows and macOS (they bring the app to the front).
