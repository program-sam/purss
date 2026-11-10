# Views, queries, and dashboards

## Shared item set

Gallery, list, board, table, and timeline operate on the same item IDs and mutations.
Changing presentation must not duplicate state, move items to a separate database,
or silently change filter semantics. A basket supports these views too.

| View | Purpose and acceptance |
| --- | --- |
| Gallery | Rich media browsing; useful article cards without fabricated imagery |
| List | Fast scanning with optional compact density, not the only interaction model |
| Board | Group by workflow with accessible move menus as well as drag-and-drop |
| Table | Sort/filter by meaningful properties and perform bulk organization |
| Timeline | Explicit chronological browsing with a documented date choice |
| Dashboard | Saved sections referencing existing collections and baskets |

First dashboard composition is a small set of configurable sections, not a free-form
block editor. Preserve return position and selection after opening or moving an item.

## Query contract

Allow text, sources, author when present, media type, workflow, read state, basket,
collection, dates, and capture availability. Use a typed query tree with bounded
depth and cost, server-side validation, workspace scoping, parameterized SQL, and
stable cursor pagination. Whitelist sort fields. Do not store arbitrary SQL or regex
execution from user input. Start with a deliberately small filter vocabulary.

SQLite FTS5 is the proposed text index. Document which fields and captured text are
indexed. Search cannot include remote full text that was never stored. Server-side
queries must work across the dataset, not only loaded browser cards.

## Defaults and ordering

Store view configuration with its collection/basket; use PURSS defaults unless
overridden, with a visible reset/inheritance explanation inspired by T3 Code.
Separate content preferences from device geometry. Use deterministic tie breakers
for date/sort ordering. Explain whether date means publication, discovery, or keep time.

## Personal rediscovery

Plan an optional "On this day" section over the user's existing retained items,
using the recorded keep date initially. A future explicit Like action may supply
its own date; read/open events must not stand in for approval. Common settings
offer on/off and notification choice; advanced controls can select eligible baskets,
intervals, and frequency within supported limits. Hide ignored, removed, or excluded
items and honor private scope. Use the user's timezone, define leap-day behavior,
and deduplicate repeated reminders across sync/restarts before delivery. Missing
history is not reconstructed or invented. An unavailable original can still show
the retained snapshot and its actual availability, without a fresh remote fetch
merely to generate a reminder.

## Privacy and future sharing

All views and baskets are private initially. A public curated feed later is a new,
explicit publication boundary with preview, revocation, and leak checks. Never infer
permission to publish content from basket membership or an upstream public article.
Plan shareable collections with live subscriptions to friends' and creators' selections,
portable RSS/Atom output, and independent subscriber organization. Sharing publishes
an explicit safe projection, not the private collection or its raw filter.
See [publication and following rules](19-shareable-collections.md).
