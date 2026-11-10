# Architecture

## Fixed boundary

FreshRSS is the ingestion engine. The product is not a thin proxy: it owns a durable
item store, authorization, baskets, workflow, query/index layer, and presentation.
No direct reads or writes to FreshRSS's private database schema.

```text
Browser -> public gateway -> web assets + product API
                                      |
                              product SQLite + FTS5
                                      ^
                         authenticated internal job API
                                      |
                               background worker
                                      |
                              FreshRSS GReader API
                                      |
                  native feeds / approved recipes / private RSS gateway
                                                          |
                                               approved service API adapters
```

## Proposed stack, subject to feasibility

RSS is the common collection backbone, not necessarily the upstream protocol.
Proprietary APIs terminate in reviewed adapters that expose scoped RSS to FreshRSS;
they never create a parallel provider-to-product item ingestion path. Share source,
item, capability, identity, health, and workflow contracts across source types.
See [unified pipeline](20-unified-source-pipeline.md) and
[identity/admin boundaries](21-identity-and-administration.md). The gateway is a
logical package boundary, not a commitment to another always-on service container.
It requires a dedicated authenticated internal listener/port exposing only feed
routes, never product/worker/admin routes or public proxy routing. Engine egress
exceptions target that listener, not a shared product API port.

TypeScript monorepo; React + Vite for web; TanStack Router/Query for routing and
server state; a small Node HTTP API with runtime validation; SQLite + FTS5 for the
single-owner product store. Select the HTTP library, database driver, migration
tool, UI primitives, and dependency versions after the integration spike. Do not
install a speculative dependency stack just to make directories look complete.

Single-owner delivery does not mean global ownership-free tables. Scope objects,
search, jobs, captures, storage usage, and external engine identities from the first
schema. The official hosted service is a planned deployment of this product, not
a separate fork. Its database and engine topology require an isolation/capacity
spike; SQLite is the self-host proposal, not a proven multi-tenant hosting choice.

## Ownership and processes

- Web uses the product API only; no FreshRSS credentials or generic proxy endpoint.
- API is the sole product-database writer, including search and membership transactions.
- Worker leases jobs and submits batches through a private authenticated API; it
  does not mount or independently mutate the product database.
- FreshRSS owns fetch scheduling and upstream records. Worker owns product sync,
  capture jobs, and retries, not a second implementation of native feed collection.
- Connection secrets are available only to the server processes that require them.

Internal job authentication, bounded batches, lease expiry, idempotency keys, and
transactional checkpoint advancement are required before multiple processes ship.
The first spike may run jobs in-process with the API if that is simpler, but must
preserve these ownership boundaries and document the chosen packaging.

## Persistent responsibilities

Product database: owners/workspaces, sources/subscriptions, items, external mappings,
captures, memberships, state revisions, view/query definitions, job leases, outbox,
and sync checkpoints. FreshRSS volume: upstream users/configuration/entries. Secret
material is separate from plaintext database values; content capture files, if
introduced, live in a dedicated backed-up store with recorded references.

Account usage is a product ledger, not a claim to attribute SQLite pages per user.
Server disk measurement includes upstream FreshRSS storage and shared overhead.
Keep entitlements independent of payment integration. See [storage](17-storage-and-ownership.md)
and [hosted deployment](18-hosted-service.md).

## Not yet implementation

There is no claimed schema, API, queue, search index, or running deployment in the
scaffold. The package READMEs designate responsibilities, not implemented interfaces.
