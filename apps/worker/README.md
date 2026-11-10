# Worker

Background process that leases jobs from the API's internal listener, talks to the FreshRSS engine, and posts results back.
It never opens the product database: the API is the only writer and commits each sync batch together with its checkpoint.

```sh
node apps/worker/src/main.ts
```

| Setting | Default |
| --- | --- |
| `PURSS_INTERNAL_URL` | `http://127.0.0.1:8948` |
| service token | `data/secrets/service-token` (`PURSS_DATA_DIR` moves `data/`); read on demand, re-read after a 401 |
| `PURSS_ENGINE_ADMIN_URL` | unset; under Compose `http://engine/purss/admin.php`, the engine image's token-protected helper for the fixed administration commands |
| `PURSS_ENGINE_EXEC` | `podman exec --user www-data purss-freshrss`, used when `PURSS_ENGINE_ADMIN_URL` is unset (development) |
| `PURSS_WORKER_CONCURRENCY` | 4 jobs at a time |
| `PURSS_WORKER_POLL_MS` / `PURSS_WORKER_MAX_BACKOFF_MS` | 2000 / 60000 |
| `PURSS_WORKER_DRAIN_MS` | 25000 |
| `PURSS_SYNC_PAGE_SIZE` / `PURSS_SYNC_OVERLAP_SECONDS` / `PURSS_SYNC_MAX_BATCH_BYTES` | 200 (max 500) / 3600 / 700000 |

Engine user API passwords live in `data/secrets/engine-users/<engineUserId>` (0600). The worker writes a file when it provisions that
user, before the engine learns the password, and reads it for every other job; the API never reads these files. The engine address
comes from the API (`GET /internal/engine-users/:id`), not from worker configuration.

## Jobs

| Kind | What it does | Result |
| --- | --- | --- |
| `engine.provision` | stores a credential, creates the engine user (or resets its API password when it exists), logs in, reads the engine identity | `{engineUserId, username, engineIdentity, created}` |
| `engine.subscribe` | quick-adds the feed; if the engine already has it, returns the existing stream | `{streamId, title, alreadySubscribed}` (title is the engine's discovered title; renaming is `engine.rename`) |
| `engine.unsubscribe` | removes the subscription; an already-missing stream is success | `{streamId, removed}` |
| `engine.rename` | renames the subscription; an unknown stream is a permanent failure | `{streamId, title}` |
| `engine.sync` | walks the reading list forward from the stored checkpoint, one page per batch | `{pages, entries, accepted, duplicates, identityChanged, newestCrawlUsec}` |
| `engine.mark_read` | mirrors read/unread into the engine | `{count, read}` |
| `capture.fulltext` | runs `captureReadable(url)` from `@purss/connectors` | its result object; `ok:false` fails permanently |
| `capture.images` | runs `fetchPictures(urls, { maxBytes })` from `@purss/connectors` for one kept item | `{ images: [{ url, contentType, data (base64) }] }`, the ones that could be fetched |
| `source.icon` | runs `resolveSourceIcon` from `@purss/connectors/icons`, one lookup at a time | `{found: true, data (base64 WebP), width, from}` or `{found: false, reasons}`; finding nothing is not a failure |
| `engine.delete_user` | the engine step of an account deletion: records an attempt with the API, runs `delete-user.php`, confirms with `list-users.php`, deletes the stored password, asks the API to finalize | none: the API's finalize (or review) call settles the job |

`engine.delete_user` takes an engine user that is missing on the first look as never created (or removed by hand) only when the API
has no removal attempt on record; missing after an unconfirmed attempt, it asks the API to open a review that an administrator
resolves. While an account is suspended or being deleted, its other jobs answer `lease_lost` and wait in the API's queue.

`capture.fulltext` calls `captureReadable` from `@purss/connectors` (safe fetch, readability, sanitizer); a refusal (`ok:false`) is reported
as a permanent failure with the connector's reason and plain-language message.

### Sync

Pages are requested oldest-first with `r=o`, a continuation token, and, once a checkpoint exists, `ot` = newest crawl time minus the
overlap. Each page is posted as one `syncBatchSchema` batch (split into several parts when its entries exceed `PURSS_SYNC_MAX_BATCH_BYTES`; only the
last part advances the checkpoint) whose checkpoint (`continuation`, `newestCrawlUsec`) the API commits atomically with the entries. The idempotency key is derived from the page's coordinates and content, so a retry of the same page is a
no-op, an edited entry yields a different key, and a crash resumes from the stored continuation. A stored checkpoint whose
`engineIdentity` differs from the engine's current identity is ignored and the whole history is offered again for the product's
reconciliation. Absence of an entry never produces a deletion. Details and observed behaviour: `packages/freshrss/CAPABILITIES.md`.

## Behaviour

- Leases up to `concurrency - running` jobs per request; jobs for the same engine user run one at a time.
- Heartbeats each running job at a third of its lease time. A heartbeat answered with 404/409/410, or a lease that could not be renewed
  before it expired, aborts the job and reports nothing (the API owns what happens next).
- Success: `complete` with the handler's result, unless the handler's last API call already settled the job (`engine.delete_user`). Failure: `fail` with a redacted message and `retryable`. Network, 5xx, rate limits,
  timeouts and unexpected errors are retryable; rejected credentials, rejected feeds, bad payloads, unknown kinds and missing records are not.
- Lease errors back off exponentially with jitter up to `PURSS_WORKER_MAX_BACKOFF_MS`.
- `SIGTERM`/`SIGINT`: stop leasing, let running jobs finish for `PURSS_WORKER_DRAIN_MS`, then interrupt the rest and release them as retryable.
  A second signal exits immediately.
- Logs are JSON lines; messages and string fields are redacted (tokens, credentials in URLs, query strings, long hex strings). Article
  content and credentials are never logged.
