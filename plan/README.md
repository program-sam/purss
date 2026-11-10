# Plan index

## Approved direction

A personal PURSS, not an inbox reskin. FreshRSS collects content; the product
owns durable items and how users organize them. Baskets are permanent user-curated
storage, not another name for unread. Source setup is guided. The design takes
inspiration from T3 Code's calm, contextual workspace without copying its branding.
Storage visibility reinforces ownership. Self-hosting is the first delivery target;
an official hosted option with free storage is part of the product direction.

## Reading order

| Document | Purpose |
| --- | --- |
| [01 Product](01-product.md) | Audience, principles, MVP boundaries |
| [02 Domain model](02-domain-model.md) | Sources, items, collections, workflow, views, queries, baskets |
| [03 Experience](03-experience-and-design.md) | Navigation, design language, accessibility, T3 Code mapping |
| [04 Source onboarding](04-source-onboarding.md) | Paste-a-link flow, feed discovery, YouTube, errors |
| [05 Architecture](05-architecture.md) | Service boundaries, stack proposal, ownership |
| [06 FreshRSS](06-freshrss-integration.md) | Provisioning, sync, identity, read/star mapping, limitations |
| [07 Baskets](07-baskets-and-retention.md) | Durable storage, capture guarantees, deletion, export |
| [08 Connectors](08-connectors-and-discovery.md) | Native feeds, recipes, source capability model |
| [09 Views](09-views-and-queries.md) | Gallery, board, table, timeline, dashboards, query contracts |
| [10 Security](10-security-and-privacy.md) | Trust boundaries, secrets, fetching, sharing |
| [11 Operations](11-packaging-and-operations.md) | One installer, internal services, backups, updates |
| [12 Roadmap](12-roadmap.md) | Ordered milestones and acceptance gates |
| [13 Validation](13-validation.md) | Realistic data, failure tests, UI and integration acceptance |
| [14 Decisions](14-decisions-and-risks.md) | Settled direction, proposals, questions, rejected approaches |
| [15 Evidence](15-references.md) | Primary references and scope of inspection |
| [16 Review](16-review.md) | Independent review findings and disposition |
| [17 Storage](17-storage-and-ownership.md) | Storage indicator, metering, quotas, control, and cleanup |
| [18 Hosted service](18-hosted-service.md) | Free accounts, isolation, optional paid storage/donations, portability |
| [19 Shareable collections](19-shareable-collections.md) | Human-curated publications, following friends/creators, privacy, and portable feeds |
| [20 Unified sources](20-unified-source-pipeline.md) | Native and private API-backed sources through one FreshRSS/RSS pipeline |
| [21 Identity and administration](21-identity-and-administration.md) | External sign-in, source grants, administrator roles/dashboard, and recovery |
| [22 Implementation](22-implementation.md) | Approved A3 design, stack, processes, and preliminary scope per gate |
| [23 Assistant access](23-assistant-access.md) | MCP server with personal access tokens: switches, tools, limits, untrusted text |
| [24 Connected apps](24-connected-apps.md) | Code + PKCE connection for the mobile app and extension, device tokens, CORS, duplicate-aware keeping and lookup |
| [25 Publisher media and playback](25-media-playback.md) | The server stores no audio or video files; the in-app player, playback positions, contracts for the mobile app |
| [26 Annotations](26-annotations.md) | Highlights and notes: anchoring, last-write-wins sync, offline outbox, retention, search, export |
| [27 Outgoing email](27-outbound-email.md) | Optional SMTP: emailed invitations; hosted address confirmation and password reset; send log without bodies |
| [28 E-ink and social sources](28-eink-and-social-sources.md) | E-ink display mode per device; Mastodon and Bluesky accounts followed through their public feeds |
| [31 Mobile apps](31-mobile-apps.md) | Android and iOS apps with Capacitor around the web app: platform layer, connecting, native audio, Downloaded, share intake |
| [32 Browser extension](32-browser-extension.md) | Extension for Chrome, Edge, Firefox and Safari, bookmarklets, deep links into Add source and Keep, browser-assisted capture |
| [33 Assistant OAuth](33-assistant-oauth.md) | OAuth 2.1 for `/mcp` (hosted mode, or opt-in): metadata, client metadata documents, consent, rotating tokens, threat model and spec deviations |
| [35 Discovery](35-discover.md) | Hosted-only source suggestions from a co-follow graph, for readers who share: minimum of 10 readers, no counts, scoring with daily chance |
| [36 Smart filters](36-ai-filters.md) | Optional Jev filters per source or collection: preview, Ignored outcome, server key (admin only) and Hosted Pro, usage cap |
| [37 Push notifications](37-push-notifications.md) | Notifications on the phone through a content-free push relay: registration, waking, fetching, who sees what, owner setup |
| [38 Phone background and widgets](38-phone-background-and-widgets.md) | Automatic downloads while the app is closed, downloads stopped on the wire, home-screen widgets, the plan endpoint |
| [39 Live updates](39-live-updates.md) | The phone apps load the interface from the server they are connected to: native level, the question for other servers, when an update takes over |
| [40 Versions](40-versions.md) | One number per commit on main (2631214: year, day of the year, that day's commit): where builds get it, where it shows, release notes |
| [41 Source bridges](41-source-bridges.md) | Bundled RSS-Bridge behind the egress bridge router: signed source addresses, post ids that survive a backend change, fetch log, isolation |
| [42 Desktop app](42-desktop-app.md) | Windows, macOS and Linux app in Tauri: the phones' model (device token, live interface updates), its own updates from GitHub releases, tray, notifications without a relay, downloads as files, feed links and OPML files |

## How to use this plan

The owner's product choices are requirements. Technology suggestions are proposals
until their milestone gate passes. A documented endpoint or capability is not a
tested implementation. Do not start all milestones in parallel or build a second
ingestion path. No calendar or performance claim is implied by this plan.
