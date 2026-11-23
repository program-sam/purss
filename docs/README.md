# Documentation

These pages describe how PURSS works.

| Page | For | What it covers |
| --- | --- | --- |
| [User guide](user-guide.md) | People using PURSS | Setup and sign-in, adding sources, collections and baskets, views, workflow, search, sharing, your data, settings |
| [Host it yourself](install.md) | People setting up their own installation | Step by step: choosing localhost, home network or HTTPS, settings, first start, the setup code, inviting your household, backups, updates, common problems |
| [Self-hosting](self-hosting.md) | Administrators | Running locally and with Docker Compose, the setup code, the administrator CLI, backups, upgrades, configuration |
| [Security](security.md) | Administrators and reviewers | How PURSS protects accounts, data and the server, and what stays with the administrator |
| [Storage and retention](storage-and-retention.md) | Everyone | What PURSS stores, how kept items and space are counted, and what is removed when |
| [Sources](sources.md) | Everyone | What you can follow, and how each kind of source is found and fetched |
| [Assistants](assistants.md) | People using AI assistants, administrators | How an assistant connects, what it can read and change, and how to turn it off |
| [Architecture](architecture.md) | Contributors and administrators | The component map, who writes what, and how items, keeps, captures and syncs flow |
| [Development](development.md) | Contributors | Repository layout, commands, conventions, testing and acceptance, design principles, migrations, the engine allowlist, versions and releases |
| [Glossary](glossary.md) | Everyone | The words PURSS uses in the interface, the docs, the API, the database and the code, and what each means |

The [component map](architecture.md#components) is in the architecture page. Component details live next to the code: [API](../apps/api/README.md), [web app](../apps/web/README.md),
[worker](../apps/worker/README.md), [egress](../apps/egress/README.md),
[push relay](../apps/push-relay/README.md), [browser extension](../apps/extension/README.md),
[mobile app](../apps/mobile/README.md), [desktop app](../apps/desktop/README.md),
[public site](../apps/site/README.md), [domain](../packages/domain/README.md),
[connectors](../packages/connectors/README.md), [engine adapter](../packages/freshrss/README.md),
[UI](../packages/ui/README.md), [translations](../packages/translations/README.md), [engine operation](../infra/engine/README.md),
[Compose packaging](../infra/README.md) and the [acceptance journeys](../tests/acceptance/README.md).
