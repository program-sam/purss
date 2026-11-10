# FreshRSS capability matrix

Engine: FreshRSS **1.30.4**, image `docker.io/freshrss/freshrss@sha256:a003730e81c89abf86c3ca9c8b263c818804734b574469d59586234364f425b0`
(PHP 8.4.27, Apache 2.4.69, SQLite), started rootless with podman 5.8 by `scripts/engine.ts`. Source read for this document is the
source inside that image (`/var/www/FreshRSS`), which matches upstream `08f97bd497ace733c151ea1c709d85cd5b65cc53` where the plan cites it.

Each row says how it is known. **Observed** = a request/response against the running container, repeatable with the named contract test
(`tests/engine/engine.test.ts`, run `npm run test:engine`). **Source** = read in the pinned source and not (yet) demonstrated.
Real feeds were not used: all feeds in the tests are served by a local server and fetched through a recording test proxy, so
statements about real-world feeds (what a given publisher puts in `<guid>`) are out of scope.

## Summary

| Capability | Status |
| --- | --- |
| Install + API user provisioning, idempotent, resumable | Works. Docker first-run variables + FreshRSS CLI. |
| Subscribe / unsubscribe / rename / list | Works through the GReader API. Unsubscribing an unknown stream is a 400; renaming one is silently accepted. |
| Paged reading of the stream with continuation | Works; oldest-first is stable and resumable. |
| Incremental sync lower bound | Works: `ot` returns new **and modified** entries. Needs an overlap window (see below). |
| Edited entries | Same engine id and crawl time, new content; reappear through `ot`. Not marked unread by default. |
| Late-arriving entries | Get a new id at crawl time, so they appear after the walk position. |
| Original GUID | **Not in the GReader stream.** Available only through the engine's own export CLI. |
| Deletion / purge visibility | **None.** Entries just stop appearing; no tombstones, no enumeration. |
| Read / star mirroring | Works, per entry id, both directions of the flag. Read state does not affect what the stream offers. |
| Scheduled refresh | Works through the container's cron. |
| All fetches through an egress proxy | Works through global `curl_options`; fails closed when the proxy is down. |
| Stable engine identity through the API | **Not available.** Derived through the administration channel from the instance salt. |

Nothing the plan needs is missing from the pinned version; the two real limits are "no GUID in the stream" and "no deletion signal".

## Provisioning and recovery

| Item | Result | Evidence |
| --- | --- | --- |
| First install via Docker variables | `FRESHRSS_INSTALL` runs `cli/do-install.php`, `FRESHRSS_USER` runs `cli/create-user.php`. The entrypoint runs both on every start; they exit 3 ("already exists") when there is nothing to do, so a restart never reinstalls. | Observed: `node scripts/engine.ts up` twice; second run `healthy`, no container recreation. Unit: `lifecycle.test.ts` |
| Interrupted install | `do-install.php` refuses only when `data/applied_migrations.txt` exists, and writes that file last, so a half-done install is simply redone; user creation is skipped when the user directory has a `config.php`. `up` verifies the operator login afterwards, restarts the container once when the user is missing (the entrypoint re-runs user creation) and, if the user exists but cannot log in, resets its API password. A user directory that exists but is corrupt is reported, not repaired. | Observed (`tests/engine/resume.test.ts`): (1) install finished, user never created → `up` creates it, same salt, same credentials; (2) install marker deleted before any user existed → install redone, healthy; (3) operator user directory removed from a stopped engine → recreated at the next start, a second user untouched, same identity; (4) `up` three times → same container id. A crash *inside* `create-user.php` was not induced. |
| Changing settings without a new volume | `config.php` is edited in place for the proxy keys (`applyEgressConfig`); container-level settings (port, cron) recreate the container only. FreshRSS reads `config.custom.php` and `config-user.custom.php` **only when it installs / creates a user**, so those files cannot change existing installs. | Observed: `data/engine/config.php` contains the proxy keys written from `config.custom.php`; drift correction by `applyEgressConfig`. |
| API-only users | `create-user.php --no-default-feeds --api-password=…` with no `--password`: the web password hash is empty (no web login) and no default feeds are fetched. | Observed: `passwordHash` is `''`, `apiPasswordHash` set, subscription list empty. Test: "engine users have no web password and no default feeds" |
| API password rotation | `update-user.php --api-password=…` takes effect immediately; the old password and the previously issued `Auth` value stop working. | Test: "rotating an API password…" |
| Operator CLI exit codes | `create-user.php` exits 3 when the user exists. `actualize-user.php` exits 1 when no feed was due (not an error). | Observed (probe) |
| Container user mapping | `--userns keep-id:uid=33,gid=33 --user 0:0`: the host user is `www-data` inside, so files Apache writes belong to the host user. Files written by the entrypoint (root) appear as a subordinate uid with the host user's group and group write access; `podman unshare rm -rf` removes them. | Observed: `ls -l data/engine` |

## Authentication and API surface

| Item | Result | Evidence |
| --- | --- | --- |
| ClientLogin | `POST /api/greader.php/accounts/ClientLogin` with `Email`, `Passwd`; returns `SID`, `LSID`, `Auth`. Wrong password or unknown user: 401. The `Auth` value is `user/sha1(salt + user + apiPasswordHash)`, so it changes when the API password changes and is otherwise stable. | Observed |
| Action token | `GET /reader/api/0/token` returns a 57-character token derived the same way (not time limited). Needed as `T` for edit-tag. | Observed (edit-tag works with it) |
| Idle connections | Apache closes idle keep-alive connections; a request landing on a just-closed one fails with "socket closed". The client retries once on a fresh connection. | Observed once in probing; client behaviour in `greader.test.ts` is simulated |
| Request limits | `n` (page size) honoured as given; the adapter asks for at most 500. | Observed with 5 and 7; larger pages not exercised (tests use ≤ 25 entries) |

## Streams, paging and incremental sync

| Item | Result | Evidence |
| --- | --- | --- |
| Entry id | Decimal, first-crawl (insert) time in microseconds, unique per user; entries inserted by one refresh get consecutive ids. `timestampUsec` in the stream is the same number; `crawlTimeMsec` is that divided by 1000. The hex form in `id` (`tag:google.com,2005:reader/item/<16 hex>`) is the same number. edit-tag accepts the decimal. | Observed: "stream entries map to the SyncEntry contract…" |
| Paging | `GET /stream/contents/user/-/state/com.google/reading-list?n=<N>&r=o&c=<token>`: `continuation` is the id of the last item on the page and is returned whenever the page is full. The token is **inclusive**: the engine fetches `n+1` starting at it and discards the first row. A full last page yields one more empty request. | Observed: "paging with continuation walks every entry exactly once…" (25 entries, pages 7/7/7/4) |
| One feed's items | `GET /stream/contents/feed/<id>?n=1` lists only that subscription's items. Right after `subscription/quickadd` it already holds what the feed had (the engine fetches the feed when it adds it): a feed with items answers with one, an empty feed with none. The worker asks this once after a subscribe, so a source can say "No posts yet" on the engine's word instead of a guess. | Observed by a manual request (2026-11-06) against a feed with posts and one with none; fake-engine test in `greader.test.ts` |
| Order | `r=o` ascending by id (crawl order); default is descending. Ascending is the only order a forward-resumable walk can use. | Observed |
| Lower bound | `ot=<unix seconds>` returns entries with `id ≥ ot·10⁶` **or** `lastModified ≥ ot`. An entry whose content changed after `ot` is therefore returned even though its id is old; an unchanged old entry is not. `lastModified` itself is not exposed. | Observed (probe): after creating three entries and editing one four seconds later, `ot` between the two returned exactly the edited entry and the one new entry |
| `items/ids` | Id-only listing with the same continuation rule. The adapter has no method for it and sync does not use it. | Observed by a manual request |
| Page-boundary quirk | Because the first row after the token is discarded without looking at it, an entry deleted by retention between two pages exactly at the token would cost the following entry. | Source only; not provoked. Mitigated only by the overlap window of later passes. |
| Late arrivals | A feed item with an old publication date that the engine only now sees gets a **new id** (crawl time) and appears after the current walk position, so a forward walk finds it. Publication time is not a usable high-water mark and is never used as one. | Observed: "a late-arriving old article gets a new engine id…" |
| Visibility lag | Entries are stamped when staged and visible when the refresh run commits them (`commitNewEntries`). A pass that started in between can see a newer entry before an older one. The adapter re-reads from `newest − 3600 s`; duplicates are absorbed by batch idempotency. Not demonstrated with a long refresh run. | Source + design; overlap window covered by `sync.test.ts` |
| Hidden feeds | Feeds with priority "hidden" are excluded from the reading list. The product never creates them. | Source |
| Content field | `summary.content` (compat mode) carries the single stored content, truncated at 500 000 bytes, with the engine's own `<figure class="enclosure">` markup (audio/video/thumbnail) appended. There is no separate summary field. | Observed |
| Title/author fidelity | In this stream `&`, `<`, `>` in title and author are replaced by `＆ ＜ ＞` (fullwidth) and quotes are untouched; the adapter maps those three back. A title that genuinely contains a fullwidth ampersand is indistinguishable. | Observed: `Q＆A ＜t＞` |
| Enclosures | `enclosure[]` with `href`, `type`, `length`. | Observed |
| Original GUID | Absent from `stream/contents` (compat output; the `freshrss` output mode that has `guid` and `origin.feedUrl` is not reachable by any request parameter). **Present in the engine's own export**: `php cli/export-zip-for-user.php --user=<u> --max-feed-entries=<n>` writes a zip whose `feed_*.json` items carry `guid`, `origin.feedUrl` and `frss:id`, where `frss:id` is exactly the decimal id the stream gives. So GUID ↔ `externalId` can be joined per user, at the cost of a bulk export. Not wired into sync (no consumer in the job contract; the output is binary). | Observed: "the original GUID is obtainable only through the engine's own export…" |

## Edits, removal and retention

| Item | Result | Evidence |
| --- | --- | --- |
| Edited entry | The feed's GUID is the engine's identity for an entry within a feed. When the content hash changes the row is updated in place: same id, same crawl time, new title/content, `lastModified` bumped. It is **not** marked unread (`mark_updated_article_unread` is false by default) and an already-read entry stays read. | Observed (probe + test "an entry edited upstream…") |
| Entry removed from the upstream feed | Stays in the engine (until retention removes it). | Observed: "upstream removal of an article does not remove it…" |
| Unsubscribe | Deletes the feed and all its entries from the engine at once; they vanish from the stream with no signal. | Observed: "unsubscribing makes the entries disappear…" |
| Re-subscribe | New stream id and **new entry ids** for the same articles; nothing links them to the old ones except URL/content (the GUID is only in the export). The product must match by content, not by id. | Observed |
| Deletion visibility | The API cannot enumerate deletions. The sync therefore never concludes a deletion from absence, and the sync contract has no way to express one. | Observed + design |
| Retention policy | `config-user.custom.php` before user creation sets `archiving` (`keep_period P90D`, `keep_max 1000`, `keep_min 50`, no favourite/label/unread exemption) and `ttl_default 900`; new users inherit it. The purge rule (source): an entry is removed only if it is not among the newest `keep_min` by last-seen, was last seen before the feed's latest refresh, and is older than `keep_period` **or** beyond `keep_max`. Last-seen is updated while the feed still lists the entry, so the period applies to entries the feed has dropped. | Observed: effective values read back from the user's `config.php`. Purge itself not demonstrated. |
| Coverage after an outage | Resuming sync only proves nothing newer is missing. Entries purged by the engine during an outage longer than `keep_period`, or by `keep_max` between syncs, are unrecoverable and invisible. | Source; surfaced as a documented limit |

## Read, star

| Item | Result | Evidence |
| --- | --- | --- |
| Mark read / unread | `POST /reader/api/0/edit-tag` with `T`, repeated `i` (decimal ids), `a=` / `r=user/-/state/com.google/read`. Unknown ids are accepted silently (`OK`). Reflected in `unread-count` and in the stream filter `xt=user/-/state/com.google/read`. | Observed: "marking read and unread is reflected…" |
| Star | Same call with `…/starred`; shows in the item's `categories`; independent of read. | Observed |
| Effect on sync | None: read items are still offered by `stream/contents` (the product owns reading state). The product's mirroring is one-way (product → engine) via the `engine.mark_read` job. | Observed: "read state does not influence what sync offers" |
| Labels | Basket membership is never mirrored to labels or stars. | Design |

## Egress

| Item | Result | Evidence |
| --- | --- | --- |
| Mechanism | `curl_options` in `data/config.php` (`CURLOPT_PROXYTYPE`=`CURLPROXY_HTTP`, `CURLOPT_PROXY`=`ip:port`). Used by feed fetching (SimplePie), quick-add discovery, favicons and website fetching. Per-feed overrides exist only through the trusted OPML import. | Source; Observed that the feed, the homepage and `favicon.ico` requests all reached the proxy |
| Engine's own SSRF guard | With a proxy configured the engine does **not** resolve the target; it checks the proxy's address against `internal_host_allowlist` (`ip:port` or CIDR; `*` disables all checks). The product allows only the proxy's `ip:port`. The proxy name is resolved with DNS only, so it must be an IPv4 literal. | Source; observed that the loopback test feed was fetched (by the proxy) and the proxy's address was the only allowlist entry in `config.php`. Fetching without a proxy was not tried. |
| Proxy down | The fetch fails (`cURL error 7`) and nothing is fetched directly; the feed server saw no request. | Observed: "with the proxy down, fetching fails…" |
| Proxy refuses a host | The engine reports HTTP 403 for the feed; there is no fallback. | Observed: "a host the proxy refuses is not fetched…" |
| HTTPS | Goes through `CONNECT`; the test proxy refuses `CONNECT`, so HTTPS targets are not exercised here. `apps/egress` must support it. | Not tested |
| Container network | With pasta, host loopback is reachable from the container only at the address given to `--map-host-loopback` (`169.254.1.2`); the default mapping does not reach loopback-only listeners. The container can address every host-loopback port at that address, which the engine configuration above prevents FreshRSS from doing; a Compose deployment needs an internal network for real isolation. | Observed |

## Scheduling

| Item | Result | Evidence |
| --- | --- | --- |
| Cron | `CRON_MIN` becomes the minute field of the container crontab, which runs `actualize_script.php` as `www-data` through `su`. A feed is due after its `ttl` (default from `ttl_default`). The engine also caches fetched documents in `data/cache` for at least 60 s regardless of response headers; `actualize-user.php` without `--feed-id` only refreshes feeds that are due, so tests drop the cache and name the feed to force a re-fetch. | Observed: with `CRON_MIN=*` and `ttl_default=60` a new article appeared in the stream about 90 s later with no API or CLI call (test "the engine's own scheduler refreshes feeds…") |

## Identity

| Item | Result |
| --- | --- |
| Engine instance identity | The API exposes nothing instance-specific. `config.php` holds a random `salt` generated once at install; `freshrss:` + 32 hex of `sha256("purss-engine-identity:1:" + salt)` is computed inside the container. Same across restarts and restores of the same data; different for a new install (tested with two instances). |
| External id | Decimal entry id, per engine user. Meaningless in another engine. |
| Product-side consequence | A checkpoint stored with a different `engineIdentity` is ignored by the adapter and the whole history is offered again for reconciliation; with no GUID in the stream, matching old to new items relies on URL and content, or on the export above. |
