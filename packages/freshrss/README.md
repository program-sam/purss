# FreshRSS adapter boundary

Everything the product knows about FreshRSS lives here. The engine stays a black box: no direct database access, no UI scraping.

| Module | Purpose |
| --- | --- |
| `greader.ts` | typed client of the GReader API: ClientLogin, token, user-info, subscription list, quick-add, unsubscribe, rename, reading-list pages (continuation, lower bound), read/unread and star through edit-tag, unread count |
| `normalize.ts` | stream item → `SyncEntry` (`@purss/domain`); restores `& < >`, clamps fields to the contract, never invents a GUID |
| `sync.ts` | forward, resumable, replay-safe walk with deterministic batch idempotency keys; engine-identity check |
| `admin.ts` | fixed engine administration through `PURSS_ENGINE_EXEC` with structured arguments only (create user, set API password, list users, delete user, refresh, identity hash, archiving read, proxy config) |
| `lifecycle.ts` | podman lifecycle of the pinned engine container used by `scripts/engine.ts` (operator tooling; the worker does not use it) |
| `errors.ts`, `redact.ts` | errors whose messages are always safe to store, and text redaction |
| `testing/fake-engine.ts` | in-memory GReader stand-in used by unit tests only |

## Engine identity

`EngineAdmin.engineIdentity()` returns `freshrss:` + the first 32 hex characters of `sha256("purss-engine-identity:1:" + salt)`, computed
inside the container from the instance `salt` in FreshRSS's `config.php`. FreshRSS generates the salt once at install time, so the
identity survives restarts, image upgrades and restoring the same data directory, and it changes for a fresh or replacement install,
which is exactly when the product must reconcile instead of continuing a checkpoint. The salt never leaves the container. The GReader
API exposes nothing instance-specific, which is why the identity is read through the administration channel.

External item ids are decimal engine entry ids (first-crawl time in microseconds), unique per engine user and meaningless anywhere else.
They are not GUIDs, and the original feed GUID is not available from the standard stream (see CAPABILITIES.md).

Capabilities observed against the pinned engine, with commands and results: [CAPABILITIES.md](CAPABILITIES.md).
Operations: [infra/engine/README.md](../../infra/engine/README.md). Requirements: [plan/06](../../plan/06-freshrss-integration.md).
