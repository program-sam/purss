# Development

Working rules for contributors are in [AGENTS.md](../AGENTS.md). This page covers the mechanics:
layout, commands, conventions, how a change is tested and accepted, and how builds are versioned
and released.

## Layout

| Path | What lives there |
| --- | --- |
| `apps/api` | API server (`src/main.ts`), operator CLI (`src/cli.ts`), routes, services, migrations (`src/db/migrations`) |
| `apps/worker` | Job runner and handlers |
| `apps/egress` | Egress proxy, feed gateway, control listener |
| `apps/web` | React web app (Vite); feature pages registered in `src/plugins.ts`; platform layer in `src/platform` |
| `apps/mobile` | Android and iOS apps (Capacitor) around the web app's build; see its README |
| `apps/desktop` | Desktop app for Windows, macOS and Linux (Tauri) around the web app's build; see its README |
| `apps/push-relay` | Small service that wakes phone apps; holds the push credentials so a self-hosted PURSS needs none |
| `apps/site` | The public website: home page and the Terms, Privacy and Legal notice pages |
| `apps/extension` | Browser extension for Chrome, Edge, Firefox and Safari; built to `apps/extension/dist` (see its README) |
| `packages/domain` | Shared contracts: IDs, workflow, query tree, API and job schemas |
| `packages/connectors` | Safe fetch, discovery, feed parsing, readable capture, OPML |
| `packages/freshrss` | GReader client, sync walk, fixed admin commands, engine lifecycle |
| `packages/ui` | Design tokens and UI primitives |
| `packages/translations` | Every word people read: one catalogue each for the website, the app, the UI kit, the extension, the server and shared text (see its README) |
| `infra` | Compose files, product image, engine image and its admin helper |
| `scripts` | Dev runner, engine lifecycle, backup and restore, repository check, allowlist generator, dataset generator (size guard) |
| `tests/engine` | Contract tests against the pinned FreshRSS container |
| `tests/acceptance` | Browser journeys: one against the whole stack, the rest against the API alone |
| `docs` | These pages; each app and package has its own README next to its code |
| `.github/workflows` | Test and deploy, the monthly dependency update, the desktop and Android apps, the browser extension |

The npm workspaces are `apps/*` and `packages/*`, all private.

## Commands

```sh
npm install
npm run check        # repository layout, Markdown links, then tsc --noEmit over everything
npm test             # unit and SQLite integration tests (node:test, hermetic)
npm run test:engine  # contract tests against isolated FreshRSS containers (podman, a few minutes)
npm run test:e2e     # builds the web app and the extension, then the real-stack journey and the hermetic journeys in Chromium (podman, network)
npm run build        # web app to apps/web/dist (the API serves it)
npm run build:extension  # browser extension: apps/extension/dist/<browser>/ and a .zip per browser
npm run dev          # whole stack locally; see self-hosting.md
node scripts/version.ts                      # this checkout's version (see Versions), e.g. 2631214
node scripts/release-notes.ts 2631201        # what changed after a version, as Markdown for an update post
node scripts/journal-feeds-check.ts          # live check that journal pages, society pages and DOIs still find their journal's feed (network)
node scripts/dataset.ts                      # a 100,000-item account for the size guard (see Testing and acceptance)
```

[Testing and acceptance](#testing-and-acceptance) says what to run for which change. For a web-only
loop, `npm run dev -w @purss/web` starts Vite on port 5173 (the app is at `/app/`) and proxies `/api`;
start the API with `PURSS_PUBLIC_ORIGIN=http://localhost:5173` so its origin and passkey checks match.

## Conventions

- **TypeScript without a build step on the server.** Node 26 runs `.ts` files directly by
  stripping types, so only erasable syntax is allowed (`erasableSyntaxOnly`: no enums,
  namespaces or parameter properties). Imports name the `.ts` file. `tsc` only type-checks.
- **Tests** use `node:test` and `node:assert`, sit next to the code as `*.test.ts`, and are
  picked up by the globs in `package.json`. API tests use a real SQLite database in a temp
  directory (`apps/api/src/testing.ts`). Fetching code is tested against local servers through
  in-process test hooks (`testAllowAddress`, `resolver`); no environment variable relaxes the
  address rules.
- **The browser imports types only from `@purss/domain`** (`import type`); the domain package's
  runtime uses Node modules and `zod`, which stay on the server.
- **The API is the only database writer.** Other processes go through its internal routes.
- **Scoped queries.** Product queries filter by the principal's `workspace_id` or `account_id`.
- **User-facing messages** are plain language; errors are `{ error: { code, message } }`.
- **Copy lives in `@purss/translations`.** Visible text, emails and messages people read come from the
  catalogue for their audience, never inline strings; ids, logs, operator output and labels only screen
  readers announce stay in code ([packages/translations](../packages/translations/README.md)).
- **Secrets, runtime data and downloaded content stay out of Git** (`data/`, `.env`, backups).

## Testing and acceptance

Run `npm run check` and `npm test` for every change, and `npm run test:engine` and
`npm run test:e2e` for changes to the engine path or user journeys. A change is accepted when it
works on realistic data, not when its own fixtures pass.

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run check` | Package manifests (named, private), the required README files and the pages in `docs`, every local Markdown link, then `tsc --noEmit` over the apps, packages, scripts and tests | Node 26 |
| `npm test` | The tests next to the code, four files at a time: domain transitions and parsing, fetching and its address rules, API services and routes on a real SQLite database, worker handlers, the web app's logic, the extension, the packaging scripts. Hermetic: no network, containers or browser | Node 26 |
| `npm run test:engine` | Contract tests of the FreshRSS boundary against the pinned engine container, one file at a time: provisioning, restart and replacement, every feed fetch going through the egress proxy and never directly, subscribing, entry paging, resume, upstream edits and late arrivals, read mirroring, one upstream fetch for many accounts, scheduled refresh, an interrupted first run, feeds too big for the engine through the feed gateway | podman, a few minutes |
| `npm run test:e2e` | Builds the web app and the extension, then drives Chromium: the core journey against the real stack (sign-up, passkey, two real public sources, every view, keeping with a readable-text capture, search, restart, sign-in again, an invited account that asks to be deleted), then hermetic journeys for offline reading, Home, right-to-left text, plan limits, connected apps, assistants signing in with OAuth, the player, the e-ink display, account email, sign-in with Google and the extension. Each journey is described in the [acceptance README](../tests/acceptance/README.md) | The core journey needs podman and network; all need Playwright's Chromium |

The workflow that deploys `main` runs `check`, `test` and the build. `test:engine` and `test:e2e`
need podman and network, so they run by hand before a push that needs them.

### Realistic data

Unit tests and mocks show that code does what its author expects. They do not show that it works
with what feeds, FreshRSS, publishers' sites and large accounts really do, so:

- A mock passing is not proof of engine compatibility. Changes to sync, the engine adapter or the
  admin helper run `test:engine` against the pinned container.
- The core journey follows real public sources through FreshRSS, the egress proxy and the worker.
- Source discovery and the journal rules are checked against the live sites with
  `node scripts/journal-feeds-check.ts`; an RSS-Bridge image is checked against every bridged service
  with `node scripts/bridge-check.ts`. Both need the network and are not part of `npm test`.
- The page-list detector is measured against saved pages and hand labels (top-1 and top-3 accuracy, titles, dates,
  how well its confidence separates right from wrong) with
  `node scripts/page-lists-eval.ts <pages-dir> <labels.json>`; the saved pages are not in the repository, so it is
  not part of `npm test` either.
- Anything that changes how lists, counts, storage totals or sync read the database is shown on a
  large account (below), not only on a test database.
- Say which commands you ran, what they showed, and which cases you could not try.

### The size guard

A lookup without an index costs nothing on a test database and stops a host once an account holds
tens of thousands of items. `node scripts/dataset.ts` builds accounts of realistic size in a throwaway
data directory (under the ignored `data/`), through the product's own code: sync batches that follow
the backlog and settling rules, Keep, bulk state changes, captures and notifications. Point
`PURSS_DATA_DIR` at the directory to serve it.

| Dataset | Build |
| --- | --- |
| One large account | `node scripts/dataset.ts`: 1 account, 300 sources, 100,000 items; a few percent New, 2% Ignored, 10% in other workflow states, 1.5% kept |
| A busy host | `node scripts/dataset.ts --accounts 20`: 20 such accounts, about 2 million items; allow an hour and several GB of disk |
| A large account followed from now | `node scripts/dataset.ts --start-from now`: the large account with its sources followed from now, so most items arrived Ignored, as a backlog does |

`npm test` guards the queries on generated data
([performance.test.ts](../apps/api/src/services/performance.test.ts)):

- No query behind `GET /api/bootstrap` or the sync path reads a whole table to find rows.
- The counts, Home's queries and the default, title, kept-time and source orders
  plan as designed: a partial or covering index, or an ordered index read with no sort.
- On a generated 20,000-item account the median bootstrap queries take under 1.5 s.

`counts.test.ts` and `list-sort-keys.test.ts` in the same folder compare
counts, totals and the kept-time and source orders with the queries they replaced,
after random operations through every writer.

No test asserts the response times the app is held to on the large account, so they are measured by
hand with the app serving the dataset: `GET /api/bootstrap` under 300 ms, and item pages
(`GET /api/items`, 50 per page, first page with its total, in the default and title orders, for
everything, New, To read, a collection and a source) under 150 ms. On the busy host the same figures
hold for every account while the others hold their data, and the API and worker stay responsive
during a sync pass. Measure with a write between requests (so no count is reused) and without, warm
and cold, interleaved with the previous version when comparing, and
record the host and the numbers.

### Acceptance checks for user-journey changes

For a change to a journey, show that these still hold, with the tests that cover them:

| Area | What must hold | Where it is checked |
| --- | --- | --- |
| Add source | A direct feed, a page with alternate links, several candidates, an unsupported address, redirects, an already-followed source and a YouTube channel or video each end in a plain answer | `packages/connectors` discovery tests, `sources-discovery.test.ts`, the core journey, `journal-feeds-check.ts` |
| Fetching | Private, loopback and metadata addresses are refused, also after a redirect or a DNS answer that changes; oversized, compressed and slow bodies are cut off; no environment variable relaxes the address rules; the engine reaches feeds only through the egress proxy | `safe-fetch.test.ts`, `apps/egress` tests, the egress tests in `tests/engine` |
| Sync | Paging, resume after a crash between pages, replaying a committed page, upstream edits and late publications; batches sized in UTF-8 bytes, so Arabic and CJK pages stay under the body limit; accounts that follow one public feed cost one upstream request while each keeps only its own items | `packages/freshrss` sync tests, `apps/api` sync tests, `tests/engine` |
| Identity | Entries of one account never import into another's sources; an upstream edit keeps the item and adds a version; a replacement engine is adopted only after its queue is reviewed, without duplicate items | `core.test.ts`, `reconcile.test.ts`, `item-numbers.test.ts`, `tests/engine` |
| Workflow | A change made against a revision the item has moved past is refused or dropped with a plain message, never applied over the newer one; a bulk action or a keep gives one undo, and undo restores | `core.test.ts`, `state-change.test.ts`, `apps/web` outbox tests |
| Baskets and storage | An item kept in several baskets is stored and counted once; a failed capture releases its reservation; a full quota pauses new items and captures while reading, keeping and deleting still work; an import that does not fit writes nothing | `core.test.ts`, `kept-pictures.test.ts`, `used-bytes.test.ts`, `portability.test.ts` |
| Lists and search | Full-dataset text and state combinations, stable pagination, workspace isolation | `search.test.ts`, `core.test.ts`, the size-guard tests above |
| Accounts | One account never reads or changes another's items, sources or baskets; sign-in methods, recovery and account deletion | `core.test.ts` ("PURSSes are isolated"), `apps/api/src/auth` tests, deletion tests, the core journey |
| Operations | Backup and restore on a real database (restore refuses a damaged or newer backup and leaves the target as it was), migrations on populated data, graceful shutdown with a job running, an interrupted first run | `backup.test.ts`, `migrations.test.ts`, `transactions.test.ts`, `apps/worker` runner tests, `tests/engine/resume.test.ts` |
| Privacy | An export holds no secret, private address or engine identifier; a link carrying a key is kept off public pages; feed gateway addresses are logged without their signature | `portability.test.ts`, `public-pages.test.ts`, `privacy.test.ts` |
| Sharing | The review shows what becomes public; a page stops showing when the plan no longer includes sharing; anyone can report a public page and an administrator can take it down | `routes/sharing.test.ts` |
| Smart filters | Previews change no post; a person's own change is final; a refused key fails open; people cannot supply a key of their own | `ai-filters.test.ts`, `filter-judge.test.ts` |
| Keyboard and display | Keyboard-only paths, focus never falling to the page, reduced motion, right-to-left text, e-ink, and phone-sized layouts | The Home, right-to-left, media and e-ink journeys |

### Checked by hand

These have no automated check; verify them yourself when a change touches them:

- Screen readers: accessible names and live regions are written to be announced, but no screen reader
  runs in the tests. The journeys only check that focus and keyboard paths work.
- Light and dark themes (contrast) and layouts at other sizes than the journeys' phone and desktop
  windows.
- The phone and desktop apps on a device: the Android app on an emulator or phone, the iOS project on
  a Mac, the desktop app on each system. CI builds them but runs no interface test inside them. Push
  notifications, background downloads and widgets need a device ([mobile README](../apps/mobile/README.md)).
- The extension's right-click menu and address-bar keyword, which Playwright cannot drive; their logic
  has unit tests.
- Source discovery on the live web, which changes without notice: `journal-feeds-check.ts`.

## Design principles

For anyone changing the interface. The tokens and primitives are in
[packages/ui](../packages/ui/README.md); the wording is in [packages/translations](../packages/translations/README.md).

- **Say it, don't rely on guessing.** Use short action labels (Follow, Keep, Move, Undo) and pair an
  icon with a label when its meaning is not obvious. Every control has an accessible name, visible
  keyboard focus and a touch target that fits a finger.
- **No meaning in an icon, a colour, a hover or a gesture alone.** Drag has a menu alternative (a
  board card's *Move to*).
- **Undo for reversible changes**, with a result you can see.
- **Show the consequences** of publishing, permanent deletion, privacy and storage where the person
  agrees to them: a share shows what becomes public, a deletion says what goes.
- **No invented urgency.** New markers and counts are information; people can turn them off. Opening a
  view or clearing a marker never finishes, ignores or reads an item. No fake unread counts and no hidden
  changes to a subscription.
- **Plain empty states and errors:** one next action, and what happened and how to recover in a short,
  plain sentence. Do not drop titles or source names to make cards look cleaner; missing metadata is
  not invented.
- **Respect reduced motion**, and keep light, dark and e-ink working: take colours from the tokens
  rather than writing your own.


## Adding a migration

1. Add `apps/api/src/db/migrations/NNN_short_name.sql` with the next three-digit number.
2. It runs once, in order, inside a transaction, whenever a process opens the database (API
   start, the CLI, restore), and is recorded by file name in `schema_migrations`.
3. Applied files are never re-run, so put any change in a new file rather than editing one
   that has run anywhere.
4. Keep every product table tenant-scoped: an `account_id`/`workspace_id` column, or a parent
   row that has one.
5. There are no down migrations. Restore refuses a backup that has migrations this version
   doesn't know.

Integration tests open a fresh database, so `npm test` exercises the full migration chain.

## Regenerating the engine allowlist

Under Compose the worker administers FreshRSS through `/purss/admin.php` in the engine image,
which runs only the commands in
[infra/engine/image/allowlist.json](../infra/engine/image/allowlist.json): allowed CLI scripts
and the SHA-256 of each fixed `php -r` snippet. The list is derived from the worker's
operations in `packages/freshrss/src/allowlist.ts`. After changing those operations in
`packages/freshrss/src/admin.ts`:

```sh
node scripts/gen-engine-allowlist.ts
```

then rebuild the engine image. `packages/freshrss/src/allowlist.test.ts` fails while the
committed file and the code disagree.

## Dependency updates

On the first of every month [.github/workflows/monthly-updates.yml](../.github/workflows/monthly-updates.yml) runs
`node scripts/update-dependencies.ts` and takes what is safe, after the same checks as a push to main:

| What | Taken automatically | Reported for a person |
| --- | --- | --- |
| npm packages | The newest release within the major version (the minor for 0.x), kept exact or `^` as written, and indirect dependencies within their ranges | A new major version |
| The phone apps' native plugins (all of `apps/mobile`'s dependencies) | Nothing | Any newer version: it may need an app release ([native level](../apps/mobile/README.md#live-updates-and-the-native-level)) |
| RSS-Bridge (`infra/compose.yaml`) | The newest image, if no bridged service that works on the current image fails on it (`node scripts/bridge-check.ts`, asking a failing service three times) | |
| FreshRSS | Nothing: the engine tests need podman networking a CI runner lacks | A new version (check the allowlist and reference commit, above) or a rebuilt image of the pinned one |
| GitHub Actions | Nothing: workflow files are not something an update may change | A new major version, or a pinned tag that now points at another commit, with the commit to pin |

New dependency code never runs with the right to change the repository. A read-only job finds the
updates and runs the checks; a second job, which runs no updated code, checks that the change touches
only dependency versions, the lockfile's registry packages and the RSS-Bridge digest — it stages
the change and compares the staged files with the tested commit (`node scripts/check-update.ts`),
so the form of the patch can't hide anything — and pushes it only if main is still the commit that
was tested; then the usual test-and-deploy workflow runs for that commit. One issue, *Dependency
updates*, says what the last run couldn't do and what needs a person; it is updated each month and
closed when both are empty. Run it by hand from the Actions tab (*Run workflow*, on main). The Node.js
base images float on `node:26-bookworm-slim` and are refreshed whenever the server builds.

## Adding a page to the web app

Add an entry to `featurePages` in `apps/web/src/features/pages.tsx` (path, title, component,
and optionally `nav`, `parent` or `adminOnly`). The shell supplies the header, sidebar and item
panel. See the [web README](../apps/web/README.md).

## The phone apps

`apps/mobile` wraps the web build in Capacitor; screens stay in `apps/web` and anything that differs
on a phone goes behind `apps/web/src/platform/` (transport, offline copies, player backend, downloads,
share intake). Its tests run with `npm test` like the rest. Building the Android app needs the Android
SDK and JDK 21; the steps, the emulator PURSS (`apps/mobile/scripts/emulator-purss.ts`) and
the iOS steps on a Mac are in [apps/mobile/README.md](../apps/mobile/README.md). Run Gradle and the
emulator under the host's work lock; the emulator holds several cores while it runs, so shut it down
when you are done.

## Versions

Every commit on `main` has a version worked out from the history, with no tags or manual bumps. The
same number goes on the server, the web app, the phone apps, the desktop app and the browser
extension.

```text
2631214   = 26 (the year) + 312 (the day of the year, UTC) + 14 (that day's 14th commit on main)
26.312.14 = the same, spelled for the stores that limit each part
```

The format is fixed at seven digits, so a number never repeats and always grows, as store build
numbers must; a day has room for 99 commits, and any after the 99th share `…99`. Commits on `main`'s
first-parent line count in order each UTC day, and a merged branch is one commit. The code is
`packages/domain/src/version.ts` and `scripts/version.ts`.

| Build | Where it gets its version |
| --- | --- |
| A checkout (development, `npm run build`, the extension) | The git history |
| The official server | The deploy job writes `version.json` from the full history and adds it to the archive the server builds from |
| A server image built from a git clone | The image reads the clone's history while building |
| A copy without history | None: the server reports `null`, Settings shows no version, the Android build is `1` / `dev`, the extension `0.0.1` |

Google Play takes the number itself as versionName and versionCode; the browser extension stores and
Apple's version strings take the dotted spelling. iOS sets its version on the Mac before archiving
([mobile README](../apps/mobile/README.md)). The number shows at the bottom of Settings, in
`installation.version` of `GET /api/session` and in `version` of `GET /api/connect/info`. A problem
report names the line from Settings.

`node scripts/release-notes.ts <since> [<until>]` prints, as Markdown, the commit subjects on `main`
after a version, by day, newest first, each with its version; a merged branch lists its own commits.
It is what the apps' GitHub release notes are made from, so write commit subjects as plain
sentences about what people get.

## Releases

A push to `main` runs [deploy.yml](../.github/workflows/deploy.yml): `npm run check`, `npm test` and
the build, then, if they pass, the same commit is sent to the official server ([infra](../infra/README.md#deploying-from-github)).
Deploys run one at a time, in push order. `gh run list --branch main` shows the run; start one with
`gh workflow run deploy.yml --ref main` if a push started none.

The workflows hold the deploy, signing and store secrets, so every third-party action is pinned to a
full commit SHA with its tag as a trailing comment (`uses: actions/checkout@<sha> # v7`), never to a
tag that its owner can move. To bump one, resolve the tag to its commit (`gh api
repos/<owner>/<repo>/git/ref/tags/<tag>`; for an annotated tag, `git/tags/<sha>` on the returned
object gives the commit), put that SHA and tag in the `uses:` line of every workflow that uses the
action, and let the checks run. The monthly dependency update reports the actions whose pin is behind
([above](#dependency-updates)).

The desktop and Android apps and the browser extension have their own workflows,
[desktop.yml](../.github/workflows/desktop.yml) and
[extension.yml](../.github/workflows/extension.yml). Each runs monthly and when started by hand:
`desktop.yml` publishes a GitHub release of the desktop packages and the signed Android APK for the
version at the head of `main` unless it is already published, and `extension.yml` sends the extension
to the Chrome Web Store and addons.mozilla.org for review when it differs from what the store has. A
push to `main` that changes `apps/desktop` or `apps/mobile` only builds the apps. The signing and store
keys are repository secrets. Starting a release is the owner's decision; the Edge and Apple store
submissions are made by hand.
