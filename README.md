# PURSS

PURSS is your purse for the internet: a private, user-curated dashboard to follow sources,
organize items, keep what matters, and choose how to see it.

Self-ownership is the product principle: understandable storage, private-by-default
organization, and portable data whether self-hosted or using the planned official
hosted service.

FreshRSS is the collection engine. The product owns its interface, durable item
records, baskets, workflow, collections, search, and saved views. Ordinary users
should not need to understand FreshRSS, API passwords, XPath, or container networks.

## Status

A working preliminary application, run locally on one host. It implements the
approved A3 design and every planned gate in a preliminary state (see
[plan/22](plan/22-implementation.md) for what each gate includes and defers):
setup with a one-time code, passkeys and recovery codes, guided Add source with
YouTube and podcast discovery, FreshRSS collection through an egress proxy,
collections, baskets with kept versions and readable-text capture, saved podcast and video
files with an in-app player, five views,
workflow with undo, search, storage accounting, reminders, notifications, export
and import, OPML, shareable collections, hosted Discovery suggestions, engine review, administration, interface
sounds, backup and restore, and accounts with invitations on every installation.
Docker Compose packaging runs it on a server (see [docs/self-hosting.md](docs/self-hosting.md)).
Android and iOS apps reuse the web app through Capacitor ([plan/31](plan/31-mobile-apps.md); the
Android app is checked on an emulator, the iOS project is not yet built), and a desktop app for Windows,
macOS and Linux through Tauri ([plan/42](plan/42-desktop-app.md); checked on Linux). Open signup exists for hosted
mode but is off by default and needs outgoing email; payments, Web Push, native push and proprietary
service connectors are not built.

## Download the desktop app

The desktop app for Windows, macOS and Linux is in this repository's
[latest release](https://github.com/program-sam/purss/releases/latest):
[Windows](https://github.com/program-sam/purss/releases/latest/download/PURSS-windows-x64-setup.exe),
[macOS](https://github.com/program-sam/purss/releases/latest/download/PURSS-macos.dmg),
[Linux AppImage](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-x86_64.AppImage),
[.deb](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-amd64.deb) or
[.rpm](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-x86_64.rpm).
It updates itself. The Windows and macOS packages aren't signed by Microsoft or Apple yet, so both ask you to
confirm the first time you open it ([apps/desktop](apps/desktop/README.md#download)).

## Run it

For development: Node.js 26, podman (rootless is fine) and the pinned FreshRSS image.
To run your own installation, follow [Host it yourself](docs/install.md), a step-by-step
guide; [docs/self-hosting.md](docs/self-hosting.md) is the full reference.

```sh
npm install
npm run dev            # builds the web app, starts FreshRSS, egress, API and worker
```

Open http://localhost:8940 and enter the setup code from `data/secrets/setup-code`.
Ctrl+C stops everything (add `-- --keep-engine` to leave FreshRSS running). Data and
secrets live in `data/` (ignored by Git). Operator tools: `node apps/api/src/cli.ts`,
`node scripts/backup.ts`, `node scripts/restore.ts`, `node scripts/engine.ts status`.

## Start here

- [Documentation index](docs/README.md)
- [User guide](docs/user-guide.md)
- [Host it yourself](docs/install.md)
- [Self-hosting](docs/self-hosting.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Plan index](plan/README.md)
- [Product and scope](plan/01-product.md)
- [Domain model, including baskets](plan/02-domain-model.md)
- [Interaction design and T3 Code references](plan/03-experience-and-design.md)
- [Implementation milestones](plan/12-roadmap.md)
- [Decisions and open questions](plan/14-decisions-and-risks.md)
- [Storage and ownership](plan/17-storage-and-ownership.md)
- [Official hosted service](plan/18-hosted-service.md)
- [Twenty exploratory user narratives](user-stories/README.md)

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | Responsive PURSS app, views, reader, guided source setup |
| `apps/site` | Public website: home page, terms, privacy and legal notice |
| `apps/api` | Sessions, authorization, product database, search, commands |
| `apps/worker` | FreshRSS synchronization and bounded background jobs |
| `apps/egress` | Egress proxy for the engine and the private feed gateway |
| `apps/mobile` | Android and iOS apps: the web app's build in a Capacitor shell |
| `apps/desktop` | Windows, macOS and Linux app: the web app's build in a Tauri shell |
| `packages/domain` | Product identities, state transitions, query contracts |
| `packages/freshrss` | FreshRSS protocol adapter and capability checks |
| `packages/connectors` | Discovery and controlled non-feed source adapters |
| `packages/ui` | Original design tokens and reusable UI primitives |
| `infra` | Docker Compose packaging, engine image and operation notes |
| `tests/acceptance` | End-to-end product acceptance scenarios |
| `scripts` | Dev runner, engine lifecycle, backup/restore, repository validation |
| `plan` | Product, architecture, delivery, risk, and evidence documents |
| `docs` | User guide, self-hosting, architecture and development documentation |
| `user-stories` | Independent persona briefs, separate from the solution plan |

## Checks

```sh
npm run check          # repository layout, documentation links, TypeScript
npm test               # unit and SQLite integration tests (fast, hermetic)
npm run test:engine    # contract tests against the pinned FreshRSS container
npm run test:e2e       # real-stack acceptance journey in a browser (network needed)
```

## License

GNU Affero General Public License v3.0 ([LICENSE](LICENSE)). Anyone may use, change and
host it; anyone who distributes it or runs a modified version as a network service must share
their source under the same license.

## Working rules

See [AGENTS.md](AGENTS.md). Keep the repository private until the owner publishes it. Do not
commit, push, publish or deploy without the owner's authorization.
No third-party application code has been copied; bundled dependency licences ship with the web build (`licenses.md`).
