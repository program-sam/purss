# Packaging and operations

## User target

One installation command or guided installer, one public origin, one owner account,
and clear updates/backups. FreshRSS and helpers are internal implementation details.
The target deployment is Compose, not an instruction to manually connect applications.

## Planned services

Gateway serves web assets and routes the API. API owns SQLite. Worker performs
sync/jobs through the internal API. FreshRSS owns a separate data volume and its
scheduled refresh. Optional bridges/browser renderer use profiles only when needed.
The integration spike decides whether gateway/web/API and worker can be packaged
more simply while preserving security and ownership. Do not claim this Compose
stack exists yet; `infra` currently contains responsibilities only.

## Installation and configuration

Generate secrets; pin service images; verify permissions and writable volumes;
provision FreshRSS once; schedule fetching; establish the internal connection;
present only owner-account setup and source onboarding. Persist install state and
resume partial setup safely. Never rerun first-install commands against live data
or require deleting a volume to change a setting.

Expose guided configuration for public origin, storage, backup destination, and
optional mail. Avoid mandatory external email, Redis, AI, telemetry, or cloud accounts
for the first single-owner install. Handle timezone consistently with UTC storage
and local display. Define supported OS/architecture only after actual target testing.

## Backup and restore

Back up the product database using SQLite's supported consistent-backup mechanism,
captures and manifests, FreshRSS data/config, and separately protected key material.
Coordinate capture-file/database consistency and record the format/required app
compatibility. Never copy a live SQLite file alone and assume WAL contents are included.

Restore to a clean installation; validate integrity, memberships, captures, search
rebuild, and engine reconnect. Product basket restoration must work even if FreshRSS
is unavailable. PURSS export complements, but does not replace, operator backup.

## Updates and observability

Provide the role-scoped administrator dashboard and fixed recovery tooling described
in [identity and administration](21-identity-and-administration.md). Separate operational
metadata from private reading content; admin UI access is not a general database,
shell, or service-token browser. Provider/client setup is an operator task surfaced
through guided installation, not left to each ordinary user adding a source.

Preflight migrations and disk space; back up; stop or drain jobs; apply migrations;
verify health; resume leases. Define recovery for incompatible database changes;
rolling back an image is not necessarily rolling back a migration. No unattended
destructive upgrades. Observe sync lag, last success, job failures, disk usage, and
capture availability without logging sensitive content or secret-bearing URLs.

## Storage visibility and hosted operation

Track product logical usage separately from physical product, capture, FreshRSS,
database/index/WAL, cache, backup, and filesystem usage. Display freshness and shared
or unattributed overhead, not a misleading sum of account quotas as disk usage.
Unknown disk metrics are unknown, never zero. Maintain an operator-controlled reserve
and pause growth safely before exhaustion. See [storage policy](17-storage-and-ownership.md).

The official hosted deployment needs verified account isolation, free allocations,
usage reconciliation, recovery/support procedures, and sustainable resource limits.
Its launch gate is separate from installing the self-hosted build. Extra paid capacity
or donations are funding options, not a required dependency for self-hosters or a
reason to gate export. See [hosted service](18-hosted-service.md).
