# Documentation

These pages describe how PURSS works.

| Page | For | What it covers |
| --- | --- | --- |
| [User guide](user-guide.md) | People using PURSS | Setup and sign-in, adding sources, collections and baskets, views, workflow, search, sharing, your data, settings |
| [Host it yourself](install.md) | People setting up their own installation | Step by step: choosing localhost, home network or HTTPS, settings, first start, the setup code, inviting your household, backups, updates, common problems |
| [Self-hosting](self-hosting.md) | Operators | Running locally and with Docker Compose, the setup code, the operator CLI, backups, upgrades, configuration |
| [Security](security.md) | Operators and reviewers | How PURSS protects accounts, data and the server, and what stays with the operator |
| [Storage and retention](storage-and-retention.md) | Everyone | What PURSS stores, how kept items and space are counted, and what is removed when |
| [Sources](sources.md) | Everyone | What you can follow, and how each kind of source is found and collected |
| [Assistants](assistants.md) | People using AI assistants, operators | How an assistant connects, what it can read and change, and how to turn it off |
| [Architecture](architecture.md) | Contributors and operators | Components, who writes what, and how items, keeps, captures and syncs flow |
| [Development](development.md) | Contributors | Repository layout, commands, conventions, testing and acceptance, design principles, migrations, the engine allowlist, versions and releases |

Component details live next to the code: [API](../apps/api/README.md), [web](../apps/web/README.md),
[worker](../apps/worker/README.md), [egress](../apps/egress/README.md),
[push relay](../apps/push-relay/README.md), [browser extension](../apps/extension/README.md),
[phone apps](../apps/mobile/README.md), [desktop app](../apps/desktop/README.md),
[website](../apps/site/README.md), [domain](../packages/domain/README.md),
[connectors](../packages/connectors/README.md), [FreshRSS adapter](../packages/freshrss/README.md),
[UI](../packages/ui/README.md), [engine operation](../infra/engine/README.md),
[Compose packaging](../infra/README.md) and the [acceptance journeys](../tests/acceptance/README.md).
