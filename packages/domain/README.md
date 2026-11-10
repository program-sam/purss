# Domain boundary

Planned: stable IDs, source/item shapes, workflow and reading state, basket
membership, query grammar, command results, revisions, and provenance. No runtime
contracts or exported types have been implemented.

Keep this package independent of UI, database drivers, and FreshRSS protocol details.
Implement invariants with focused tests before connecting them to storage.

See [domain model](../../plan/02-domain-model.md) and
[basket guarantees](../../plan/07-baskets-and-retention.md).
