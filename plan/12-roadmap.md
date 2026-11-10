# Implementation roadmap

## Gate 0: direction and review

Deliver this plan, repository boundaries, and independent architecture review.
Owner confirms the next implementation slice, naming/branding can remain provisional.
No application implementation or deployment is implied by scaffolding approval.

## Gate 1: prove the FreshRSS boundary

Run a pinned FreshRSS build in a disposable, explicitly approved local environment.
Prove first-run provisioning and recovery; native subscription creation; channel
feed discovery; API pagination and efficient incremental sync; edits/reordering;
read/star mirroring; restart/replay; and handling upstream purge. Record real
requests/observations with secrets removed. Determine how advanced recipes can be
created without private-schema writes: first evaluate GReader OPML import with
FreshRSS's extensions and the CLI reconfigure/import scripts, using product-generated,
allowlisted OPML only. Prove replacement-engine reconciliation without a duplicate
library, including when original GUIDs cannot be obtained. Test a sync outage beyond
upstream retention and report possible unrecoverable gaps. Before real-source tests,
restrict fetching egress; before accepting arbitrary URLs, prove controls cover the
engine as well as discovery. If a capability is absent, narrow the slice or document
a reviewed extension proposal; do not silently replace FreshRSS.

Exit: replay-safe product identities demonstrated, API capability matrix recorded,
and basket snapshots survive upstream deletion in a real integration experiment.
Use minimal disposable code; retain only useful regression tests/adapter code.

Gate 1 also proves authenticated private RSS gateway lookup/rotation and isolation
against the pinned engine using controlled sources, without requiring a real service
grant. Evaluate OIDC/provider registration, callback setup, provider-independent
sign-in/recovery, and protected admin bootstrap before selecting auth infrastructure.
Record unsupported cases; these are feasibility tests, not permission to ship private
connectors or open signup. See [unified sources](20-unified-source-pipeline.md) and
[identity/admin requirements](21-identity-and-administration.md).

## Gate 2: validate the PURSS interaction

Create original responsive design flows inspired by T3 Code: shell, Add source,
collection gallery, workflow board, reader, and basket. Include empty/error states,
mobile navigation, keyboard alternatives, and appearance tokens. User reviews the
feel before broad frontend implementation. Test collection/basket terminology.
Include inviting browsing, new-content cues, and notification preference/permission
flows; review for enjoyment as well as organization and calm.
Include common/advanced settings and an optional anniversary-memory example;
check that defaults feel welcoming without forcing configuration.

Exit: owner approves flows and users can explain Keep versus To read and distinguish
freshness highlights from workflow or reading progress.

## Gate 3: first complete vertical slice

Include central role checks, protected owner/admin bootstrap, sign-in/recovery, and
basic administrator health/storage/source diagnostics. External identity and source
authorization are separate records even while only native sources are enabled.

Implement owner authentication, migrations, stable items/mappings, source onboarding,
collections (followed-source and query modes), sync/outbox, gallery/list, workflow
board, atomic basket keep, and basic search.
Include scoped storage records, atomic admission/reservations, and a simple storage
indicator with feed/basket breakdown from the first data model; do not bolt on
account ownership or metering after data has accumulated.
Include a confirmed permanent-deletion path for unkept items/unpinned captures and
clear capacity pause/recovery behavior. Full management, export, and restore remain
Gate 4; no dead management/export links or hosted launch is implied by this slice.
Use a real journal/blog/channel dataset, not only fixtures. No arbitrary connectors,
public sharing, or general dashboard editor. Gates 1 and 2 both precede this slice.

Exit: paste -> follow -> browse -> organize -> keep -> restart -> find again works
on the target host and mobile/desktop browsers, including failure recovery.
Also reconcile ledger totals with owned objects, avoid multi-basket double-counting,
prove concurrent content import/keep cannot overspend ordinary capacity, bound
control-operation headroom, recover expired/replayed reservations without leaks or
double-charging, and demonstrate a no-data-loss disk-reserve pause.

## Gate 4: organize and recover

Add tables, timeline and query-mode collections, dashboard sections,
manual URL keep, documented PURSS export/import, and complete backup/restore UX.
Add configurable notifications with mute/quiet hours and delivery choices proven
for the supported devices; do not imply real-time or complete source coverage.
Add optional anniversary rediscovery from recorded keep dates, with common settings
and advanced eligibility/frequency controls. Do not require a new Like action for
this slice; any later Like feature must remain distinct from reading and keeping.
Include bulk actions, undo, and capture availability. Measure performance on agreed
realistic data before optimizing.
Add a storage-management page with usage freshness, largest items/sources, cleanup
impact previews, kept-item protection, and export independent of available capacity.

Exit: retained baskets restore without the original engine; queries and membership
remain correct under concurrent tabs, empty results, and large collections.

## Gate 5: guided deployment and source expansion

Prove admin step-up, audit trails, recovery, safe job controls and operator-only
diagnostics before exposure. Add one approved service adapter only after its private
RSS transport, OAuth/permission lifecycle, stable identity, quota/staging bounds,
private-capture policy and maintenance tests pass. No direct API-to-product shortcut;
no unverified Polarsteps or other service integration is promised.

Implement and prove single-entry installation, internal FreshRSS setup, secret
generation, health UI, upgrades, and resource limits. Add only source connectors
requested for real user needs, with security and license review. Prove the actual
egress-control mechanism for FreshRSS and any bridge, including redirects to internal
destinations after subscription. Compose network membership alone is not egress control.
Browser rendering, shared PURSSes (several people in one PURSS), collaboration, public
outputs, and custom fields are separately approved work, not automatic expansion of
the MVP. Official hosted accounts follow Gate 6, not this self-host installation gate.

Exit: a nontechnical tester installs, follows sources, recognizes a broken source,
and restores a backup using the documented flow. Security review precedes exposure.

## Gate 6: official hosted service

Include ordinary-user signup versus explicit admin provisioning, external-sign-in
linking/recovery, source-grant separation, and role-scoped account management tooling.
Prove user/admin/worker isolation and audit/support policy before public registration.

Prove the tenant/engine/storage topology, account isolation, free allocations,
registration/recovery/deletion, per-account resource limits, operator readiness,
and migration to self-hosting. Perform adversarial tenant tests and independent
security review before opening signup. Decide sustainable allocation sizes only
after measurement. Optional paid capacity and donations need a separately approved
funding policy; no payment implementation is required for earlier gates.

Exit: two real accounts cannot access each other's data or consume each other's
allowance, full/over-limit accounts retain read/export access, existing basket data
survives capacity changes, and restore/migration have been demonstrated. Public
launch remains an explicit owner decision, not an automatic result of passing tests.

## Gate 7: shareable collections

After Gates 1–5, and separately from hosted signup, implement the owner-approved
[collection-sharing direction](19-shareable-collections.md) only with explicit
implementation approval. Begin with manual curated-item publications, share preview,
public share pages, portable RSS/Atom, and guided following across installations.
Hosted publication runs under the report and takedown policy in plan/19.
Source bundles, query-derived publications, and restricted audiences require their
own scope/privacy review, not automatic inclusion in the first sharing slice.

Exit: private data never enters published projections, external readers can subscribe,
subscribers retain independent workflow and keeps, overlapping sources are handled,
and unpublishing stops access without falsely promising recall of existing copies.
