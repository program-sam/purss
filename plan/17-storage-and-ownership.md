# Storage visibility and self-ownership

## Product intent

Storage should feel like the user's shelf, not an invisible service or a pressure
to subscribe. A compact indicator opens a plain-language breakdown and controls.
It belongs in the first usable slice because ownership and byte accounting should
not be retrofitted after content has accumulated. This is planned behavior only.

## Two different measurements

| Measurement | Audience | Meaning |
| --- | --- | --- |
| Account usage/allocation | Every user, including hosted accounts | Defined logical bytes attributed to this account; pending reservations shown separately |
| Server capacity | Self-host owner or authorized hosted operator | Actual volume/filesystem used/free bytes, limits, and storage components |

Do not equate logical quota with physical disk. Database pages, indexes/WAL,
FreshRSS's copy, caches, backups, filesystem allocation, and shared overhead can
make them differ. Account usage is not a physical per-tenant disk measurement.
The server view identifies measured components and shared/unattributed usage;
never add overlapping path measurements or infer host capacity from a container's
unrelated filesystem. If measurement is unavailable or stale, label it honestly.

## Indicator and management

Show used/allocated storage when an allocation is enforced, or usage with capacity
details when none is set. Include measurement freshness, pending work, a textual
equivalent for the bar, and accessible warnings. Choose warning thresholds during
implementation; do not invent a free size or price in planning.

Expand into Feed-only content, Basket-kept content, and Other account data. Offer
largest items/sources, captures versus metadata, expected release from an action,
and links to implemented management actions. A hosted user cannot inspect another account or the
operator's server. Disk pressure and account quota are different warnings.

Gate 3 includes the indicator, category breakdown, pause/warning behavior, and a
confirmed permanent-deletion path for unkept items or unpinned captures. The full
management page, advanced cleanup previews, account export, and restore arrive in
Gate 4 before hosted signup. Do not present those later controls as available in
the first slice. Gate 3 is a bounded local prototype, not a hosted free-account launch.

Keep the control calm: no upgrade countdown, shame, misleading decimal precision,
or treating a basket as expensive merely because it organizes existing content.
Paid capacity, if offered, is one action beside cleanup/export, not the only exit.

## Logical accounting contract

Meter a documented deterministic representation of persisted account metadata and
content plus the actual byte lengths of stored captures/attachments. Specify fields,
encoding, normalization, and excluded derived indexes/caches before implementation.
Remote media referenced by URL consumes no stored video/audio bytes, and the server stores no audio
or video files ([plan/25](25-media-playback.md)); device downloads in the apps are not account storage.

Classify each stored object once: Basket-kept if any live basket pin retains it;
otherwise Feed-only if a live feed item references it; otherwise Other. Membership and state metadata
are small Other records. One object referenced by several baskets is not duplicated
in the account total. A newly captured full-text snapshot is additional content;
simply adding a second basket membership is not. Explain classification changes
that move bytes between sections without increasing total usage.

Use explicit ownership/reference counts. Cross-account physical deduplication, if
ever adopted, must not reveal other users' content and must not make one account's
allowance depend on another's activity. Each account is charged its documented
logical objects. Do not mutate a pinned historical capture when live content changes.

Keep references a fixed immutable stored content version, copying only when needed
to establish that version. Its minimum snapshot and metadata must pass admission
before success. A later live update creates a separate version only if admitted as
feed growth; when growth is paused, defer the update and retain the pinned version.
After the last basket pin is removed, stored content stays chargeable: a version
still referenced by the live feed item is Feed-only; a historical capture with no
live feed reference is Other. Unpinning alone never deletes it. Only explicit capture
or item deletion, once no other reference requires the object, releases its bytes.

All categories plus Other must sum to the displayed account total; reservations
are shown separately, not misreported as already stored. Backups and engine copies
are operator costs outside this quota unless explicitly disclosed otherwise.
Do not silently change the accounting contract or shrink allowances for existing users.
Other includes chargeable trash or pending-deletion objects, if those features are
introduced. A separate pending-deletion subtotal is informational, not added twice.

## Admission, limits, and deletion

Use a durable usage ledger and reconcile it against actual owned records/objects.
Reserve a bounded amount before growth, enforce actual byte limits while fetching,
and atomically settle usage with the persisted mutation or release failed work.
Lease expiry/restart/replay must not leak reservations or double-charge a job.
Concurrent imports and Keep actions cannot independently spend the same free bytes.

Keeping existing feed data can reuse stored objects, but admission must still cover
new metadata or captures. If storage cannot be committed, fail clearly and leave
existing data unchanged; never report successful preservation before it is durable.
Physical disk reserve can also reject growth even when account quota remains.

Near/full: warn, pause new import/capture growth as needed, preserve reading/search
and existing data, allow the implemented deletion path (and export from Gate 4), and show when ingestion stopped and which
sources may have gaps. Bound FreshRSS's independent backlog too. Resuming cannot
promise to recover articles already absent from source feeds or engine retention.
An account with no automatic pruning eventually fills; say that rather than hiding it.

Use a small, bounded and disclosed control-operation headroom so full-content quota
does not prevent read/progress/workflow updates or an existing item's basket pin.
Track those writes in actual usage and show any resulting over-allocation honestly;
they do not authorize additional content/captures. New baskets, labels, or arbitrary
metadata cannot consume this allowance without bounds. Deletion is never rejected
because account quota is full. Size the physical disk reserve to support these
writes and job recovery; genuine disk failure remains an explicit unavailable state,
not a guarantee that every operation can always succeed.

Cleaning up previews affected objects, pins, and estimated release. Removing one
basket membership may release zero bytes. Logical release occurs only when the last
chargeable reference is actually removed; trash/grace-period data still counts until
purged. Show pending reclamation separately. Physical files, WAL, retained backups,
and database compaction may reclaim space later; never promise instant disk recovery.
Any maintenance that can need temporary disk space must check available headroom.

## Ownership and exit

Reading, export, and moving data to a self-hosted installation must not require a
paid plan. Export jobs use bounded streaming/temporary storage and can run while
an account is full, without adding the entire archive to its quota. Global disk
failure may make work unavailable; explain/retry instead of guaranteeing success.
Import/restore preflights required bytes and capacity; an over-limit restore is
staged or rejected without destroying existing data. Test reference accounting
after restore and index rebuild.

A full-account export includes sources/subscriptions, Feed-only and basket-kept
items, captured content, baskets, memberships, collections, workflow/reading/media progress,
views, identifiers/provenance, and user preferences. Exclude passwords,
active sessions, service keys, source authorization grants, gateway credentials,
secret-link/capability URLs in feeds, item links or enclosures/media (including in
identifiers/provenance and captures), payment
credentials, and private engine database data. Private or uncertain source locations
export as secret-free source references and restore as Reconnect required, never
as automatically active subscriptions. See the
[private-source contract](20-unified-source-pipeline.md).
Private-item export permission does not include credential export; preview the
omitted/redacted access links and reconnection requirements before exporting.
Explain excluded third-party media or unavailable content. A fresh self-hosted
installation restores product data and recreates eligible public subscriptions,
leaving private sources paused until authorized reconnection, then applies the
[replacement-engine reconciliation](02-domain-model.md) before reimporting history.
Upstream mappings in the archive are provenance, not credentials or proof of new
engine continuity. Import into an occupied PURSS needs explicit conflict handling.

## Required proof

Meter shared references, changed content, metadata-only records, failed captures,
concurrent growth, stale reservations, quota reduction, restoration, and last-reference
deletion, bounded state headroom at full quota, and quota-exempt deletion. Verify
both logical totals and independent physical disk observations.
The indicator cannot be a decorative number detached from admission enforcement.
