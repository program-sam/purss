# Desktop app

The app for Windows, macOS and Linux: the web app's build for the app's own root (`apps/web/app-dist`) in a
[Tauri](https://tauri.app) 2 shell. As with the phone apps there is no second interface: screens come from
`apps/web`, and what differs on a computer sits behind the platform layer in `apps/web/src/platform/desktop/`.
It connects to a PURSS with a device token ([plan/24](../../plan/24-connected-apps.md)), installs the
build of the interface that PURSS offers when it fits the app's Rust side (live updates,
[plan/39](../../plan/39-live-updates.md)), and updates itself from this repository's GitHub releases.
The design and what isn't built are in [plan/42](../../plan/42-desktop-app.md).

| Path | What lives there |
| --- | --- |
| `src-tauri/src/lib.rs` | The app: its commands (every power the page has), the tray, closing to the tray, notifications, the badge, its own updates, starting at sign-in |
| `src-tauri/src/interfaces.rs` | The interface shown: built in, or downloaded from the PURSS; served from the app's own origin; rollback |
| `src-tauri/src/files.rs` | Downloads as files in `PURSS` in a folder the person chooses, and the player's server on 127.0.0.1 |
| `src-tauri/src/connection.rs` | The device token in the system's credential store (a private file where Linux has none) |
| `src-tauri/src/incoming.rs` | Links (`purss:`, `feed:`, `podcast:`, `pcast:`) and OPML files handed to the app |
| `src-tauri/tauri.conf.json` | App id and name, the bundles, link schemes, the OPML file type, the updater's address and public key |
| `src-tauri/capabilities/main.json` | What the page may reach of Tauri itself: listening to events, nothing else |
| `native-level.json` | The desktop level live updates must match, and the fingerprint of the Rust side it was decided for |
| `scripts/build.ts` | Builds the interface and the app with the product's version |
| `scripts/release-files.ts`, `src/release.ts` | Names the release files and writes the updater's `latest.json` |

## Download

The newest release is at
[github.com/program-sam/purss/releases/latest](https://github.com/program-sam/purss/releases/latest),
and the website's download button picks the visitor's system. The file names are the same in every release
(`packages/domain/src/distribution.ts`).

Windows and macOS packages are not signed by Microsoft or Apple yet (an owner to-do, below): Windows SmartScreen
says *Windows protected your PC* (choose *More info*, then *Run anyway*), and macOS says the app can't be checked
(open it from *System Settings → Privacy & Security → Open Anyway*). Installed apps update themselves either way:
the updater checks its own signature.

## Build

Needs Node 26, Rust (stable) and, on Linux, WebKitGTK 4.1 and its development files
(`webkit2gtk4.1-devel` on Fedora, `libwebkit2gtk-4.1-dev` on Debian and Ubuntu, plus `libayatana-appindicator3-dev`
for the tray icon).

```sh
npm install
node apps/desktop/scripts/build.ts --no-updater --bundles appimage   # or deb, rpm, nsis, app, dmg
```

The script builds the interface for the app's root (`PURSS_WEB_BASE=/`, into `apps/web/app-dist`), then the app with
the product's version ([plan/40](../../plan/40-versions.md)) spelled `26.312.14`. A checkout without history builds
as `0.0.0`, and such a build, like any development build, never updates itself. Without `--no-updater` the build
signs the update files and needs the updater key (below). For a development run: `npm run interface -w @purss/desktop`,
then `cargo run` in `src-tauri`. Rust tests: `cargo test` in `src-tauri`.

## Releases

`.github/workflows/desktop.yml` builds Windows (NSIS installer), macOS (one universal app and DMG) and Linux
(AppImage, deb, rpm) on the 1st of every month and when started by hand (*Actions → Desktop app → Run workflow*),
and publishes a release `desktop-<version>` with the fixed file names and `latest.json`. When main hasn't changed
since the last release, it publishes nothing. A push to main that changes `apps/desktop` builds all three without
publishing. Installed apps look for a new version at start and every six hours, download it in the background into
their cache folder (`update/<version>.bin`), announce it with a notification and *Restart to update to …* in the tray's
menu, and install it when the person chooses *Restart to update* (tray or Settings → This device) or quits from the
tray. A version still waiting at the next start (the session ended with the app running) is installed then.

**The updater key.** Updates are signed with the project's own key (minisign), whatever the systems' signing. Its
public half is `plugins.updater.pubkey` in `tauri.conf.json`; the private half and its password are the repository
secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and a release fails without them.
Keep a backup of the private key: without it, installed apps can never update again. A new key pair
(`npx tauri signer generate -w updater.key`) means changing the public key and a release that everyone installs by hand.

**Owner to-do: signing the packages.** For macOS, an Apple Developer account (the same one iOS needs): a Developer ID
Application certificate and notarization, given to the workflow as secrets (`APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, which Tauri
reads), replacing the ad-hoc signature (`bundle.macOS.signingIdentity: "-"`). For Windows, a code-signing certificate
(Azure Artifact Signing, or an OV or EV certificate from a certificate authority) and `bundle.windows.signCommand`.

## Live updates and the desktop level

The app takes new builds of its interface from the PURSS it is connected to, as the phones do, and installs a
build only when the build's desktop level equals its own. `native-level.json` holds that level and a fingerprint of
the Rust side; when you change anything under `src-tauri/` or this package's dependencies, `npm test` fails and
names the new fingerprint. Put it in the file, and raise `level` if the interface now depends on the change (a
command added, removed or changed, a plugin). A new version of the app removes the interfaces it downloaded, so it
starts on its own until the PURSS's build fits it.

## Trying it

`apps/mobile/scripts/emulator-workspace.ts` gives a throwaway PURSS with a small library: start it, run the app,
choose *Use another server*, type `http://localhost:19990` and sign in with the username and password it printed. The app keeps
its state in the system's usual places (on Linux `~/.local/share/app.purss` and
`~/.config/app.purss`) and its downloads in `~/Downloads/PURSS`.

On Linux the app can be driven with WebDriver: `cargo install tauri-driver`, then `tauri-driver` on port 4444 runs
the app's binary as a session (`tauri:options.application`) through `WebKitWebDriver`. A headless KWin
(`kwin_wayland --virtual`) and a private D-Bus session keep such runs off the desktop and the keyring.
