# Notifications on the phone

The phone apps (plan/31) show PURSS's notifications as system notifications, for the official
server and for self-hosted ones, without self-hosters needing any account or configuration. Pushes carry
no content: a relay run by the project wakes the phone, and the phone fetches the text from its own
PURSS. This document records how, who sees what, and what is not built or not verified.

## Shape

```text
phone app ──(1) push address──► push relay (apps/push-relay) ──► handle rh_…
    │                                                ▲
    └──(2) handle ──► PURSS ──► fetch credential purss_push_… (to the phone's native code)
                         │
   something new in the bell, outside quiet hours
                         └──(3) POST /v1/notify {handle} ──► relay ──► FCM / APNs ──► phone
                                                                                    │
   (4) native code: POST /api/push/pending (Bearer purss_push_…) ──► PURSS     ──► texts│
                                                                                    ▼
                                                               system notification; a tap opens
                                                               purss://open?item=…&source=…
```

1. **Registration.** When the person turns on *Settings → This device → Notifications on this phone*
   (or *Turn on* in the bell's one-time offer), the system's permission prompt appears; never at first
   launch. The app gets its push address (an FCM token on Android, an APNs token on iOS, through
   `@capacitor/push-notifications`) and registers it with the relay together with a random *scope* kept
   per connection. The relay answers with a handle: `rh_` + HMAC-SHA256 of platform, token and scope
   under the relay's secret, so the same phone gets the same handle again (idempotent), and a different
   connection gets a different one (two PURSSes can't tell they reach the same phone).
2. The app sends the handle to its PURSS (`POST /api/push/device`, mobile device tokens only; the
   relay named must be PURSS's). PURSS stores it per device token in `push_devices` and
   returns a **fetch credential** (`purss_push_…`, 32 random bytes, only its SHA-256 stored), which the
   page hands to native code: Android's private preferences, or the iOS Keychain in an access group
   shared with the notification service extension. It reaches one thing, this phone's waiting
   notifications, so the extension never holds the device token.
3. **Waking.** `emit(…, { type: "notification" })` (a notification made or grown) raises an event; the
   API gathers for three seconds, then for each of the account's registered phones with something it
   hasn't been handed asks the relay to wake it: `POST <relay>/v1/notify {"handle"}` through `safeFetch`
   (POST support added for this: https, public addresses only, no redirects, 10 seconds, 4 kB answer). At
   most one wake per phone a minute; the relay's 429 is waited for; its 404 drops the registration (the app
   registers again at its next start). Failures are logged without the handle and touch nothing else.
   Wakes are best-effort and not queued in memory: once a minute the maintenance tick wakes, from the
   database alone, each phone with something it wasn't handed that arrived after its last wake, so a wake
   that quiet hours held back or a restart lost is sent then. A wake the phone didn't answer isn't repeated
   for the same notifications; the next new one wakes it again.
4. **Fetching.** The relay sends FCM a data message `{"purss":"1"}` (high priority, collapse key: an offline phone gets one wake,
   which fetches everything waiting) and APNs a mutable-content alert with fixed text and no collapse id (an
   alert never replaces an earlier one). On Android, `PurssMessagingService` (extending the plugin's
   service, which it replaces in the manifest, so new push addresses still reach the page) calls
   `POST /api/push/pending` with the fetch credential and shows each notification itself; on iOS the
   notification service extension does the same and replaces the alert's text with the newest one (with
   "N more in your PURSS" when there are several), keeping the fixed text when the fetch fails or
   finds nothing.
5. **Tapping.** Android notifications open `purss://open?item=…&source=…`; on iOS the extension puts that
   link in the notification and the push plugin hands the tap to the page. The page reads it by hand
   with the same reader and handler as the home-screen widget's taps (`platform/open-link.ts`, `OpenLinks`;
   ids must look like ids; anything else is ignored) and only navigates: the item in its source, the
   source, or Home. It changes nothing, so another app opening such a link can't do anything with it.

## What each party sees

| Party | Sees | Never sees |
| --- | --- | --- |
| Push relay | The phone's push address and IP address when it registers; a handle and the sending server's IP address for each wake, and when | Accounts, PURSS addresses (except as the sender's IP), notification text, items |
| Google (FCM) / Apple (APNs) | That the app on that phone received a push from the project's credentials, and when; on iOS the fixed text "You have something new in your PURSS." | Which PURSS, any notification text |
| PURSS | The handle; which notifications it handed to the phone | The phone's push address |
| Phone | The texts it fetches from its own PURSS | — |

PURSS keeps the handle as it is (it must send it); someone who copied it could only make the
relay wake that phone with no content, within the relay's per-handle limit. Turning notifications off
while offline is finished at the app's next start: until PURSS and the relay have both heard it, the
app keeps a note and tells them again. The relay stores only the SHA-256 of each handle (a copy of its database can't wake anyone), the
platform, the push address, the APNs environment and two times; entries unused for 180 days are deleted.
Its rate limits (per address or IPv6 /64, per handle including at most 200 wakes a day, and a global
registration budget) are kept in memory, at most 50,000 keys each. It has no accounts.

## Who is told what

The rules already deciding what reaches the bell decide what reaches the phone (`services/notifications.ts`);
the push code adds only delivery:

- nothing while notifications are off (frequency *Off*);
- **quiet hours are enforced on the server**: no wake during them; what arrived waits in the bell, and
  the first maintenance tick after they end wakes the phone once (`wakeHeld`), so overnight items arrive
  in the morning. The rule is `inQuietHours` in `packages/domain`, the one the web's
  browser alerts use;
- each phone is handed each notification once (`push_devices.shown_until`), and again when its text grows
  ("3 new from …", `notifications.changed_at`), which replaces the one shown;
- at most five per wake, oldest first; read notifications are not handed;
- titles as in the bell; the body only with *Show item titles in notifications*, as for browser alerts.
  Android notifications are private on a locked screen that hides contents (a public version says only
  "Something new in your PURSS").

## Configuration

- PURSS: `PURSS_PUSH_RELAY_URL`. Unset (or `official`, what Compose passes when the operator sets
  nothing) is the project's relay, `OFFICIAL_PUSH_RELAY` in `packages/domain/src/distribution.ts`; empty or
  `off` turns phone notifications off; another https address is for a fork that builds its own app with
  its own credentials. Plain http only for a relay on the same machine, to try the apps (wakes still go
  through `safeFetch`, which never reaches it). Nothing is sent while no phone has registered.
- App: registers with `OFFICIAL_PUSH_RELAY`, the only relay holding its credentials. Android debug builds
  can be given a local relay and a stand-in push address (`-PpurssPushRelay`, `-PpurssPushDebugToken`); release
  builds carry empty values.
- Relay: `apps/push-relay/README.md` (FCM service account, APNs `.p8` key, its own Containerfile and
  compose file, deployed separately from PURSS).

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Relay | One small Node service without dependencies or accounts; the project runs it | FCM and APNs credentials can't be given to self-hosters; nobody should need their own |
| Content | None in pushes; the phone fetches from its PURSS | Google, Apple and the relay learn only "something new for this handle" |
| Phone's credential | A narrow fetch credential per registration, not the device token | The iOS extension and Android's background service hold something that reaches only waiting notifications |
| Registration path | Phone → relay directly, then handle → PURSS | PURSS never sees the push address; the relay sees the phone's IP once per registration |
| Handle | Deterministic per platform, token and connection scope | Idempotent re-registration at every start, unlinkable across PURSSes |
| Delivery | From the API, in process, through `safeFetch` | The API is the only writer and knows when a notification is made; no new job kind for a best-effort wake |
| Android message | Data message, the app's own messaging service | Shown with fetched text even when the app is closed; a notification message would show the relay's text |
| iOS message | Alert with `mutable-content` and a notification service extension | iOS doesn't run apps for silent pushes reliably; the extension can replace the text |
| `google-services.json` | Not committed (`apps/mobile/android/.gitignore`); the owner places it | It names the owner's Firebase project (ids and an API key restricted to the app). Not a secret, since it ships in every APK, but it belongs to the owner's build, keeps forks from sending to the project's Firebase by accident, and keeps key scanners quiet |

## Verified

- Relay (`apps/push-relay/src/*.test.ts`): registration, the content-free FCM and APNs payloads against
  fake FCM (JWT bearer grant checked) and fake APNs (h2c, ES256 checked), dead tokens deleting the entry,
  the APNs sandbox fallback, FCM's 401 retry, both rate limits, strict input, CORS for the apps' origins
  only, expiry.
- PURSS (`apps/api/src/services/push.test.ts`): only a phone's token registers, only for the
  PURSS's relay; a new notification wakes the phone with exactly `{"handle"}`; the fetch hands each
  notification once and again when it grows; titles setting; read and notifications-off cases; quiet hours;
  one wake a minute and the relay's 429; the relay's 404, unregistering and revoking dropping the
  registration and its credential; the credential reaching nothing else. `safeFetch`'s POST, the config
  values, and account deletion removing registrations.
- App logic (`apps/web/src/platform/native/push.test.ts`): no prompt and no relay traffic until turned on;
  refused, unavailable and other-relay states; refreshing at start; turning off and disconnecting
  unregistering everywhere; links that only navigate (`platform/open-link.test.ts`, shared with the widget).
- Android emulator: see apps/mobile/README.md *Notifications on the emulator* for how; checked are the
  permission prompt from the switch, the switch's status, registration through a local relay, a
  notification fetched from PURSS and shown by the system through the debug-only broadcast that
  runs the messaging service's code (a grown notification replacing the one shown and opening its source,
  a single arrival opening its item, an open Settings dialog giving way), the registration surviving a
  restart, and turning the switch off removing it from PURSS and the relay so a wake shows nothing.

## Not verified, not built

- **Real delivery through FCM and APNs**: needs the owner's Firebase project and Apple key; proven only
  against fakes. On the emulator the push itself is replaced by the debug broadcast.
- **iOS is unverified** (no Mac): the extension, Keychain sharing, plugin registration and tap handling
  have never been compiled or run.
- When a fetch on iOS finds nothing (another wake already took it), the fixed text shows; iOS doesn't let
  an extension drop an alert without a special entitlement.
- Badges, notification actions (mark read from the notification), per-device choice of what to receive,
  and clearing a phone's notification when it is read elsewhere.
- Wakes are not retried after a failure other than the relay's 429; the next notification wakes again.

## Owner steps

1. **Firebase project** (console.firebase.google.com): add an Android app with package `app.purss`;
   download `google-services.json` to `apps/mobile/android/app/` (not committed), then `npm run sync` and
   build. Cloud Messaging API (V1) must be enabled.
2. **FCM service account**: *Project settings → Service accounts → Generate new private key*; keep the JSON
   outside Git, on the relay host.
3. **APNs key**: in the Apple developer account, *Keys → +*, Apple Push Notifications service; download the
   `.p8` once and note its Key ID and the Team ID. Enable Push Notifications and the keychain group on the
   App ID (apps/mobile/README.md, iOS).
4. **Relay**: deploy `apps/push-relay` (its README) behind HTTPS with both credentials, back up its data
   volume's `handle-secret`, and put its address in `OFFICIAL_PUSH_RELAY` before building the apps and the
   PURSS image.
