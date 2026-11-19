# Project instructions

- The repository holds code and documentation only, no planning documents. `docs/` and the
  component READMEs describe how the app works today; update them with every behaviour change.
- Build only what the owner approves; leave unapproved features unbuilt rather than half-built.
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
- Do not copy T3 Code branding or application code.
- Do not execute arbitrary connector code or weaken SSRF controls for convenience.
- Deploying: a push to `main` runs the "Test and deploy" workflow to https://purss.app; check
  `gh run list --branch main` and start it with `gh workflow run deploy.yml --ref main` if no run
  appears. Desktop, mobile, and extension store releases happen only when the owner asks.
- Keep secrets, runtime data, downloaded articles, archives, and local output out of Git.
- Describe limitations honestly; no fake endpoints, no-op services, or passing placeholder tests.
- Verify changes with `npm run check` and `npm test`; run `npm run test:engine` and
  `npm run test:e2e` for engine or user-journey changes. Acceptance checks are in
  `docs/development.md` (Testing and acceptance).
