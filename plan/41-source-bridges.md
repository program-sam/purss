# Source bridges

The owner approved following services that publish no feed through a bundled, self-hosted
[RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge), with a router in front of it so a
second backend (RSSHub) can be added later without changing anyone's sources. FreshRSS
stays the only engine that polls. This page records the design and what it defers.

## Scope

- Backend: RSS-Bridge only, pinned by image digest, with an allowlist of bridges.
- Services: only those that work without credentials from both a home and a datacenter
  address when enabled (tested live; see "Enabling a service"). Native feeds keep their
  existing discovery (Bluesky, Mastodon, YouTube and the rest are not bridged).
- Not now (owner's decision): Instagram, Facebook, Threads, X, TikTok, and anything that
  needs a session cookie or API key. Server-held provider tokens are allowed in principle
  but are a later step with their own review.
- Not now: RSSHub. The owner decides from the failure log whether it is needed.

## Services

Surveyed live on 2026-11-08 through RSS-Bridge from a home and a datacenter address.

| Enabled | Notes |
| --- | --- |
| Telegram public channels | A channel's posts carry its main name (`t.me/breakingmash` posts as `t.me/mash`); placeholders for media the web preview can't show are removed |
| Bandcamp artists and labels | `releases`, so each release keeps its own address |
| SoundCloud accounts | The latest 10 |
| Twitch past broadcasts | A channel without saved videos is an empty feed |
| Mixcloud accounts | The backend mixes in shows the account listened to; only its own (its name in the address) are kept |
| Rutube channels | The backend labels Moscow time as UTC; dates are moved back three hours |
| Apple Music artists | Releases in no order, up to 50 |

| Not enabled | Why |
| --- | --- |
| Patreon, Rumble | Blocked from datacenter addresses (Cloudflare and others) |
| Pixiv | Fails after the first fetch without a signed-in session |
| Unsplash | Needs an API key now |
| Goodreads | Needs redirects followed, which RSS-Bridge does only with a weaker address check |
| Ko-fi, Songkick, VK | Bridge broken by site changes (Songkick silently empty) |
| ArtStation, Dribbble, Newgrounds, Etsy, Itch.io | Blocked by bot protection, or search and product pages only |
| YouTube posts tab | Consent redirect from European addresses |
| Discogs | Invented dates and broken label links |
| Google Play, App Store, 9GAG | Not a person or channel to follow; the App Store gives every version one id |
| VK Video | Works by posing as Google's crawler; left to the owner |
| Instagram, Facebook, Threads, X, TikTok | Owner's decision, for later |

## Source identity

A bridged source's feed address in the product is a descriptor, `bridge:<service>/<key>`
(for example `bridge:telegram/durov`): no host, port, backend or credential. The key is
the service's public handle, lower-cased where the service ignores case; a renamed handle
is a new source. The descriptor is what the database, exports and job payloads carry.
Only the worker turns it into an engine address, in the same place it resolves private
links (`apps/worker/src/secrets.ts`):

`http://feed-bridge.internal:8945/b/<service>/<key>/<sig>`, where `sig` is an HMAC of
`<service>/<key>` under `secrets/bridge-key`.

- The bridge key is a durable installation secret, created once and kept with the other secrets
  (and in `--include-secrets` backups). It is never rotated: what it protects is that FreshRSS
  fetches only addresses this installation made, of public pages, so a leaked key costs at most
  unsolicited fetches of allowlisted public sources, while replacing it would orphan every signed
  address FreshRSS holds. A missing key file stops egress from starting while the bridge is
  configured. A replaced key makes the router answer 404 to every address FreshRSS holds; those
  answers are not in the fetch log, and the sources only go quiet (per-source health from the
  bridge is deferred, below). Following such a source again (unfollow, then follow the same page)
  re-subscribes it with a fresh address and keeps its items, whose post ids are unchanged.
- OPML export writes the service's page address (`https://t.me/durov`) as the feed address,
  which re-imports here (discovery resolves it again) and is the honest best for other
  readers. The account archive keeps the descriptor and restores it unchanged.
- Discovery accepts a page address of an enabled service and the descriptor itself. An
  installation that does not run the bridge answers both with the existing "doesn't
  publish feeds" message.

## Components

```text
FreshRSS ──proxy (alias)──► egress: bridge router :8945 ──bridge-net──► RSS-Bridge
API discovery ─────────────► egress: bridge router (preview)                │
                                 └─ bridge_fetches (egress SQLite)            └─bridge-net──► egress proxy ──► internet
```

- **RSS-Bridge** (`bridge` service): on its own internal network, `bridge-net`, shared only
  with egress; no route out and no other peers. Its `proxy_url` is the egress proxy's
  address on `bridge-net`, so every request passes the same address, redirect and size
  rules as FreshRSS's. Only allowlisted bridges are enabled, `error_output = http` makes
  its failures HTTP errors instead of error entries, PHP's memory limit and the container
  limit (96 MiB) bound a decompression bomb inside a TLS tunnel.
- **Bridge router** (egress process, its own listener on egress's internal address, port
  8945, reachable from FreshRSS only through the proxy alias `feed-bridge.internal:8945`
  and from the API directly) serves `GET /b/<service>/<key>/<sig>` and nothing else.
  - A wrong or missing `sig` is `404`, so a public feed that redirects FreshRSS to the alias
    gets nothing (cURL does not reuse the address, and the attacker cannot sign).
  - Only catalogued services and keys matching the service's pattern are accepted.
  - Backends are asked in order (RSS-Bridge now) with time and size bounds, at most four
    upstream fetches at once, one fetch per key at a time (concurrent requests share it),
    a 10-minute shared cache of good answers (public data only), and after a failure a
    back-off for that key during which the cached answer, or the failure, is repeated.
  - The answer is re-served as RSS. Each entry's GUID is the service's stable post id from
    its canonical post address (a per-service rule with fixtures, for example
    `telegram:<channel>/<message>`), its link the canonical post address. An entry without
    one is dropped. A source thus keeps its items when its backend changes.
  - A failure is `502`/`503` with `Retry-After`, never an empty success; a real empty feed
    is `200` with no items.
- **Discovery** (`packages/connectors`): resolves an enabled service's page address to the
  descriptor and previews it through a narrow internal client for the router (the API's
  `safeFetch` and its address rules are unchanged).

## Failure log

Today there is no per-source fetch history: a source has its current health (subscription
failures; staleness is computed when shown), failed jobs keep their last error, and
source-failure notifications record episodes, but FreshRSS's per-feed errors are not read.
Two administrator-only records are added, neither tied to an account:

- `bridge_fetches` (egress SQLite): time, service, key, backend, phase (`backend`,
  `parse`, `identity`), outcome (`ok`, `empty`, `http_<status>`, `timeout`, `too_large`,
  `parse_error`), entry count, duration, served from cache or not. Upstream attempts and
  cached answers are counted apart. Kept 30 days and at most 200,000 rows.
- `discovery_misses` (product database): day, site (the registrable domain, for example
  `bandcamp.com`, never the path or a creator's subdomain), reason, count. Kept 180 days.

Both are read only through administrator routes (the egress control listener with the
service token, then the API's admin service). The administrator's Service health page
shows, per bridged service, the last 7 days' success rate and the keys failing now, and
the sites people most often try to follow without success.

## Enabling a service

A service is enabled when its bridge, run from the server's address and from a home
address, returns real recent entries for popular accounts. Each enabled service has a
URL pattern, key pattern, reserved path segments and GUID rule in the catalogue, with
recorded-fixture tests. A service that mostly fails for a week is a candidate for a
second backend or for removal.

## Acceptance

`npm run check`, `npm test`, `npm run test:engine` and `npm run test:e2e`, plus tests for:
a redirect from a public feed to the alias, a forged or missing signature, export and
import round trips, the GUID rule across two backends' output for the same posts, cache
and back-off, size and time limits, and restart. The dev stack (`npm run dev`) and Compose
both start and stop the bridge. Peak memory with concurrent fetches is measured against
the server's budget.

## Deferred

- RSSHub as a second backend (the router takes an ordered backend list per service).
- Services needing credentials, and Meta, X and TikTok.
- Per-source health from bridge failures in the product (a failing bridged source shows as
  quiet after the usual quiet period; the administrator sees the failure at once).
- Reading FreshRSS's per-feed errors for ordinary feeds into the failure log.
