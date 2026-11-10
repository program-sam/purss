# Connectors and discovery

## Collection ladder

Native feed discovery -> supported source resolver or approved authenticated API-to-RSS adapter -> approved declarative recipe
-> optional isolated browser extraction -> honest unsupported/auth-required state.
FreshRSS remains the final feed collection engine; do not grow a competing native
RSS poller inside the product. Discovery fetching is distinct from recurring ingestion.
Authenticated source adapters use the [shared private RSS gateway](20-unified-source-pipeline.md),
not direct product writes. Unsupported or unreliable services stay unavailable rather
than ship a half-working integration. No provider passwords or session-cookie scraping
in the initial service-connector scope.

## Contract proposal

A connector declares stable ID, source types, capabilities, permitted domains,
authentication needs, pagination/coverage limits, rate limits, and health/error codes.
Keep discovery, feed generation, content extraction, and media playback capabilities
separate. A YouTube channel feed resolver is not an authenticated account importer.

Use declarative, versioned configuration first. Source identity, normalized item
format, pagination, and permissions borrow concepts from Grayjay and Tapestry, not
their application code or desktop security assumptions. No arbitrary uploaded code
or end-user JavaScript execution in the first release.

## Self-hosted helpers

Evaluate RSS-Bridge or RSSHub only for explicitly selected missing source types.
If adopted, bundle a reviewed internal service with fixed routes, version/digest,
health checks, and operator-visible maintenance status. Do not enable every route
or expose helper admin/debug endpoints publicly. Bridge output is consumed by FreshRSS.

Browser rendering is optional and off by default. It needs a separate sandbox,
bounded resources, reviewed network egress, secret isolation, and per-source budgets.
One installer can manage these services without making users configure them individually.

## Recipe and coverage management

Each recipe has fixtures, upstream URL examples, owner/maintainer context, failure
detection, and known limitations. Changes require review and regression checks.
Show last successful collection and meaningful failure categories. A feed that
returns no entries is not proof that a source has published nothing.

## Consumer builder

A future visual picker needs safe page preview, selectable repeated blocks, field
mapping, duplicate handling, extraction preview, JavaScript/auth warnings, and repair
guidance. Do not iframe arbitrary sites and assume CSP/same-origin restrictions vanish.
Do not promise universal coverage or bypass authentication, paywalls, or source terms.
