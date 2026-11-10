# Project instructions

- The owner approved the A3 design and implementation; plan/22 records the build decisions
  and what each gate defers. Keep deferred items honestly unbuilt until approved.
- Keep FreshRSS as the ingestion engine; do not add a competing feed-fetching engine.
- Product data, stable item IDs, workflow, baskets, and search belong to this product.
- Baskets preserve items independently of upstream retention. Never imply that a
  bookmark guarantees an external page, video, or full-text copy remains available.
- Separate reading progress, workflow, collection membership, and retention.
- Preserve explicit storage ownership: distinguish account quota from physical disk
  usage; never double-count basket membership or silently evict kept content.
- Keep hosted accounts tenant-isolated and data export independent of paid capacity.
- Preserve one simple public application and hide service wiring from ordinary users.
- Follow the owner's cross-check policy for consequential designs and implementation.
- Do not copy T3 Code branding or application code; use it as a documented reference.
- Do not execute arbitrary connector code or weaken SSRF controls for convenience.
- Do not commit, push, merge, deploy, publish, or create releases without explicit approval.
- Keep secrets, runtime data, downloaded articles, archives, and local output out of Git.
- Mark planned behavior honestly; no fake endpoints, no-op services, or passing placeholder tests.
- Verify changes with `npm run check` and `npm test`; run `npm run test:engine` and
  `npm run test:e2e` for engine or user-journey changes. Acceptance gates are in
  `plan/13-validation.md`.
