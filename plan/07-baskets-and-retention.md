# Baskets and durable retention

## User contract

A basket is a named, manually curated place for items the user intends to keep and
organize indefinitely. It is not an unread queue, temporary workflow column, dynamic
search, or copy of a source. An item can belong to several baskets.

Keeping an item pins its product record and the content actually captured at keep
time against routine pruning. It does **not** promise to preserve remote full text,
images, media, or licensed content that has never been captured. Indefinite means
no automatic expiry; it still depends on the operator's storage and backups.

## Product retention policy

Planning default: the first slice never automatically deletes product items.
Unkept means no pinned historical snapshot, not scheduled deletion. Live metadata
may be updated, and external content can disappear; kept captures remain distinct.
Any later product pruning is opt-in, explains eligibility, previews the affected
items, and exempts every basket and other retention pin. Changing this policy is
an owner decision, not a storage optimization. Until pruning is implemented and
approved, disk pressure pauses work and warns rather than evicting product records.
Hosted free allocations do not change this promise. At a limit, block new growth
or offer explicit user-approved cleanup; no silent expiry of baskets. Any different
future retention contract needs explicit review, disclosure, and user consent.
An indefinite basket is not a promise that a hosted service exists forever: disclose
closure/export procedures and backup limits without selling permanent availability.

## Keep action

Atomically create membership and a durable minimum snapshot from existing product
data: title, original URL, source identity, timestamps, available excerpt/content,
external identifiers, and provenance. If that minimum cannot be stored, Keep fails
clearly; do not show success and queue preservation later.

Optional additional capture happens as a bounded job. UI distinguishes Saved
metadata, Feed content saved, Full text captured, Capture pending, and Capture
failed. Never label a metadata-only bookmark as an offline article. A changed source
record cannot silently overwrite an explicitly retained snapshot; refresh can add a
new capture while retaining the kept one.

## Removal, deletion, and cleanup

- Removing membership from one basket leaves other baskets and the item intact.
- Removing the last membership releases the basket pin, with undo; it is not an
  immediate purge command. Other explicit retention pins still apply.
- Deleting a basket defaults to removing its memberships, with a clear preview.
- Deleting an item everywhere is a separate, confirmed operation listing affected
  baskets/collections/captures. Undo/trash grace behavior must be specified before release.
- Gate 3 provides an explicit, confirmed permanent-delete path for unkept items or
  unpinned captures, with an affected-data preview and no implied undo or trash.
  Deleting kept items everywhere needs separate confirmation naming their baskets;
  fuller recovery/trash behavior is decided in Gate 4 before wider release.
- Source removal stops collection but leaves kept records, attribution, and snapshots.
- Routine cleanup never deletes basket-pinned items or captures. Disk pressure pauses
  captures/import and warns; it must not silently evict preserved content.

Workflow states may protect working items under a separate policy. Undecided/Ignored do
not automatically imply deletion. Collection membership alone is not a retention
promise; show Keep in basket when users need that guarantee.

## Export and recovery

Export basket definitions, membership, stable IDs, provenance, workflow, and captured
content that can be exported. OPML is subscriptions only and is insufficient. Use a
documented schema, integrity manifest, and safe import validation. These exports
contain private reading data and must not enter Git. Test restoration without the
original FreshRSS volume or network access before calling baskets durable.
