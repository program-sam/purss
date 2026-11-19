# PURSS

PURSS is your purse for the internet: a private, user-curated dashboard to follow sources,
organize items, keep what matters, and choose how to see it.

Self-ownership is the product principle: understandable storage, private-by-default
organization, and portable data whether self-hosted or using the official
hosted service.

FreshRSS is the collection engine. The product owns its interface, durable item
records, baskets, workflow, collections, search, and saved views. Ordinary users
should not need to understand FreshRSS, API passwords, XPath, or container networks.

## Status

PURSS runs as the official hosted service at https://purss.app and on your own server. It has
setup with a one-time code, email address and password sign-in with optional passkeys, guided Add source with
YouTube, podcast, social and journal discovery, FreshRSS collection through an egress proxy,
collections, baskets with kept versions and readable-text capture, an in-app player, five views,
workflow with undo, search, storage accounting, reminders, notifications, export
and import, OPML, shareable collections, hosted Discovery suggestions, engine review, administration, interface
sounds, backup and restore, and accounts with invitations on every installation.
Docker Compose packaging runs it on a server (see [docs/self-hosting.md](docs/self-hosting.md)).
Android and iOS apps reuse the web app through Capacitor ([apps/mobile](apps/mobile/README.md); the
Android app is checked on an emulator, the iOS project has not been built), and a desktop app for Windows,
macOS and Linux runs through Tauri ([apps/desktop](apps/desktop/README.md); checked on Linux). Open signup is on for the
official hosted service and off by default elsewhere (it needs outgoing email); paying for a plan goes through a
separate billing service. Phone notifications go through a push relay ([apps/push-relay](apps/push-relay/README.md)), tested
against stand-ins for Firebase and Apple's push service. Browsers get no Web Push, and there are no connectors for
services that need a sign-in.

## Download the desktop app

The desktop app for Windows, macOS and Linux is in this repository's
[latest release](https://github.com/program-sam/purss/releases/latest):
[Windows](https://github.com/program-sam/purss/releases/latest/download/PURSS-windows-x64-setup.exe),
[macOS](https://github.com/program-sam/purss/releases/latest/download/PURSS-macos.dmg),
[Linux AppImage](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-x86_64.AppImage),
[.deb](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-amd64.deb) or
[.rpm](https://github.com/program-sam/purss/releases/latest/download/PURSS-linux-x86_64.rpm).
It updates itself. The Windows and macOS packages aren't signed by Microsoft or Apple, so both ask you to
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
- [Security and privacy](docs/security.md)
- [Storage and retention](docs/storage-and-retention.md)
- [How sources work](docs/sources.md)
- [Assistants (MCP)](docs/assistants.md)

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | Responsive PURSS app, views, reader, guided source setup |
| `apps/site` | Public website: home page, terms, privacy and legal notice |
| `apps/api` | Sessions, authorization, product database, search, commands |
| `apps/worker` | FreshRSS synchronization and bounded background jobs |
| `apps/egress` | Egress proxy for the engine, the feed gateway for big feeds and the bridge router |
| `apps/mobile` | Android and iOS apps: the web app's build in a Capacitor shell |
| `apps/desktop` | Windows, macOS and Linux app: the web app's build in a Tauri shell |
| `apps/extension` | Browser extension for Chrome, Edge, Firefox and Safari |
| `apps/push-relay` | Content-free relay that wakes the phone apps |
| `packages/domain` | Product identities, state transitions, query contracts |
| `packages/freshrss` | FreshRSS protocol adapter and capability checks |
| `packages/connectors` | Discovery and non-feed source connectors |
| `packages/ui` | Original design tokens and reusable UI primitives |
| `infra` | Docker Compose packaging, engine image and operation notes |
| `tests/acceptance` | End-to-end product acceptance scenarios |
| `scripts` | Dev runner, engine lifecycle, backup/restore, repository validation |
| `docs` | User guide, self-hosting, architecture, security, storage, sources and development documentation |

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

See [AGENTS.md](AGENTS.md) for the rules contributors and coding agents follow.
No third-party application code has been copied; bundled dependency licences ship with the web build (`licenses.md`).
