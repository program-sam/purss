# Implementation plan

The owner approved the A3 PURSS design (prototype branch `prototype/ui-directions`,
`variants/workspace.html` and its storyboard) and asked for every planned feature in a
preliminary, working state. This document fixes the build decisions. "Preliminary"
means implemented end to end and tested locally on realistic data, not hardened for
public exposure. Sharing baskets and collections is on for every installation (Plus on hosted
ones) under the report and takedown policy in plan/19; hosted signup and deployment stay off until
the owner approves them.

## Stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, run directly by Node 26 type stripping on the server; `tsc --noEmit` for checks | No server build step; erasable syntax only |
| Database | `node:sqlite` (bundled SQLite 3.50, FTS5) | No native dependency; WAL; online backup API |
| HTTP | `node:http` with a small typed router; `zod` for request validation | Small surface we control |
| Web | React 19, Vite, TanStack Router and Query | As planned; A3 CSS ported to `packages/ui` tokens |
| Feed/HTML parsing | `htmlparser2` (XML and HTML), `sanitize-html` | Maintained, no DOM needed |
| Full-text capture | `@mozilla/readability` with `linkedom` | Bounded extraction job |
| Passkeys | `@simplewebauthn/server` and `/browser` | Maintained WebAuthn implementation |
| OIDC sign-in | `openid-client`, shown only when configured | Maintained; code + PKCE + nonce |
| Engine | FreshRSS 1.30.4 container, pinned by digest | Selected engine |
| Browser tests | Playwright (already installed on the host) | Real flows |

## Processes

```text
browser ── api (public listener: web assets + /api) ── product.db (SQLite, FTS5)
                │  internal listener: /internal/jobs (service token)
worker ─────────┘  leases jobs, talks to FreshRSS GReader API, submits batches
egress ── forward proxy for FreshRSS (SSRF rules) + feed-gateway listener (private feeds)
freshrss (container, internal network only; all fetches through egress)
```

- `apps/api` is the only database writer. Its internal listener is a separate port
  bound to loopback/internal network and accepts only service-authenticated job routes.
- `apps/worker` never opens the database. It leases jobs, calls FreshRSS, and posts
  idempotent batches; the API commits items, mappings and checkpoint in one transaction.
- `apps/egress` (new) runs the egress proxy that FreshRSS is configured to use through
  its global cURL options, applying the same address rules as product discovery on
  every request and redirect, and the private feed gateway on a dedicated listener.
- `npm run dev` runs the stack locally (FreshRSS in rootless podman). `infra/compose.yaml` runs it
  with Docker Compose: FreshRSS on an internal network whose only way out is egress, a thin engine
  image whose token-protected helper runs only the worker's fixed admin operations (no Docker
  socket), init/setup steps for secrets and engine settings, and `compose.proxy.yaml` for running
  behind an HTTPS reverse proxy with no host ports. Secrets live in a separate volume.

## Data model (first migration)

All product tables carry `account_id` and `workspace_id`; queries go through a scoped
repository that requires a resolved session principal. Tables: accounts, workspaces,
sign_in_methods (password hash with the username, passkey, oidc issuer+subject), sessions,
role_grants, audit_events, engine_connections, engine_users, sources, feeds,
subscriptions, items, item_versions (immutable content versions), external_ids,
collections (mode: sources | query), collection_sources,
views, item_state (workflow, revision, fresh, progress), state_log (the account's workflow changes), baskets,
basket_items, captures, storage_accounts, usage_events, reservations, jobs, outbox,
sync_checkpoints, reconciliation_queue, notifications, notification_prefs, reminders,
publications, publication_items, preferences, items_fts (FTS5).

Rules carried from the plan: stable internal IDs (ULID-like); external mappings scoped
to engine connection + upstream user; mutations carry `expectedRevision`; workflow,
reading progress, freshness and basket membership are independent; Keep commits a
minimum snapshot (an immutable item version) and membership atomically or fails;
basket pins are reference counted per version; deletion is reference-aware and never
quota-blocked; storage is a logical ledger with reservations settled in the same
transaction as the mutation, a bounded control headroom, and a physical disk reserve.

## Feature map and preliminary scope

| Gate | Implemented now | Deliberately not yet |
| --- | --- | --- |
| 1 Engine | Provisioning of a pinned FreshRSS (install + API user), GReader login, subscribe/unsubscribe/rename, paged incremental sync with continuation and checkpoints, replay-safe import, read/star outbox mirroring, purge-tolerant (absence never deletes), capability matrix recorded in tests, replacement-engine reconciliation queue | Recipes via extended OPML (generator exists, not wired to engine) |
| 2 Design | A3 implemented as the real UI | — |
| 3 Slice | Protected bootstrap (one-time claim secret), username and password sign-in with optional passkeys, sessions, CSRF, central capability checks, discovery (feeds, alternate links, YouTube channel/handle), follow, collections (sources and query), list/cards/board, workflow, New markers, atomic Keep, FTS search, storage ledger + indicator + breakdown, confirmed permanent delete of unkept items, disk-reserve pause, admin health | — |
| 4 Organize | Table and timeline views, query collections, Home layouts as dashboard sections, manual URL keep, full-text capture job, export/import (JSON + manifest, secret-free), SQLite backup/restore scripts, bulk actions, undo, storage page, in-app notifications with mute/quiet hours and browser notifications while open, anniversary reminders (on by default, hide/snooze/off), private statistics per source and per collection (counts, 26-week rhythm by publication date, states, opened/kept, storage, Finished/Ignored in the last 30 days from an own-change log that is exported and imported) | Web Push delivery to closed browsers |
| 5 Deploy | Docker Compose packaging (engine isolated behind egress, admin helper instead of exec, reverse-proxy mode), dev runner, egress proxy, admin area (health, sources, jobs retry/cancel, usage reconciliation, audit log, step-up), OPML subscription import/export through validated product fields, connector catalog (native feed, YouTube resolver), private feed gateway with token auth exercised by a controlled test adapter | Any real proprietary service adapter (none approved); a guided single-command installer |
| 6 Hosted | Accounts on every installation: admins invite people (e.g. a household), suspend, and grant or remove the admin role; each account has its own PURSS and FreshRSS user. Hosted mode adds storage allowances and optional open signup (`PURSS_SIGNUP=open`, rate-limited and capped per day; off by default; needs working outgoing email, [plan/27](27-outbound-email.md)) | Payments, abuse/verification tooling beyond rate limits, launch |
| 7 Sharing | Share on baskets and collections (filters without reading-state rules): live public page and Atom feed, review of the page and of what becomes public, pause, stop, Follow by URL through Add source; public notes per item, opt-in search listing, the `/follow` page and Follow buttons, visitor reports and administrator takedowns; Plus on hosted installations | Source bundles for followers |

OIDC sign-in is implemented and tested against a local mock issuer; no provider is
configured by default. Real-service connectors, turning on open signup, payment, push delivery
and any exposure beyond localhost remain owner decisions.

## Build order

1. Foundations (lead): workspace tooling, `packages/domain` (types, transitions, query
   tree), database + migrations, API skeleton with auth, scoping and storage ledger.
2. In parallel with explicit file ownership: web app (port A3); FreshRSS adapter, worker
   and engine container; discovery, safe fetch and egress; export/import/backup;
   admin/hosted/sharing after their API contracts exist.
3. Integration on a real local stack with real public feeds (journal, blog, YouTube
   channel, podcast, sparse feed), Playwright flows on desktop and phone sizes, and
   Sol code review per the owner's cross-check policy.

## Testing

Unit tests for domain transitions, query validation, URL safety and parsers; SQLite
integration tests for transactions, scoping, storage accounting and search; adapter
contract tests against the pinned FreshRSS container; Playwright flows for the A3
journeys (paste, follow, browse, organize, keep, restart, find again). `npm run check`
adds typechecking; `npm test` runs unit and integration tests; engine and browser
suites run through `npm run test:engine` and `npm run test:e2e` because they need the
container and a browser. Heavy runs use the host's shared work lock.
