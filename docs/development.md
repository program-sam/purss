# Development

Working rules for contributors are in [AGENTS.md](../AGENTS.md); acceptance gates are in
[plan/13](../plan/13-validation.md). This page covers the mechanics.

## Layout

| Path | What lives there |
| --- | --- |
| `apps/api` | API server (`src/main.ts`), operator CLI (`src/cli.ts`), routes, services, migrations (`src/db/migrations`) |
| `apps/worker` | Job runner and handlers |
| `apps/egress` | Egress proxy, feed gateway, control listener |
| `apps/web` | React web app (Vite); feature pages registered in `src/plugins.ts`; platform layer in `src/platform` |
| `apps/mobile` | Android and iOS apps (Capacitor) around the web app's build; see its README |
| `apps/extension` | Browser extension for Chrome, Edge, Firefox and Safari; built to `apps/extension/dist` (see its README) |
| `packages/domain` | Shared contracts: IDs, workflow, query tree, API and job schemas |
| `packages/connectors` | Safe fetch, discovery, feed parsing, readable capture, OPML |
| `packages/freshrss` | GReader client, sync walk, fixed admin commands, engine lifecycle |
| `packages/ui` | Design tokens and UI primitives |
| `infra` | Compose files, product image, engine image and its admin helper |
| `scripts` | Dev runner, engine lifecycle, backup and restore, repository check, allowlist generator, dataset generator (size gate) |
| `tests/engine` | Contract tests against the pinned FreshRSS container |
| `tests/acceptance` | Real-stack browser journey |
| `plan`, `user-stories` | Intent, decisions and personas |

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
node scripts/version.ts                      # this checkout's version (plan/40), e.g. 2631214
node scripts/release-notes.ts 2631201        # what changed after a version, as Markdown for an update post
```

Run `npm run check` and `npm test` for every change, and `test:engine` and `test:e2e` for
changes to the engine path or user journeys. For a web-only loop,
`npm run dev -w @purss/web` starts Vite on port 5173 (the app is at `/app/`) and proxies `/api`;
start the API with `PURSS_PUBLIC_ORIGIN=http://localhost:5173` so its origin and passkey checks match.

On a shared machine, wrap heavy runs (builds, `test:engine`, `test:e2e`) in the host's work
lock, for example `~/.t3/bin/hostlock work engine-tests -- npm run test:engine`, and wrap
performance measurements in `hostlock measure`.

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
- **Secrets, runtime data and downloaded content stay out of Git** (`data/`, `.env`, backups).

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

Every Monday [.github/workflows/weekly-updates.yml](../.github/workflows/weekly-updates.yml) runs
`node scripts/update-dependencies.ts` and takes what is safe, after the same checks as a push to main:

| What | Taken automatically | Reported for a person |
| --- | --- | --- |
| npm packages | The newest release within the major version (the minor for 0.x), kept exact or `^` as written, and indirect dependencies within their ranges | A new major version |
| The phone apps' native plugins (all of `apps/mobile`'s dependencies) | Nothing | Any newer version: it may need an app release (plan/39) |
| RSS-Bridge (`infra/compose.yaml`) | The newest image, if no bridged service that works on the current image fails on it (`node scripts/bridge-check.ts`, asking a failing service three times) | |
| FreshRSS | Nothing: the engine tests need podman networking a CI runner lacks | A new version (check the allowlist and reference commit, above) or a rebuilt image of the pinned one |
| GitHub Actions | Nothing | A new major version |

New dependency code never runs with the right to change the repository. A read-only job finds the
updates and runs the checks; a second job, which runs no updated code, checks that the change touches
only dependency versions, the lockfile's registry packages and the RSS-Bridge digest — it stages
the change and compares the staged files with the tested commit (`node scripts/check-update.ts`),
so the form of the patch can't hide anything — and pushes it only if main is still the commit that
was tested; then the usual test-and-deploy workflow runs for that commit. One issue, *Dependency
updates*, says what the last run couldn't do and what needs a person; it is updated each week and
closed when both are empty. Run it now from the Actions tab (*Run workflow*, on main). The Node.js
base images float on `node:26-bookworm-slim` and are refreshed whenever the server builds.

## Adding a page to the web app

Add an entry to `featurePages` in `apps/web/src/features/pages.tsx` (path, title, component,
and optionally `nav`, `parent` or `adminOnly`). The shell supplies the header, sidebar and item
panel. See the [web README](../apps/web/README.md).

## The phone apps

`apps/mobile` wraps the web build in Capacitor; screens stay in `apps/web` and anything that differs
on a phone goes behind `apps/web/src/platform/` (transport, offline copies, player backend, downloads,
share intake). Its tests run with `npm test` like the rest. Building the Android app needs the Android
SDK and JDK 21; the steps, the emulator PURSS (`apps/mobile/scripts/emulator-workspace.ts`) and
the iOS steps on a Mac are in [apps/mobile/README.md](../apps/mobile/README.md). Run Gradle and the
emulator under the host's work lock; the emulator holds several cores while it runs, so shut it down
when you are done.
