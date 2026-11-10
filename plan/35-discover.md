# Discovery

Hosted installations only. Discovery suggests sources a reader doesn't follow yet, from what other
readers here follow together: if many people who follow A also follow B, a reader who follows A
is shown B, with A named as the reason. A self-hosted installation builds, keeps and serves none of
it, and its sidebar has no Discovery entry. Until the graph holds at least one source, the page shows
**Coming soon** instead of suggestions; it switches by itself once a source reaches the minimum.

## Signal and consent

- Only accounts that share count. Sharing is the preference `discoveryShare`, on unless the
  account switches it off (Settings → General, or on the Discover page). Switching it off marks
  the graph for a rebuild, which runs at the next maintenance tick at least a minute after the
  last one. Discovery is an exchange: an account that doesn't share gets no suggestions; the page
  tells it to turn sharing on.
- Only usable accounts (active, not being deleted) and their followed public `feed`, `youtube` and
  `podcast` sources count. Private sources (address kept as a secret), manual sources and followed
  shared collections never count, nor does an address with a user name or password in it.
- Sources are matched across accounts by `urlKey()` of the feed address (scheme, host case,
  trailing slash and tracking parameters don't split a source).

## Privacy rules

- A source enters the graph only when at least `DISCOVER_MIN_READERS` (10) different accounts
  follow it, and a pair only when 10 accounts follow both. Thinner data is dropped, never shown.
- The aggregate tables (`discovery_sources`, `discovery_pairs`) hold counts only, with no account
  or workspace. Counts never leave the server: a suggestion names the reader's own sources that led
  to it, or says "Popular with readers here".
- The title and site shown for a suggestion must each be used by at least 10 of its followers
  (otherwise the feed's host shows), so a name someone gave their own copy never shows to others.
  The address shown is the shared 10-reader key with its most common scheme.
- "Not interested" (`discovery_dismissed`) is per PURSS, only accepts sources that can be
  suggested, and is deleted with the account. It is not part of the export.

## Scoring and chance

Every candidate scores the sum, over the reader's followed sources, of
`together(a, b) / sqrt(followers(a) * followers(b))` (cosine similarity), so very popular sources
don't crowd out closer matches. Followed, unfollowed, privately followed (matched through the
private feed key) and dismissed sources are skipped.

Each score gets Gumbel noise seeded by the workspace and the UTC date: the order changes day to
day and holds within a day. Every fourth place is a wildcard drawn from popular sources (log
follower count plus noise). A reader whose sources match nothing, such as a new account, gets
popular sources with noise. At most 20 suggestions show.

## Operation

The graph is rebuilt in the maintenance tick every 6 hours, or within a minute of a sharing
change. The rebuild runs in the API process and is quadratic in each account's followed sources;
measure it on a realistic hosted database once accounts number in the thousands. On the current
hosted data (two dozen accounts, at most three followers per feed) the graph is empty and the page
says "Coming soon".

## Deferred

Not built: suggestions on Home, suggestions from published collections, notifications about
suggestions, and exporting dismissals.
