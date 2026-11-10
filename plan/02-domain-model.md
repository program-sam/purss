# Domain model

## Entities

| Entity | Meaning and invariant |
| --- | --- |
| Workspace | Owner-scoped data boundary; one owner/workspace first |
| Source | Followable publication, website, or channel; not the connector that fetches it |
| Connection | Engine or connector instance, credentials reference, capabilities, health |
| Subscription | Workspace's relationship to a source, including preferences and feed choices |
| Item | Product-owned stable identity and normalized content metadata |
| External identity | Mapping of item to engine instance, upstream user, source, and external ID |
| Collection | Selected sources or an explicit query; items are gathered by hand in baskets, not collections |
| Workflow state | Undecided, To read, In progress, Finished, or Ignored for a workspace item |
| Reading progress | Unopened/opened/completed or media position; independent of workflow |
| View | Presentation and sort/filter configuration over a collection, basket, or query |
| Basket | Explicit, durable user-curated membership that pins an item against routine cleanup |
| Capture | Stored metadata/content snapshot, provenance, availability, and integrity information |
| Job / outbox command | Durable background work, retries, idempotency, and status |
| Storage account | Account-scoped allocation, logical usage, pending reservations, and enforcement policy |
| Stored object/reference | Metered payload with ownership and references; basket membership is not a second stored copy |
| Usage event | Idempotent byte accounting for committed creation/removal and reservation settlement |
| Entitlement | Source-independent capacity allowance; free/admin/paid grants need no billing provider in domain logic |
| External sign-in identity | Validated provider identity mapped to a stable product account; not a source grant |
| Source authorization grant | Account-scoped consent/secret reference for selected service sources; not product login or admin authority |
| Administrative role grant | Explicit installation-scoped capabilities, separate from workspace ownership and provider claims |

Sources and items use one contract across native and service-generated feeds.
Private-feed staging, identity scope, and capabilities are defined in the
[unified pipeline](20-unified-source-pipeline.md); login and operator permissions
are defined in [identity and administration](21-identity-and-administration.md).

## Identity

Generate stable internal IDs. Scope all relationships and commands to their workspace.
External mappings are scoped to connection and upstream account, not simply a number.
Source plus original GUID is useful when actually available. In the pinned build,
`Entry::toGReader('freshrss')` includes original GUID and feed URL, but the inspected
GReader stream calls `toGReader('compat')`, which does not include those fields.
Verify a supported way to obtain original identifiers in Gate 1; do not assume a
request parameter selects that output mode. URLs and DOIs are matching evidence,
not universal primary keys. Different versions, corrections, syndications, and
reused GUIDs need explicit handling.
Secret-link sources use opaque, workspace-scoped source/feed identities, never the
raw capability URL as an identifier or exported provenance. Store required secret
locations only in the protected credential boundary; uncertain URLs remain redacted
until classified. Apply the [private-source rules](20-unified-source-pipeline.md)
before persisting item provenance/captures. Reconnection uses authorized source
identity evidence, not a leaked URL from an export.

Store provenance and all original identifiers when available. The first release
may suggest duplicate matches but must not destructively auto-merge them. Internal
IDs must survive engine reconnection, source deletion, and upstream record expiry.

Reconnecting to the same verified engine/account reuses external mappings. A restored
or replacement engine has a new identity unless continuity is proven. Reconcile its
incoming history against existing items before creating user-visible duplicates.
Where original identifiers are available, match a resolved source/feed identity plus
original GUID, check for ambiguity or reuse, and attach a new external mapping to
the existing item; do not merge two existing product records. Otherwise preserve
incoming candidates in a durable reconciliation queue and offer a bulk preview of
suggested matches or genuinely new items. Ambiguous cases require confirmation;
do not drop them, silently merge them, or materialize a duplicate library by default.

## Relationships and membership

An item can appear in many collections and baskets with a single workspace workflow.
Collection membership does not implicitly guarantee retention. A basket membership
does: removing one membership cannot unpin an item that remains in another basket.
Views are projections and never own separate copies of article state.

Use explicit collection modes: followed-source selection or query. Hand-gathering is what baskets are for.
Do not ambiguously combine these in the MVP. Basket membership is manual and stable;
searching within a basket does not turn it into a dynamic collection.

## State and concurrency

Opening an item changes reading progress, not workflow, unless a clearly chosen
preference says otherwise. Finished is not deletion. Ignored is reversible and does
not unsubscribe the source. Keeping an item is independent of all of these.

Mutations carry an expected revision or equivalent conflict control. Two tabs must
not silently overwrite basket membership or workflow. Product state commits before
upstream mirroring; durable outbox commands retry without resetting the product.
Schema changes require migrations and restore tests once the database exists.

Account/workspace IDs must be explicit from the first schema even while a single
owner is the only supported installation. For the hosted first release, one account
owns one workspace; collaboration and shared organizations are not implied.
Quota checks and durable-keep transactions must agree: reserve/check capacity before
committing promised content, settle actual bytes atomically, and never announce a
successful keep that storage enforcement subsequently discards. See
[storage accounting](17-storage-and-ownership.md) for shared-reference semantics.
