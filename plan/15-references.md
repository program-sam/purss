# Evidence and references

## Scope

These are primary sources for planning, not runtime acceptance. T3 Code documentation
and selected layout source were inspected. FreshRSS's release, API, Docker provisioning,
and default retention configuration were checked. The earlier FriRSS, Tuvix,
Tapestry, and Grayjay research informs the design but is not a security audit.
No third-party application code is incorporated in this repository.

## T3 Code design study

Pinned source snapshot: `32ecd71726fee16f335484c1f95cbce126d461f6`.

- [Thread/sidebar behavior](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/docs/user/thread-sidebar.md): context, pinning, state changes, undo.
- [Appearance](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/docs/user/appearance.md): themes, device preferences, reduced motion.
- [Project settings](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/docs/user/project-settings.md): setting scopes, inherited values, overrides.
- [Composer](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/docs/user/composer.md): provider/model selection and project defaults.
- [Provider onboarding](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/docs/user/providers-acp.md): catalog, local integrations, capabilities, sign-in.
- [Web sidebar shell](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/apps/web/src/components/AppSidebarLayout.tsx): panel and navigation layout boundaries.

The application here is different: Sources are user concepts; connections are
implementation details. No literal transplant of agent/model/provider vocabulary.

## FreshRSS engine baseline

Released baseline for feasibility: `1.30.4`, commit
`08f97bd497ace733c151ea1c709d85cd5b65cc53`. This is a researched baseline,
not an installed dependency or deployed container digest.

- [API documentation](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/docs/en/developers/06_GoogleReader_API.md): auth, subscriptions, streams, mutations, recommended sync references.
- [Docker documentation](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/Docker/README.md): first-run provisioning and `CRON_MIN` scheduling.
- [Retention configuration](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/config-user.default.php): combined retention limits and exemptions.
- [Entry conversion](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/app/Models/Entry.php): API representation and instance-local entry identity; verify during adapter work.
- [GReader implementation](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/p/api/greader.php): standard stream uses compatibility output; OPML import is marked trusted.
- [Extended OPML](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/docs/en/developers/OPML.md) and [CLI scripts](https://github.com/FreshRSS/FreshRSS/tree/08f97bd497ace733c151ea1c709d85cd5b65cc53/cli): candidate recipe/import and safe reconfiguration paths; do not forward untrusted extended options.
- [Website scraping](https://freshrss.github.io/FreshRSS/en/users/11_website_scraping.html): HTML/XPath, JSON paths, shared recipes. This live manual can drift from the baseline.
- [YouTube channel identity](https://support.google.com/youtube/answer/3250431): official explanation of channel IDs, not documentation of complete RSS coverage; actual public URL resolution and feed behavior remain spike requirements.

## Prior case studies and optional integrations

- [FriRSS](https://github.com/Fripix/Frirss): separate FreshRSS client, not selected as the product foundation.
- [Tuvix](https://github.com/TechSquidTV/Tuvix-RSS): integrated reader/curated-output reference, not the chosen engine.
- [Tapestry connectors](https://usetapestry.com/connectors/) and [public materials](https://github.com/TheIconfactory/Tapestry): source capability and mixed-content reference; not full app source.
- [Grayjay](https://grayjay.app/) and [plugin documentation](https://gitlab.futo.org/videostreaming/grayjay/-/blob/master/plugin-development.md): creator/media and permission concepts; not a hosted fork base.
- [RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge): optional reviewed site recipes, not bundled yet.
- [RSSHub](https://docs.rsshub.app/): optional routes/bridges, not bundled yet.

Before implementation, verify specific capabilities against pinned component code,
licenses, real source URLs, and the intended deployment. Documentation links alone
do not establish complete feed coverage, durable archives, or secure deployment.
