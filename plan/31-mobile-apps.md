# Android and iOS apps

The owner chose Capacitor for phone apps that reuse the web app: one interface for the web, Android
and iOS, so a change to `apps/web` ships everywhere. This document records how the apps are built,
what differs from the browser and why, and what is not built. The connection protocol and device
tokens are in [plan/24](24-connected-apps.md); the player interface and what the server does with
media (stores none) in [plan/25](25-media-playback.md).

## Shape

```text
apps/web (one build: apps/web/dist)
  ├─ in a browser: served by PURSS; cookies, CSRF, service worker
  └─ in apps/mobile (Capacitor 8): bundled into the app; the connected server may offer a
     newer build of the same interface (live updates, plan/39)
        └─ src/platform/native: device token, offline copies in the page, native audio,
           downloads, share intake, purss:// links
```

Screens never ask which platform they run on. `apps/web/src/platform/` holds the parts that
differ (`Platform` in `types.ts`); `platform/index.ts` picks the web implementation, or loads the
native one when the Capacitor bridge is present. The web implementation is the code that was
there before, moved behind the interface unchanged. Three capabilities decide whether a control
exists at all: `downloads` (device copies), `connection` (the app's connected PURSS), and
`fileExports` (whether exports can be saved from the page).

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Framework | Capacitor 8.6 (current stable major on 2026-11-05; 9 is in beta), npm workspace `apps/mobile`, `webDir` = `apps/web/dist` | One interface; the store build carries it, and the connected server can update it ([plan/39](39-live-updates.md)) |
| App identity | `app.purss`, name "PURSS", group `group.app.purss` | Plain placeholders; **the owner can change them** until the first store release (`capacitor.config.ts`, the Android namespace and package folder, the iOS bundle ids, entitlements and share extension) |
| API transport | Web: same-origin fetch with the cookie and CSRF header, EventSource. Apps: every request to the connected origin with `Authorization: Bearer purss_dev_…`, `credentials: "omit"`; the change token and the copy-control header are dropped (CORS allows only `authorization`, `content-type`, `x-purss-csrf`). Live updates read `/api/events` with fetch and parse the stream (`platform/sse.ts`), reconnecting with backoff | EventSource can't send a header, and a token never goes in an address |
| Page policy | The built `index.html` carries a Content-Security-Policy (`platform/csp.ts`; scripts only from the bundle, nothing embedded) that allows at least what the server's header allows, so the browser is unaffected. The apps' PURSS is chosen at run time, so that policy allows any http(s) PURSS; once connected, a second policy for that origin is added to the page before any request (connect, images, media: the PURSS and https publishers), and the transport refuses absolute addresses on any other origin, so the device token only goes to the PURSS | The apps have no server header; the token is a bearer credential |
| Token storage | `@aparajita/capacitor-secure-storage` 8.0.1: iOS Keychain `afterFirstUnlockThisDeviceOnly`, Android Keystore-encrypted | The token is a long-lived credential; never in local storage. After first unlock so playback with the screen locked can still save its position |
| Server | The app opens straight on the official server's sign-in (`OFFICIAL_WORKSPACE_ORIGIN` in `packages/domain/src/distribution.ts`, the one value to change when it moves); the server isn't asked for. If it can't be reached, the screen says so with **Try again**. A small **Use another server** under the sign-in reveals the address field (and *Use the official server* goes back). The server last connected to is remembered on the device, also after disconnecting, and is where the screen starts next time. With the constant empty, only the address field is shown. *Settings → This device* names the connected server (and says when it is the official one) next to **Disconnect this app**; changing server means disconnecting and connecting again. The web sign-in page needs no choice: each server serves its own | Most people use the official server and never type an address; self-hosters choose theirs once |
| Connecting | Server → `GET /api/connect/info` (must be a PURSS offering S256 and `purss://connect`) → PKCE S256 + state → `/connect` in the system browser (`@capacitor/browser`: Custom Tabs, SFSafariViewController) → `purss://connect` → `POST /api/connect/token`. The waiting request survives the app being stopped (ten minutes). The callback must match state and carry the PURSS's `iss` (required, as for the extension) | The browser holds the person's sign-in (passkeys, password, OIDC) on the server's own origin; the app never sees it |
| Signing in and creating an account | When `/api/connect/info` offers `signin` and `signup` (`platform/native/ConnectScreen.tsx`): email address and password, or the phone's passkey where the PURSS vouches for the app (`signin.methods` has `passkey`: `POST /api/connect/passkey/options`, then the plugin, then `POST /api/connect/signin`) → device token; *Forgot your password?* → `POST /api/password-reset`, then the link from the email is pasted into the app with the new password → `POST /api/password-reset/confirm`; *Create an account*: invitation code (or its pasted link), the invited email address, name, password → `POST /api/connect/signup` → connected straight away; where open sign-up is on (`signup.start`), the email address → `POST /api/signup/start`, and the emailed link finishes the account in the browser, after which the app signs in. An external sign-in (*Continue with Google*, from `signin.providers`) opens the provider's sign-in in a sign-in tab over the app (providers don't allow their sign-in inside an app's web view) that ends on the approval page, then the flow above; where open sign-up is on, that sign-in also makes the account. An older PURSS without `signin` goes straight to the browser flow. *Confirm it's you* with the provider and *Link Google* in Settings use a single-use ticket and the same tab ([plan/24](24-connected-apps.md)) | No detour through the browser |
| Passkeys | `platform.passkeys`: the browser's WebAuthn on the web; in the apps `@capgo/capacitor-passkey` 8.5.8 (Credential Manager, AuthenticationServices) when the connection was made with a PURSS that vouches for the app (`Connection.passkeys`). PURSS serves `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` from `PURSS_APP_ANDROID_CERT_SHA256` / `PURSS_APP_IOS_APP_ID` and accepts the Android app's `android:apk-key-hash:` origin. iOS needs the domain in the build (`PURSS_APP_PASSKEY_DOMAINS`) | The same passkeys work in the app and the browser |
| Links from emails | Pasted into the app: reset (sign-in screen), confirming the address (Settings → Security), invitations (the sign-up form) (`lib/email-links.ts`) | Works with any PURSS, without app links on its domain |
| Addresses | One rule with the browser extension (`parseWorkspaceAddress`, `packages/domain/src/workspace-address.ts`): HTTPS, except this device and the local network (private, CGNAT and link-local ranges, IPv6 unique-local and link-local, `.local`/`.lan`/`.internal`/`.home.arpa`), where plain HTTP is allowed with a visible *not encrypted* note on the connect screen and in Settings → This device. Android's network rules can't list address ranges, so they permit clear text and the app enforces the rule (transport to the PURSS only, page policy, https-only publisher files in downloads and the player); iOS uses `NSAllowsLocalNetworking` plus exceptions for `.lan`, `.internal` and `.home.arpa` | A bearer token over plain HTTP is readable by anyone on the network; on a home network the default built here (pending the owner's decision) accepts that with a warning |
| Disconnecting | Settings → This device → **Disconnect this app**: `DELETE /api/connect/device` (8 s), then the token, offline copies, the annotation outbox (after a warning when anything is unsent), downloads and UI hints are removed and the app returns to its first screen. A 401 `device_signed_out` (from any request or the event stream) does the same with a notice, except that unsent highlights and notes stay, per account, and are sent when that account connects again (`platform/native/forget.ts`). If the server can't be reached, the device is still wiped and the person is told to remove it in Settings → Connected apps. If secure storage refuses to remove the token, the next start doesn't use it (no refuse-and-restart loop) and the notice says so | A revoked or lost device keeps nothing of the account but the person's own unsent writing |
| Browser parts | None: Settings has everything the browser's has (General, Notifications, This device, Security, Connected apps, Assistants, Account), and Your data and administration are pages in the app. *Confirm it's you* asks for the password in the app (or a passkey where the app has them). Files (exports) go to the share sheet (`@capacitor/share`, `platform.saveFile`). Links to other sites open in the in-app browser tab | The owner wants the app to stand on its own |
| Offline reading | The same `OfflineWorker` (`sw/offline-worker.ts`) that the web's service worker runs, called by the app's transport in the page, with copies in IndexedDB (`platform/copies.ts`, a Cache Storage subset). The offline pack, the settings field and the notices are shared code; the setting starts on, as in an installed web app | iOS WKWebView runs service workers only for https app-bound domains, never for the app's `capacitor://` scheme, and API requests go to another origin anyway. One offline system, two places to run it |
| Annotations outbox | IndexedDB in the WebView, sent with the device token; works offline in the apps. Another account's unsent changes are kept (not deleted as in a browser) and *Settings → This device* offers *Copy as text* and *Discard* | A phone is one person's; their writing is never deleted silently |
| Player | `AppPlayerBackend`: audio through `@mediagrid/capacitor-native-audio` 3.0.0 (Media3 `MediaSessionService` foreground service on Android, AVPlayer and the Now Playing centre on iOS, skip 15/30 s on the lock screen); video in the page's media element. Both play the publisher's https file; a downloaded file plays first (`deviceCopy` in the controller). The mini-player takes a band at the bottom of the screen whose height it measures; the whole layout (menu drawer, tab bar area, reader, rail and sidebar, e-ink page buttons) ends above that band, so nothing sits under it | See *Audio plugin* below |
| Playback offline | The controller (`player/player.ts`, shared with the web) keeps every position on the device first (per account, `lib/late-writes.ts`) and removes it once the server has it. What is left, from playing without a connection, is sent at start, when the connection returns, when the app is shown again and every ten seconds while any waits, with `recordedAt` (when it was recorded on the device). The server keeps the position recorded last, so an older offline position doesn't overwrite a newer one from another device, and opening an item resumes from the newer of the server's and the device's. Reading progress read offline is kept and sent the same way (`state/late-progress.ts`): only while it is ahead of the server's, against the item's current revision. Disconnecting removes both; a lost connection keeps them for the same account | A position or progress made offline is never lost to an older one from the server; clocks on two devices can still differ, so recording times are only as good as the device's clock |
| Downloaded | Device copies: the item's details and its highlights and notes as JSON, and its media file (the app's own `PurssDevice` plugin, [plan/38](38-phone-background-and-widgets.md)) in `Library/NoCloud` (iOS) or the app's files (Android, backups off). Always the publisher's https file, straight from the publisher (the server stores none). Never counted against the account; shown as *Downloaded* | plan/25's "Downloaded" |
| Reading downloads offline | When neither the network nor the offline copies answer `GET /api/items/:id` or its annotations, the download does (marked as this device's copy). The *Downloaded* page lists them | A download is kept regardless of the reading queue |
| Automatic downloads | Settings → This device: *To read podcast episodes*; *Only on Wi-Fi* (on by default; downloads started by hand always go ahead); *Stop automatic downloads at* 0.5 to 10 GB (2 GB default); *Remove downloads when finished* (marked Finished or Ignored, or played to the end). All off by default. They run while the app is open: shortly after start, after new items, on reconnect, on returning to the app and every 30 minutes; and while it is closed through a native background job ([plan/38](38-phone-background-and-widgets.md)). Which items to fetch is PURSS's answer to `POST /api/downloads/plan`, by the shared rules. A failed download is retried only by hand | Device storage is the person's to spend; nothing evicts what they chose except the cleanup they turned on |
| Limit | Automatic downloads are chosen so the total stays under the limit (the feed's declared size, about 128 kbit/s for the length, else 100 MB); one whose declared or received size outgrows the room left is stopped and marked failed with the reason. No download is larger than 4 GB (`MAX_DOWNLOAD_BYTES`); otherwise downloads started by hand go ahead and count toward the total. *Stop download*, removing all downloads, disconnecting or another account stops the download in progress on the wire and records nothing of it; partial files a stopped app left are swept when the app starts | A promise that automatic downloads never exceed the limit, without refusing what the person asks for |
| Deleted items | A refresh that finds the item gone (404) removes its download | The device follows the PURSS |
| Accounts | Downloads are kept per account; signing in as another account deletes the previous account's | Tenant isolation on a shared device |
| Share intake | Android `ACTION_SEND text/plain` and an iOS share extension, both through `@capgo/capacitor-share-target` 8.0.65. The app finds the first web address in what was shared and asks: **Keep link** (the *Keep this page* dialog that the extension's deep link also opens, plan/32: what the PURSS already has, basket choice, title prefilled, `POST /api/items/manual`, which keeps an existing item instead of a duplicate) or **Add as source** (prefilled; discovery starts only when the person presses Find) | The Capacitor-supported route; nothing leaves the device until the person chooses |
| Deep links | `purss://connect` (connection), `purss://share` (the iOS extension opening the app) and `purss://open` (a tapped home-screen panel's row or heading, plan/38, or notification, plan/37: one reader, `platform/open-link.ts`, navigation only) | Nothing else was asked for |
| Notifications | System notifications through the project's push relay, content-free; see [plan/37](37-push-notifications.md) | Self-hosters need no account or setup |

### Audio plugin

`@mediagrid/capacitor-native-audio` (MIT, releases for Capacitor 6, 7 and 8, last 3.0.0 in January
2026) was chosen over `@capgo/native-audio` 8.4.2 and `@capacitor-community/native-audio`:

- it runs playback in a Media3 `MediaSessionService` declared as a `mediaPlayback` foreground
  service, which Android needs to keep playing with the screen off; capgo's leaves the foreground
  service to the app, and the community plugin is for short sounds;
- it shows the system media notification and lock-screen controls, and reports play and pause from
  those controls back to the app;
- it streams URLs (publishers' files) and plays local files.

Limits that the backend works around: no position events (it reads the position every second
while playing and on every pause), no error event (a file that isn't ready within 30 seconds counts
as failed), whole-second seeking, and the native player outliving a page reload (a leftover player
is destroyed first). `apps/web/src/platform/native/audio-backend.ts` documents each.

On Android the plugin ignores its skip-time options and leaves "next" and "previous" to Media3, which
does nothing with a single episode, so a headset's double press did nothing. The app patches it
(`apps/mobile/patches/@mediagrid+capacitor-native-audio.patch`, applied by `npm run sync -w @purss/mobile`
through `scripts/patch-plugins.ts`): the session's player skips 30 s forward on next and 15 s back on
previous, and the notification shows skip-15 and skip-30 buttons. `npm test` fails if the patch stops
fitting the installed plugin. iOS is unchanged.

## Verified

- Unit tests: `platform/copies.test.ts`, `sse.test.ts`, `native/connect.test.ts` (RFC 7636 vector,
  callback matching), `native/transport.test.ts`, `native/audio-backend.test.ts`,
  `downloads/rules.test.ts`, `downloads/manager.test.ts`, `share/link.test.ts`, the player's
  device-copy test, the starting server (`workspace-address.test.ts`), and positions and progress
  made offline: `player/player.test.ts` and `native/audio-backend.test.ts` play offline past 4:01
  (from 3:41 on the server), reopen and resume there, then send it on reconnection with its recording
  time; `state/late-progress.test.ts`; the server's rule in `services/media.test.ts`.
- The media journey checks, at laptop and phone size, that the rail, the sidebar, the reader, the
  list, the menu drawer down to Settings (clicked) and the e-ink page buttons end above the player,
  with the tab bar below it; against the build before the fix it fails at the first check.
- On the Android emulator: the first screen offering *Continue* to the official server, which opens
  its sign-in in Custom Tabs; *Use another server* with the http warning for a LAN address;
  connecting to another server; the reader, the list and the menu drawer (Settings above the player)
  with the mini-player open; *Settings → This device* naming the server; and after *Disconnect this
  app*, the first screen starting on the server chosen before.
- Web behaviour: `npm run check`, `npm test` and the hermetic web journeys (offline, connect, media,
  e-ink, email) after the platform layer was introduced.
- Android: a debug APK built with Gradle (AGP 8.13, JDK 21), run on an Android 15 (API 35, Google
  APIs) emulator against `apps/mobile/scripts/emulator-workspace.ts` through `adb reverse`. Checked:
  an http address other than this device's is refused; connecting through Chrome Custom Tabs
  (sign-in, the approval page, the code back at `purss://connect`, and the
  confirm-it's-you step when the sign-in was older than ten minutes); Home, a source and an
  article read with the device token; downloading the article; with airplane mode on and the server
  unreachable, a cold start showing the saved Home and the Downloaded page and the article's text; a link shared through the Android
  share sheet kept in a new basket, the same page shared again as a plain-http address with a
  tracking parameter kept once ("You already had this page"), and Add as source prefilled without
  a lookup; Settings → This device; *Disconnect this app* revoking the token on the server and
  leaving no token, copies or downloads on the device; and a disconnection from the browser side
  bringing the running app back to its first screen with a notice.
- Found on the device and fixed: the emulator's WebView (Chromium 124) parses `purss://connect?…` with
  no host, so the callback is read by hand (`readCallback`).

## Not verified

**iOS is unverified**: it can't be built on Linux. The project is complete as far as can be checked
without Xcode (plists and entitlements parse; every object in `project.pbxproj` resolves; the
share extension is a target embedded in the app), but it has never been compiled or run. See
[apps/mobile/README.md](../apps/mobile/README.md) for what the owner does on a Mac. That includes
keeping the page's data (offline copies, unsent highlights and notes) out of iCloud backups: the app
marks `Library/WebKit` excluded from backup at every launch (`AppDelegate.swift`), as the downloads in
`Library/NoCloud` are; whether a backup then leaves it out is to be checked on a device.

**Playing an episode in the native player and downloading its file** from a publisher's `https` address has not been
checked on a device: the emulator PURSS stores and serves no media, so it needs a real `https` audio file.

## Not built

- CarPlay and Android Auto, store submission, signing keys (documented, never committed). Widgets,
  downloads while the app is closed and cancelling on the wire are in [plan/38](38-phone-background-and-widgets.md);
  notifications on the phone in [plan/37](37-push-notifications.md).
- Starting the app with no connection needs offline reading on (the default), because the session and
  the PURSS's lists come from those copies; downloads alone don't start the app offline. With
  offline reading off, downloads are still read and played offline while the app is running (unit-tested
  in `native/transport.test.ts`, not checked on the device).
- Saving files shared into the app (images, PDFs); only links are taken.
- Keeping changes made offline other than highlights and notes (as on the web).
- An `ASWebAuthenticationSession` sign-in on iOS. The apps use `@capacitor/browser`
  (SFSafariViewController), so on iOS a `purss://connect` callback could in principle reach another
  app that registered the scheme; PKCE makes an intercepted code useless without the verifier.

## Open questions for the owner

- **App id and name** before any store release (see above).
- **Plain-HTTP servers on a home network.** Built as a conservative default pending the owner's
  decision: allowed only on the local network, with a warning, by the rule shared with the extension
  (plan/32). The alternative is HTTPS only (and Android's network rules back to no clear text).
  Passkeys don't work on such an address either. ATS's handling of the local-name exceptions on iOS is
  unverified (no Mac).
- **`ASWebAuthenticationSession` on iOS** through a small native plugin (binds the callback to this
  app), at the cost of one more native component to maintain.
