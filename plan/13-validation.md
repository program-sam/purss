# Validation and acceptance

## What can be checked now

The dependency-free repository checker validates workspace manifests, required plan
files, and local Markdown link destinations. Its tests exercise validation errors.
This is not evidence that sync, retention, UI, security, or deployment works.

## Representative real sources

Use owner-selected journal issue and online-first feeds, an ordinary blog, a
YouTube channel feed, a podcast, and a source with sparse/missing metadata. Include
different feed sizes and publication frequencies. Record examples and observation
time without checking personal reading data into Git. Real network fixtures can
be sanitized and minimized with permission; synthetic fixtures supplement them.

## Acceptance matrix for implementation

| Area | Required checks |
| --- | --- |
| Discovery | Direct feed, alternate links, multiple candidates, unsupported URL, redirects, duplicate source, YouTube ambiguity |
| Unified source pipeline | API adapter -> private RSS -> pinned FreshRSS -> existing product sync, no direct writes, stable IDs across token rotation, principal changes, tenant cache/feed isolation, cursor crash/replay, concurrent refresh, window overflow/missed poll, acknowledgment after durable commit over authenticated control path, pagination/backfill limits, gateway auth/rotation and isolated listener, revoked grants and immutable kept snapshots, enforced emitted-content limits, failed provider refresh versus authorized staged delivery, upstream outage beyond staging time bound, bounded staging/backlog/storage, unknown secret-link detection/redaction, secret-free export/provenance and reconnect restore |
| Sign-in and source grants | Separate consent/session/grant lifecycles, OIDC issuer/subject identity, code/PKCE/state/nonce/redirect validation, no email auto-link/admin elevation, concurrent refresh/expiry/revocation, last-login-method protection, provider outage/lost-device/origin-change recovery, self-host client registration with no bundled confidential secret/central relay, signup recovery enrollment and denied insufficient proof |
| Administration | Protected bootstrap, nonadmin direct API denial, service-account limits, explicit role grant/revoke, last-admin recovery, recent strong auth, audit success/failure, bounded retry/cancel, private-content/secret redaction, hosted signup never admin, no unrestricted impersonation or direct identity rebinding, audited/delayed/notified recovery policy, self-host single-owner scope |
| Sync | Pagination, restart mid-batch, replay, upstream edits, late publications, expired token, purge, deleted source, outage beyond upstream time/count retention and visible possible-gap warning; batches sized in UTF-8 bytes (Arabic/CJK pages stay under the internal body limit), an entry too large to send keeps its details and summary and says its full text was left out, one feed never blocks an account's sync; a sync that fails for good shows a plain-language reason on Home and waits 1, 5, 15, then 60 minutes between runs; a site's 429/503 at subscribe is retried after 1, 5 and 30 minutes, then the source says so and can be retried by hand; accounts that follow one public feed (even at the same moment) cost one upstream request, while private links are never shared and each account keeps only its own items |
| Identity | Same numeric external ID in different accounts/engines; reused URLs; distinct article versions; replacement-engine reconciliation without duplicate items, with and without original GUID access |
| Baskets | Multi-basket item, last membership removal, snapshot failure, source purge, offline restore, disk full |
| Workflow | Two-tab conflict, bulk move, undo, read/finished independence, ignored item recoverability |
| Queries | Full-dataset text/state combinations, stable pagination, missing fields, workspace isolation |
| UI | Desktop/mobile, keyboard-only, screen-reader labels, light/dark, reduced motion, error/loading states |
| Interaction clarity | First-time users predict and complete Follow, Keep, view switching, and workflow changes without a walkthrough; concise labels, clear feedback, touch/keyboard access, no icon/color/hover-only meaning, essential publish/delete/privacy consequences still visible |
| Freshness and notifications | New-arrival highlights independent of workflow/read state, optional counts, permission denied, mute/quiet hours, overlap deduplication, sensitive-preview defaults, delayed polling and unavailable delivery channels |
| Rediscovery and preferences | Accurate recorded keep/action date, absent history, timezone/leap day, restart deduplication, hide/snooze/off, ignored/deleted/private exclusions, no state reset or extra capture, common/advanced effective values and reset, operator-only setting isolation |
| Fetching | Private-address redirects, rebinding, oversized/compressed payloads, timeout, malicious HTML, rate limiting; both product discovery and FreshRSS/bridge fetching, including a followed feed later redirecting to loopback, metadata IPs, or internal service names |
| Operations | Partial install, double startup, stale lease, graceful shutdown, backup with WAL, restore, failed migration |
| Privacy | No secret in browser/log/export, no automatic public feed, no unsolicited third-party embed |
| Storage | Byte/category totals, multi-basket references, extra snapshots, failed/cancelled jobs, concurrent admission, reservation replay/expiry, quota warning, full disk, delayed reclamation, over-limit import/restore, bounded state headroom at full quota, quota-exempt deletion |
| Smart filters | Off by default; preview changes no post; dropped posts become Ignored through the person's own path (log, read mirror, state version), never opened/kept/moved ones; the person's change is final; stale filter versions ignored; looser words give back only untouched posts; drops never announced, unjudged posts announced; refused key, no key, cap reached and final job failure fail open; no personal key route, only an administrator sets the server key; Pro on hosted, every account self-hosted; cross-workspace scope denied; key never shown, exported or logged |
| Hosted accounts | Cross-account item/search/object/engine/job/export isolation, free allowance, fair work budgets, capacity reduction, account recovery/deletion, full-account export and self-host migration |
| Sharing (Gate 7) | Review of the page and of what becomes public before sharing, live membership from the basket or collection, filters without reading-state rules, Plus on hosted installations, chosen public attribution, follower privacy/log policy, private-source/query/state/capture exclusion, external RSS/Atom reader, cross-install follow/unfollow, source-bundle consent (when introduced), overlap/replay identity, bounded history, edits/removals, unpublish and cache limits, subscriber keeps, quotas and abuse limits |

Use unit tests for domain transitions and parsing, adapter contract tests against
the pinned engine, real SQLite integration tests for transactions/search, and
browser tests for user flows. A mock passing is not proof of engine compatibility.

## Performance and resource discipline

Agree dataset size and task latency expectations during the spike. Measure cold/warm
search, scrolling, initial import, memory, and background load on the actual host.
Use bounded concurrency; the shared host has limited RAM. No invented throughput
claims or long-running test infrastructure left idle after validation.

### Size gate

A defect that costs nothing on a test database can stop a whole host once an account is
large: an unindexed lookup in the storage summary made `/api/bootstrap` take 79 s at 7,500
items and stalled the API and worker for everyone. Two datasets are therefore part of
acceptance, built by `node scripts/dataset.ts` through the product's own code (sync batches
that follow the back-catalogue and settling rules, Keep, bulk state changes, captures,
notifications) in a throwaway data directory:

| Dataset | Build | Gate on the reference host |
| --- | --- | --- |
| One large account | `node scripts/dataset.ts` (1 account, 300 sources, 100,000 items; about 2% New, 2% Ignored, 10% in other workflow states, 1.5% kept) | `GET /api/bootstrap` under 300 ms; item pages (`GET /api/items`, 50 per page, first page with its total, in the default order and in title order, for everything, New, To read, a collection, a source) under 150 ms |
| A busy host | `node scripts/dataset.ts --accounts 20` (20 such accounts, about 2 million items) | The same two figures for every account while the others hold their data; the API and worker stay responsive during a sync pass |

Measure with the app serving the dataset, with a write between requests (so nothing is
served from a reused count) and without, warm and cold, interleaved with the previous
version when comparing, and record the host and the numbers. The listing and count queries
are guarded in `apps/api/src/services/performance.test.ts`: no query behind bootstrap or the
sync path may read a whole table to find rows, the counts, the storage split and the
default and title orders must plan as designed (partial index, covering index, ordered index
read), and a generated 20,000-item account must stay well under a second. Counts, totals and
the storage split are compared with the queries they replaced in `counts.test.ts` and
`storage-split.test.ts`, with random operations.

## Release proof

Record actual commands, observed outcomes, unsupported cases, and unresolved risks.
Do not label the product ready based on scaffold checks or an author's fixture tests.
Owner approval is required before pushing, merging, exposing services, or releasing.
