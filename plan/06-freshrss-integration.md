# FreshRSS integration and synchronization

## Engine baseline and capabilities

Use the released FreshRSS baseline in [references](15-references.md) for the first
spike, not an unpinned edge branch. Resolve and record a container digest before
deployment. Verify API login, pagination, item metadata, subscription management,
read/star updates, scheduling, and initial provisioning against that build.

The GReader-compatible API is the primary boundary. Its documented ClientLogin,
subscription listing, token, stream contents, and subscription editing are starting
points, not proof of every desired capability. Test efficient sync following
FreshRSS's linked recommendations rather than repeatedly fetching entire histories.

## Provisioning

Managed first install creates one FreshRSS account for the PURSS owner, enables
the API, generates credentials, and configures scheduled refresh. FreshRSS's Docker
first-run installation/user variables are evidence that provisioning is possible;
they are not a safe reconfiguration mechanism. Never delete an existing volume to
apply changed settings. Idempotent installation and interrupted-setup recovery are gates.

Set an explicit upstream archiving policy during provisioning. Record its effective
limits and expose sync-health warnings when an outage could allow upstream cleanup
before import. Count limits as well as time limits matter: checkpoint age alone
cannot prove completeness. A gap may be unrecoverable; never claim all articles were
captured simply because synchronization eventually resumes.

Official hosting requires separate upstream FreshRSS account identities per product
account or a demonstrably equivalent stronger isolation boundary. Never run all
customers as one upstream user and rely on frontend filtering. Pausing product
imports at quota must also bound the account's upstream backlog/storage and explain
any resulting coverage gap; retaining a second unbounded copy in FreshRSS is not
storage enforcement. Verify supported per-user controls in the hosting spike.

## Sync protocol requirements

1. Validate the engine identity and capabilities before using a saved checkpoint.
2. Import bounded pages into product-owned items and scoped external mappings.
3. Commit each batch and its checkpoint atomically; crash/replay cannot lose items.
4. Preserve a last-good checkpoint, lease expiry, and observable retry/backoff state.
5. Reconcile read/star changes separately from immutable identity and basket retention.
6. Handle reconnect, upstream purge, removed subscriptions, and stale credentials
   without deleting product items or memberships.

A new engine identity requires the reconciliation process in the
[domain model](02-domain-model.md), not simply resetting the cursor and importing
its history as new items. Test whether supported export/API paths provide original
GUIDs; the inspected standard GReader stream uses compatibility output. Preserve
uncertain incoming records for review rather than inventing identity continuity.

Prove semantics for newly published, late-arriving, edited, reordered, and removed
entries. Do not assume publication time is a reliable high-water mark or that
upstream deletions are enumerable. If an API cannot enumerate deletions, retain
records and mark availability only with defensible evidence; never infer deletion
from absence in a recent-item page.

## Read/star ownership

In managed mode, the product owns workflow and reading state; optional read/star
mirroring uses a durable outbox. Basket membership is never a FreshRSS star or label.
For a bring-your-own engine later, conflict policy must be explicit before enabling
bidirectional read/star reconciliation. External changes cannot silently alter baskets.

## Feed creation and technical settings

Simple native subscriptions use the API. First evaluate GReader `subscription/import`
with FreshRSS's extended OPML and the existing CLI reconfigure/import scripts for
advanced recipes and safe reconfiguration. These are candidate supported boundaries,
not runtime-verified product integrations. Add a reviewed extension only if necessary.

The inspected import handler marks OPML as trusted. Generate the outgoing OPML from
validated, allowlisted product fields; never forward user-uploaded OPML or arbitrary
FreshRSS/cURL options into that trusted path. Recipe URLs still require egress controls.
CLI integration must use fixed operations and structured arguments, not user shell
commands. Keep recipes outside the first native feed slice until proven. No direct
database writes or UI scraping.

## Retention and limitations

FreshRSS's released configuration combines period/count limits and exemptions.
Do not equate its IDs with canonical GUIDs or rely on starred/labeled exemptions
as the product's only preservation mechanism. Do not promise historical completeness
when upstream feeds themselves expose only recent items. Keep engine admin access
operator-only; advanced diagnostics must redact credentials and content.
