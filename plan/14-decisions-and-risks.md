# Decisions and risks

## Owner-approved direction

- Personal PURSS rather than an inbox redesign.
- Fun, appealing self-curation, not an anti-algorithm message; familiar engagement
  patterns, notifications, and new-content highlights are welcome with user control.
- FreshRSS as the collection engine, mostly hidden from end users.
- RSS as the shared ingestion backbone for native and approved proprietary sources;
  coherent Source vocabulary and workflow with visible origin/privacy distinctions.
- Prefer external authentication for signup/sign-in and supported source grants;
  administrator accounts, dashboard, and tooling are required role-scoped capabilities.
- Unsupported/unreliable integrations stay unavailable rather than silently degrade
  into apparently successful empty feeds.
- Source, item, collection, workflow, and view concepts.
- Durable baskets for items kept indefinitely.
- Guided source discovery, including recognized YouTube channels.
- Optional shareable collections that others can subscribe to, including selections
  made by friends and admired creators; private by default, later delivery gate.
- T3 Code as a design-language reference, alongside the previous case studies.
- A public GitHub repository under the AGPL-3.0 ([LICENSE](../LICENSE)).
- Visible storage ownership, feed/basket usage breakdown, and manageable capacity.
- Official hosted accounts with free storage; optional paid capacity and/or donations
  are funding possibilities, with details still to be decided.

## Proposed engineering choices

TypeScript packages, React frontend, Node API/worker, SQLite/FTS5, single-owner
managed engine first, one public origin, and a Compose installation target.
These are not claims of implemented infrastructure or permission to deploy it.
HTTP framework, auth implementation, ORM/driver, UI library, and exact dependency
versions remain open until the spike demonstrates what is needed.

## Open owner choices, with defaults for planning

| Choice | Planning default | Decision point |
| --- | --- | --- |
| Brand/name | PURSS is descriptive, provisional | Before public-facing design |
| Collections versus baskets labels | Collections organize; baskets pin durable items | Design usability review |
| Capture scope | Minimum snapshot plus existing feed text; publishers' audio and video files are never stored on the server, only played from the publisher and, in the apps, downloaded to the device ([plan/25](25-media-playback.md)); never platform pages | Before retention implementation |
| Product item pruning | No automatic product-item deletion in the first slice; any later policy is opt-in and pin-aware | Before adding cleanup |
| External FreshRSS support | Managed engine first | After single-owner slice |
| Account model | One owner first; scoped schema and later hosted account/signup gate | Before hosted launch |
| Free hosted allocation | Amount undecided; measure cost/capacity first | Before hosted beta |
| Inactive/closed free-account retention | No purge authorized; explicit notice, grace/export, and kept-item policy required | Before hosted beta |
| Funding | Optional paid capacity and/or donations, no provider/price chosen | Before payment work |
| Storage accounting | Defined logical account bytes, separate physical server metrics | Before persistence/metering implementation |
| Collection publication | Feature direction approved; off by default, explicit preview/publish; public-only first proposal | Gate 7 implementation and audience review |

## Main risks and mitigations

- FreshRSS API lacks a required provisioning/recipe operation: demonstrate capability
  first, then propose a minimal reviewed extension or narrow the feature.
- Two state stores diverge: stable mappings, explicit ownership, outbox, checkpoints,
  and recovery tests; no bidirectional workflow synchronization.
- Baskets promise too much: explicit capture levels, atomic minimum snapshot,
  no media availability guarantees, and restore without the engine.
- SSRF through either discovery or engine fetching: application controls **and**
  service network egress policy; internal endpoints are operator-fixed.
- Scope expands into a general productivity platform: ship a few linked views,
  not a free-form page builder, collaboration suite, or plugin marketplace.
- Too much operational complexity: one managed installation and simple ownership;
  do not add Redis, object storage, or browser automation before measured need.
- Dependency or license conflicts: review each chosen component before copying,
  bundling, or distributing it; API separation does not erase license obligations.
- Unlimited growth versus free allocation: no silent eviction; pause safely, explain
  gaps, measure sustainable allowances, and preserve export at capacity.
- Hosted tenants leak or exhaust shared resources: scope from the first schema,
  prove engine isolation and job fairness, and gate registration separately.

## Rejected approaches

FriRSS reskin alone: insufficient durable product ownership. Tuvix foundation:
not selected because the owner chose FreshRSS. Grayjay/Tapestry application fork:
hosting, source availability, or licensing mismatch. Scratch-built RSS poller:
duplicates the selected engine. Arbitrary plugins and public defaults: unnecessary
security/privacy risk. Full dashboard editor in the MVP: delays core validation.
