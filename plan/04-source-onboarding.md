# Guided source onboarding

Keep the flow visual and brief: paste a link, recognize the source preview, choose
what to follow, confirm. Use short labels and one clear primary action per step;
reveal technical explanations only when needed. Keep source identity, access limits,
and any materially different subscription scope visible rather than hidden in help.

## User flow

1. Paste a website, feed, publisher page, channel URL, or supported handle.
2. Normalize and validate it without fetching unsafe destinations.
3. Discover available feeds or recognize a reviewed source type.
4. Show source identity, sample items, format, expected coverage, and health.
5. Ask which collection and default view to use; offer sensible defaults.
6. Follow it, report initial import progress, and return to the chosen collection.

The normal path must never ask for a FreshRSS URL, API password, XPath, or Docker
hostname. Advanced diagnostics live behind an explicit details affordance.
Always call the followed object a Source. Provider terms can explain a selected
resource but never replace the shared workflow vocabulary. A supported connected
source uses external authorization, selection, preview, and Follow; signing into
this product and authorizing a source are separate, independently consented actions.
Show a subtle connected/private indicator and capability limits alongside the same
views and controls. Never turn an unavailable API or failed login into an empty feed.

## Discovery outcomes

| Input/outcome | User-facing behavior |
| --- | --- |
| Direct RSS/Atom/JSON Feed | Validate and preview; explain if only summaries are supplied |
| Website with alternate feeds | Detect candidate links; label news, comments, podcasts, or sections |
| Publisher with several journals | Choose specific titles; do not imply one feed covers the whole publisher |
| Issue feed versus online-first | Explain coverage and permit both; preserve provenance and avoid duplicate presentation |
| YouTube channel | Resolve a stable channel identity and preview its official channel feed where supported |
| YouTube handle, video, or playlist | Resolve only supported channel cases; ask before following a related channel |
| Mastodon/fediverse or Bluesky account | Resolve the handle or profile to the account's own public feed and say what it leaves out ([plan/28](28-eink-and-social-sources.md)) |
| Known non-feed source | Offer an approved connector and explain any authentication requirements |
| No supported method | Say what failed and offer manual keep, supported alternatives, or a source request |

YouTube is a feasibility gate: prove handle/channel resolution and feed coverage
against real URLs. Never claim full channel history, every content type, playlists,
watch history, or account-wide subscription import based on a channel feed. No
unofficial authenticated scraper in the first slice.

## Honest previews

Show fetched-at time, sample item dates, and whether content is issue-based or
recent-item only when known. A successful fetch does not prove completeness.
Surface duplicate subscriptions, redirects, invalid XML, empty feeds, rate limits,
auth expiry, and unavailable domains with a specific recoverable action.

## Progressive disclosure

Default: paste, preview, follow. Optional: choose variants, refresh preference,
content extraction, and rules. Expert recipes and diagnostics belong outside the
happy path. Persist pending discovery state so retry/back does not lose choices.
Do not subscribe or fetch third-party embeds merely by opening a search suggestion.
