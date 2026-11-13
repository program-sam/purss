# Security and privacy

## Threat model

Untrusted inputs include pasted URLs, feeds, article HTML, discovery redirects,
connector output, imports, images, and media metadata. Attackers may control a
source, exploit a fetching worker, steal a backup, or send cross-site requests to
the owner's server. A private deployment is not automatically a trusted network.

## Required controls

- Authenticate every product-data endpoint and scope IDs, search, captures, and
  mutations to the PURSS. Initial single-owner support is not permission to
  build unscoped handlers that will later be reused for multiple users.
- Keep browser cookies HttpOnly/Secure with explicit SameSite and CSRF protections
  appropriate to mutations. Define session expiry and first-owner claim protection.
- Public URL fetching rejects non-HTTP(S), embedded credentials, loopback, private,
  link-local, reserved destinations, and unsafe redirects; verify resolved addresses
  and bind the actual connection to validated results to resist DNS rebinding.
- Separate an operator-fixed internal FreshRSS/bridge destination from user URLs.
  Network segmentation/firewall rules must also protect FreshRSS and browser workers;
  application discovery validation does not secure FreshRSS's independent fetching.
- Sanitize stored HTML on render; apply CSP and safe link behavior. No feed scripts,
  injected event handlers, automatic embedded players, or raw untrusted SVG. The only frames are the video
  platforms' own players the reader loads when the person presses play ([25](25-media-playback.md)).
- Smart filters ([36](36-ai-filters.md)) send post text only to the operator-fixed Jev address
  (redirects refused); the server's Jev key, set only by an administrator, lives in the secrets
  folder, never in the database, exports, logs or job payloads. People never hand over a key. Post text is untrusted: Jev answers only probabilities.
- Enforce time, response size, decompression, recursion, item-count, and job budgets.
  Respect cancellation and backoff. Do not retry invalid credentials indefinitely.
- Store encryption keys outside ciphertext databases; generate installation secrets.
  Keep root-readable configuration/secret mounts out of logs, exports, browser state,
  Git, and generic diagnostics. Encrypt/protect backups and test key recovery.
- Preserve origin attribution; minimize third-party image/favicon requests and make
  remote media behavior explicit. No telemetry or AI calls by default.

## Internal jobs

Private service feeds require scoped engine-to-gateway authentication, isolated
caches, bounded staging and explicit access-loss/retention policy; see the
[pipeline security contract](20-unified-source-pipeline.md). Source tokens never
double as product sessions or feed URLs. Prefer external auth/OIDC for sign-in and
OAuth for supported source authorization; no automatic email-based account linking
or admin elevation. Admin APIs, auditing, step-up, and operator privacy limits are
part of [identity and administration](21-identity-and-administration.md).

Worker endpoints require service authentication and narrow command permissions,
even on an internal network. Leases, replay-safe batches, revision checks, and
transactional membership/capture writes protect against crashes and concurrent tabs.
Validate job payloads; do not expose a generic authenticated request proxy.

## Operational safety

Initial claim must use a generated one-time secret or equivalent safe local setup,
not a public first-visitor-wins screen. Public registration is off. No arbitrary
shell commands for recipe creation. Surface disk limits and expired sources without
destroying data. Review package and component licenses before distributing images.
Independent security review is a release gate, not something this document completes.

## Official hosted accounts

Account creation with a free allocation is planned, not permission to enable public
registration on a single-owner build. Prove tenant isolation for engine accounts,
queries, item IDs, captures, object downloads, worker leases, quota ledgers, and
exports before registration opens. Include cross-account adversarial tests, abuse
controls, recovery, session revocation, and privileged-operator access logging.

Storage limits cannot replace per-account job/rate/concurrency limits or a physical
disk reserve. Future payment notifications are untrusted inputs; verify signatures,
deduplicate events, and keep secrets/card data outside this app's storage. A hosted
operator may be technically able to read stored content; do not claim end-to-end
encryption or absolute privacy. See [hosted prerequisites](18-hosted-service.md).
