# Unified sources and private-service feeds

## Product contract

Every followed stream is a Source, whatever its platform calls it: a trip, channel,
creator, publication, or account stream. Provider terminology can explain the preview
("Source: Maya's trip · Polarsteps"), but must not replace Sources, Follow, Collections,
Baskets, or the shared workflow. Show a small native-feed/connected-service and
public/private distinction with accessible details, not a second app navigation model.
Connecting an account grants access; choosing a source follows specific updates.
One connection can support several sources without following them all automatically.

All imported items use the same product IDs, read/workflow state, views, search,
notifications, and basket controls. Capability limits remain explicit: a source
may allow links only, summaries, or particular captures. Shared controls explain
unavailable actions rather than silently promising equal access to every source.
"Unsupported", "Not available yet", "Reconnect", "Permission removed", "Rate limited",
and "Sync delayed" are valid outcomes, not empty successful feeds.

## RSS backbone, not parallel ingestion

Native feeds, including supported Atom/JSON Feed inputs, go directly through FreshRSS.
An approved service adapter translates a documented API or other permitted source
into a private RSS feed. FreshRSS consumes that feed; the existing GReader adapter
then imports it into product-owned items. No service adapter inserts product items,
owns workflow, or creates a provider-specific UI/store/search/sync path.

Proposed responsibilities, to prove before implementation:

- Source adapters handle provider authorization, resource discovery, permitted API
  requests, pagination, normalization, and declared capabilities/coverage.
- A shared feed gateway handles RSS serialization, feed/item identities, scoped
  authentication, bounded caching, retries/backoff, and observable health.
- FreshRSS handles recurring feed collection; the existing product worker handles
  engine-to-workspace sync, durable item transactions, and existing outbox rules.
- Shared contracts handle source health, permissions, capture policy, and redacted
  errors. No per-provider conditionals scattered through item workflows.

Prefer request-driven adapter refresh when FreshRSS polls, with bounded incremental
API work and cached output. Persist provider cursors and normalized feed state only
as needed for coverage/replay; these are bounded staging data, not a second library.
Advance cursors atomically with staged entries, serialize concurrent refreshes,
and expose backlog/coverage limits. Apply backpressure: request provider entries only
up to free staging/window capacity. Do not evict staged entries merely because a
response was served to FreshRSS. Release them only after product sync acknowledges
their stable feed identity and GUID after the durable product item transaction
commits, or a defined storage/time bound is reached;
in that case record and display a possible coverage gap before eviction. Prove the
acknowledgment path through the pinned engine; if identity is unavailable, defer
the connector or propose a narrow reviewed integration, never infer delivery from
HTTP success. Never claim every historical update fits a recent-item feed.
Send acknowledgments over the service-authenticated worker/control path, never
the engine-facing feed listener. Replay is safe; engine access cannot acknowledge
or remove staging data.
Provider backfills or future webhooks need the same feed gateway
and a separately proven scheduling design, not direct product ingestion.

Use a stable feed identity and upstream item GUID independent of refreshed tokens,
display names, and RSS endpoint credentials. Scope provenance to connector type,
authorized principal, and selected resource; keep original IDs where available.
Changing the authorized principal requires explicit new/reconciled sources, never
silently attaching someone else's history. Two users' private views of an object
must not share caches, staged feeds, mappings, or authorization just because its
upstream URL/ID matches. Existing duplicate/replacement-engine rules still apply.
Adapters/gateway persist specific, redacted health through the shared contract;
that is the product's primary source status for gateway-backed feeds. FreshRSS
errors are secondary signals. Authorization loss means user disconnect, confirmed
revocation (such as provider `invalid_grant`), grant expiry, or policy end; it returns
a non-2xx response and stops feed access. Access-token expiry alone, with refresh
temporarily failing because of an outage, is not confirmed grant loss. A temporary
rate limit, network failure, or provider 5xx may
still return already-held unacknowledged entries with 2xx while the grant remains
valid and connector policy permits delivery. This drains staging without claiming
an upstream refresh succeeded: retain the degraded health and last provider-success
time separately from feed-delivery time. If no such entries are deliverable, return
the upstream failure, not a successful empty/unchanged feed. Conditional unchanged
responses follow the defined freshness/authorization policy and never conceal a
known failure. Test an upstream outage longer than staging's time limit with entries
waiting; the gateway must not block delivery of otherwise authorized staged entries.

## Private transport and access lifecycle

The internal RSS gateway is not a public feed-builder endpoint. Authorize requests
for one tenant/source with a revocable credential distinct from provider tokens.
Do not place credentials in feed URLs or expose them through browser/export/logs.
Prove header-based or equivalent engine-compatible authentication, credential rotation,
and tenant-scoped feed lookup against the pinned FreshRSS build before private feeds
ship. If unsupported, propose a narrow reviewed engine integration or defer the
connector; never switch to a direct-ingestion shortcut or unauthenticated gateway.

Gateway hosts/routes are operator-fixed exceptions to internal-service egress rules,
not a general URL proxy. A gateway may share a process, but serves only feed-gateway
routes on a dedicated internal listener/port. Only that listener is an engine egress
exception; it has no product/worker/admin routes and no public reverse-proxy route.
It still requires tenant/source authentication. Provider requests use declared destinations, redirect
validation, response/resource limits, and secret isolation. Do not forward gateway
credentials on redirects. Apply the same bounds to staging, engine backlog, cached
payloads, product captures, and account storage; no unmetered parallel archive.

Disconnect/revocation stops new requests and invalidates feed access, cancels pending
jobs, and purges adapter secrets and transient caches under a defined cleanup policy.
Do not interpret stale cached data as continuing authorization. Define private
retention/capture eligibility per connector before enabling it, including existing
engine/product copies and kept items when permission ends. State the policy before
Follow/Keep; adapters whose obligations cannot honor that policy are unsupported.
Connector policy may restrict what is collected and what Keep can capture, disclosed
before Follow and Keep. It never deletes, expires, or rewrites an existing kept
snapshot. Providers requiring that are unsupported, or Keep is unavailable from the
outset under a clearly disclosed capability. Enforce capture/content limits in what
the gateway emits, because all emitted content reaches the engine and product.
No promise of permanent rights to private service material. Private items are excluded from shared-collection publication,
public feeds, and sensitive notification previews; sanitizing a title does not make
a private source public. Exports require the owner's authorization and explicit
private-content handling; credentials are never included.

Apply those private-item, notification, export, and publication rules to every private
source, including native feeds. Basic-auth native feeds that require a provider
password are outside the initial scope. Native capability/secret-link URLs count as
credentials: mark the source private, protect the engine configuration/API responses,
and redact the URL in UI, logs, diagnostics, OPML and product exports. Exports retain
a secret-free source reference with a reconnect requirement, not a working secret.
Exclude private feed URLs and memberships from publications/source bundles. Enable
secret-link feeds only after this handling is proven; otherwise show auth-required
or unsupported. Internal generated gateway credentials are not provider passwords.
Use known provider patterns and credential-like URL components as warning signals,
not proof of detection; let the owner mark a source private in preview. URLs of
uncertain sensitivity remain redacted in logs/diagnostics and secret-free in exports.
Showing an uncertain URL in export or publication requires explicit owner confirmation
that it is public; known secret URLs remain excluded regardless. Do not classify a
source as public merely because no known token pattern matched. Enforce the same
rule before storing provenance/captures, not only when rendering an export.
Item links and enclosure/media URLs from private feeds follow the same credential
classification, secret-boundary storage, redaction, and export-exclusion rules as
feed URLs. An authorized private-item export does not authorize exporting credentials;
its preview explains omitted/redacted access links and any reconnection requirements.

## Support and onboarding

Prefer official read-only APIs with OAuth or provider-hosted authorization. A provider
login screen is not evidence that a supported third-party API exists. No password
collection, copied session cookies, login-page automation, undocumented scraping,
or access-control bypass in the initial service-connector release. A private native
feed with supported credentials is a separate declared capability, not an OAuth claim.

Keep the flow Add source -> choose service -> authorize externally -> select source
-> preview -> Follow. Explain requested access briefly. Link to Advanced for details,
not technical setup in the happy path. Source status includes last provider success
and last refresh attempt, distinction between empty and failed, coverage, reconnect/mute/remove actions,
and an honest unsupported/manual-link fallback. Detecting Polarsteps is not a promise
to sync it: API support, provider permission, auth, and retention remain unverified
for that candidate until a provider-specific feasibility review passes.

Gate 1 proves the shared engine/gateway boundary with controlled feeds; Gate 5 may
add one approved real service only after authorization, identity, isolation, revocation,
coverage, and maintenance tests pass. Do not build a speculative plugin marketplace.

## Reference boundaries

OAuth security guidance: [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
This plan is a proposed contract, not evidence of API access or working FreshRSS
private-feed transport. Keep the capability matrix and failed cases from the spike.
