# API

The product API: the one process that owns the product database (`product.db`, SQLite in WAL mode with FTS5, through
`node:sqlite`). It serves the web app at `/app/`, the public website at `/` in hosted mode, shared pages at `/p/<slug>`,
the JSON API at `/api`, the event stream at `/api/events` and the assistants' MCP endpoint at `/mcp`. The browser, the
phone and desktop apps, the browser extension, assistants and the worker all reach product data through it. The browser
and the worker never open the database, and FreshRSS is reached only through the worker, behind its adapter, never
through a generic URL proxy. The roles of the other components are in [architecture](../../docs/architecture.md).

```sh
node apps/api/src/main.ts       # or `npm run dev` for the whole stack
node apps/api/src/cli.ts status # operator CLI on the data directory (see docs/self-hosting.md)
```

Node 26 runs the TypeScript directly. Settings are environment variables read once by `loadConfig` (`src/config.ts`);
the table of them is in [self-hosting](../../docs/self-hosting.md#configuration).

## Listeners

| Listener | Default | For |
| --- | --- | --- |
| Public (`PURSS_HOST`, `PURSS_PORT`) | `127.0.0.1:8940` | Everything a person or an app uses. Checks the Origin and a per-session change token on cookie requests; bearer device tokens skip those checks and ignore cookies |
| Internal (`PURSS_INTERNAL_HOST`, `PURSS_INTERNAL_PORT`) | `127.0.0.1:8948` | The worker only: it leases jobs and posts results with the service token in `data/secrets/service-token`. Never mounted on the public listener |

A maintenance `tick` runs every 15 seconds in the same process: expiring job leases and storage reservations, queuing
each engine user's sync when it is due (waiting longer after repeated failures), reminders and digests, account
deletions, outgoing mail, phone wakes, and purging expired codes, tokens and old jobs. The threat model and the controls
behind these listeners are in [security](../../docs/security.md).

## Layout

| Path | What lives there |
| --- | --- |
| `src/main.ts` | Starts both listeners and the tick, serves the event stream; `createApp` opens the database and the service token |
| `src/server.ts`, `src/http.ts`, `src/web-routes.ts` | Listeners, headers and the request pipeline, the router, error shapes (`{ error: { code, message } }`), rate limits; which address is the app, the website or missing |
| `src/config.ts`, `src/app.ts`, `src/secrets.ts` | Configuration, the `App` and request context types and the audit log, secrets kept under `data/secrets` |
| `src/routes/` | One module per area, mounted by `routes/index.ts`; `public.ts` is the core (session, sources, items, baskets, search) and `internal.ts` the worker's routes. Routes parse input with the schemas in `packages/domain` and call services |
| `src/services/` | The behaviour: items and workflow, baskets and retention, the storage ledger, jobs and their failures, sync, captures, search, sharing, annotations, notifications, push, deletion, plans and more. The API is the only writer, and every query is scoped by the principal's account or workspace |
| `src/auth/`, `src/connect/` | Accounts, passkeys, passwords, external sign-in and sign-up; connected apps: one-time codes, device tokens and what each kind of app may reach |
| `src/oauth/`, `src/mcp/` | The assistants' OAuth server and the MCP server ([assistants](../../docs/assistants.md)) |
| `src/mail/` | Outgoing email, optional; open sign-up in hosted mode needs it |
| `src/db/` | The database wrapper and `migrations/NNN_name.sql`, applied in order at start and recorded in `schema_migrations`; see [development](../../docs/development.md) |
| `src/cli.ts` | The operator CLI: invitations, e-mail and allowance changes, plans, password reset links, usage reconciliation, a test e-mail |
| `src/billing.ts` | Hosted only: the hand-off to an external billing service and the plan it reports back. PURSS holds no payment details |

Tests sit next to the code and run with `npm test` against real SQLite databases in temporary directories
(`src/testing.ts`); what to run for which change is in [testing and acceptance](../../docs/development.md#testing-and-acceptance).
