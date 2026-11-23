# FreshRSS adapter boundary

Everything the product knows about FreshRSS lives here. The engine stays a black box: no direct database access, no UI scraping.

| Module | Purpose |
| --- | --- |
| `greader.ts` | typed client of the GReader API: ClientLogin, token, user-info, subscription list, quick-add, unsubscribe, rename, reading-list pages (continuation, lower bound), read/unread through edit-tag, unread count |
| `normalize.ts` | stream item → `SyncEntry` (`@purss/domain`); restores `& < >`, clamps fields to the contract, never invents a GUID |
| `sync.ts` | forward, resumable, replay-safe walk with deterministic batch idempotency keys; engine-identity check |
| `admin.ts` | fixed engine administration through `PURSS_ENGINE_EXEC` with structured arguments only (create user, set API password, list users, delete user, refresh, identity hash, archiving read, proxy and fetch-cache config) |
| `allowlist.ts` | the CLI scripts and snippet hashes the engine image's admin helper accepts: exactly the operations in `admin.ts` |
| `lifecycle.ts` | podman lifecycle of the pinned engine container used by `scripts/engine.ts` (administrator tooling; the worker does not use it) |
| `errors.ts`, `redact.ts` | errors whose messages are always safe to store, and text redaction |
| `testing/fake-engine.ts` | in-memory GReader stand-in used by unit tests only |

## Invariants

- **One engine user per account.** Each product account has its own FreshRSS user, created through the
  engine's CLI with an API password only (no web password, no default feeds). No two accounts' feeds share an
  upstream user.
- **Subscriptions are single addresses.** The adapter adds one address at a time through quick-add and
  never uses the engine's OPML import: the engine treats imported OPML as trusted, and that is its only
  route to per-feed options. A person's OPML is parsed and previewed by `@purss/connectors` and each chosen
  feed is looked up and added as a plain address. Nothing forwards options a person supplies or arbitrary cURL
  settings to the engine. The engine's `#force_feed` marker is added only for an address the product's own
  parser has already read as a feed.
- **Fixed administration.** The operations in `admin.ts` are constant programs with structured arguments
  handed to `execFile`: no shell, and no caller text is interpreted as a command. The engine image's admin
  helper accepts exactly these (`allowlist.ts`).
- **All fetches go through egress.** `curl_options` points every engine fetch at the egress proxy and
  `internal_host_allowlist` holds only that proxy, so the engine fetches nothing directly. The engine's
  minimum fetch-cache time is set to 800 seconds (`limits.cache_duration_min`), so the accounts that follow
  one feed share a single request per refresh run even when the feed sends `no-cache`.
- **Sync never infers a deletion.** The engine's API cannot enumerate deletions and its entries just stop
  appearing, so absence from the stream proves nothing and the sync contract has no way to say "deleted".
  Entries edited upstream reappear through the lower bound (`ot`) with the same id; entries that appear late get
  an id at crawl time and are found after the walk position. Each page is submitted with its own checkpoint and
  deterministic idempotency keys, so a crash re-reads at most the uncommitted page and a replay is a no-op, and
  the lower bound is taken an hour (`overlapSeconds`) behind the newest entry because entries become visible
  when a refresh run commits, not when they are stamped.
- **Engine identity before checkpoint.** A saved checkpoint is used only for the engine that made it. A
  different identity (a restored or replaced install) starts the walk over, and the API holds what arrives for
  review instead of adding it.

## Upstream retention

Every engine user gets an archiving policy of 90 days, at most 1,000 and at least 50 entries per feed, with no
exemption for favourites, labels or unread entries (`DEFAULT_ARCHIVING`, written by `lifecycle.ts` before a user
is created). FreshRSS purges by it on its own, with no signal. Resuming the sync after an outage only proves that
nothing newer is missing: entries purged during an outage longer than 90 days, or beyond 1,000 between syncs, are
unrecoverable and invisible. The product therefore warns when items stop arriving, says that a longer gap cannot
be filled in, and never claims that everything a feed published was captured. A feed also shows only what its
publisher includes, usually the latest items.

## Engine identity

`EngineAdmin.engineIdentity()` returns `freshrss:` + the first 32 hex characters of `sha256("purss-engine-identity:1:" + salt)`, computed
inside the container from the instance `salt` in FreshRSS's `config.php`. FreshRSS generates the salt once at install time, so the
identity survives restarts, image upgrades and restoring the same data directory, and it changes for a fresh or replacement install,
which is exactly when the product must reconcile instead of continuing a checkpoint. The salt never leaves the container. The GReader
API exposes nothing instance-specific, which is why the identity is read through the administration channel.

External item ids are decimal engine entry ids (first-crawl time in microseconds), unique per engine user and meaningless anywhere else.
They are not GUIDs, and the original feed GUID is not available from the standard stream; subscribing the same feed again gives its
articles different ids (see CAPABILITIES.md). The component map is in [architecture](../../docs/architecture.md#components).

Capabilities observed against the pinned engine, with commands and results: [CAPABILITIES.md](CAPABILITIES.md).
Operations: [infra/engine/README.md](../../infra/engine/README.md). How a source reaches the engine: [Sources](../../docs/sources.md).
