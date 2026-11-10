# Versions

The owner wants one version number to report problems against, track compatibility and write update posts
with. Every commit on main gets one, worked out from the history, with no tags or manual bumps. The same
number goes on the server, the web app, the phone apps and the browser extension.

## The number

```text
2631214   = 26 (the year) + 312 (the day of the year, UTC) + 14 (that day's 14th commit on main)
26.312.14 = the same, spelled for the stores that limit each part
```

| Concern | Decision | Reason |
| --- | --- | --- |
| Form | Seven digits: two for the year, three for the day of the year, two for the commit that day (`packages/domain/src/version.ts`) | The owner's choice: short, and not obviously a date. Fixed width, so a number never repeats and always grows, which build numbers in the stores must. An unpadded date (`2611814`) would collide (Jan 18 #14) and go backwards (Nov 10 #1 = `2611101`) |
| Counting | The commit's UTC day; the commits on main's first-parent line that day, oldest first, are #1, #2, … A merged branch is one commit, its merge (`scripts/version.ts`) | Every commit on main has exactly one number, and anyone with the history gets the same one |
| Busy days | Room for 99 a day; later commits that day share `…99` | Main has had at most 43 in a day |
| Stores | Google Play: versionName and versionCode are the number itself. Chrome, Edge, Firefox and Safari extensions and Apple's version strings: the dotted spelling (`26.312.14`); Chrome allows at most 65535 per part and Apple three parts | Every store accepts it, and each build from main is higher than the last |
| A build without history | No version: the server reports `null`, Settings shows none, Android is `1` / `dev`, the extension `0.0.1` | Saying nothing beats a made-up number |

## Where a build gets it

| Build | Source |
| --- | --- |
| A checkout (development, `npm run build`, `npm run sync`, the extension) | `readVersion()`: the history, with `git` |
| The official server | The deploy job (fetch-depth 0) writes `version.json` and adds it to the archive the server builds from |
| A self-hosted server built from a git clone | The image copies `.git`'s contents into its build stage (optional patterns, so an archive without them builds too) and reads the history there; a new commit reruns that step |
| A downloaded copy without history | None (see above) |

The image keeps `version.json`; the API reads it at start (`Config.version`).

## Where it shows

- **API:** `installation.version` in `GET /api/session` and `version` in `GET /api/connect/info`.
- **Settings**, at the bottom, for everyone: `Version 2631214`. In the phone apps also the installed app's
  version (from the store build) and the server's when it differs from the screens', e.g.
  `Version 2631214 · app 2630502` or `Version 2630502 · app 2630502 · server 2631214` (the server's update
  wasn't installed: refused, or built for other native code, [plan/39](39-live-updates.md)).
- **Release notes:** `node scripts/release-notes.ts 2631201 [2631214]` prints Markdown of what changed after a
  version: the commit subjects, which are written as plain sentences about what people get, by day, newest
  first, each with its version; a merged branch lists its own commits. Edit it into an update post or a
  report.

## Compatibility

The version says which build something is; whether the phone app can run a server's screens is the native
level's job ([plan/39](39-live-updates.md)). A problem report names the line from Settings, which has all
three: the screens, the installed app and the server.

## Not built

- iOS sets its version on the Mac before archiving (the commands are in the mobile README); the Xcode project
  has no step that reads it. Unverified, as iOS as a whole.

## Verified

- Unit tests: the format and its edge cases (UTC day, leap year, a busy day, store spellings), the counting in
  a scratch repository (UTC midnight, a merged branch), `version.json` without history, the release notes
  (days, a merge's commits), the Settings line, the extension's version.
- The server image built from a clone recorded the clone's version; from an archive with `version.json`, that
  file's; from a bare archive, none.
- In the browser, Settings showed `Version 2631215` for a build of the 15th commit of 8 November 2026, and
  `/api/session` and `/api/connect/info` reported it. The Android debug APK had versionCode and versionName
  `2631215`; the extension's three builds `26.312.15`.
