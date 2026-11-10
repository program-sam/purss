# Product API boundary

Planned: owner sessions, PURSS authorization, runtime validation, migrations,
item identity, workflow, basket transactions, search, exports, and
authenticated internal job endpoints. No server, endpoints, or database exists yet.

This is the sole writer of the product database. The browser and background
workers do not access SQLite directly. Keep FreshRSS access behind its adapter,
not a generic URL proxy. Select libraries after the feasibility gate.

See [architecture](../../plan/05-architecture.md), [security](../../plan/10-security-and-privacy.md),
and [validation](../../plan/13-validation.md).
