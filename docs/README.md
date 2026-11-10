# Documentation

These pages describe the application as it works today. The [plan](../plan/README.md)
holds intent and rationale; [plan/22](../plan/22-implementation.md) records what each
gate builds and what it defers.

| Page | For | What it covers |
| --- | --- | --- |
| [User guide](user-guide.md) | People using PURSS | Setup and sign-in, adding sources, collections and baskets, views, workflow, search, sharing, your data, settings |
| [Host it yourself](install.md) | People setting up their own installation | Step by step: choosing localhost, home network or HTTPS, settings, first start, the setup code, inviting your household, backups, updates, common problems |
| [Self-hosting](self-hosting.md) | Operators | Running locally and with Docker Compose, the setup code, the operator CLI, backups, upgrades, configuration, security notes |
| [Architecture](architecture.md) | Contributors and operators | Components, who writes what, and how items, keeps, captures and syncs flow |
| [Development](development.md) | Contributors | Repository layout, commands, conventions, migrations, the engine allowlist |

Component details live next to the code: [web](../apps/web/README.md),
[worker](../apps/worker/README.md), [egress](../apps/egress/README.md),
[connectors](../packages/connectors/README.md), [FreshRSS adapter](../packages/freshrss/README.md),
[engine operation](../infra/engine/README.md), [Compose packaging](../infra/README.md) and the
[acceptance journey](../tests/acceptance/README.md).

The application is a preliminary build: implemented end to end and tested locally, but not
hardened or reviewed for exposure to the public internet.
