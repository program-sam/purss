-- Which way discovery found a source, and how the person got to the lookup (domain/discovery-routes.ts). A followed source keeps
-- both, for the administrator's record of which routes are used and what becomes of the sources they find; sources followed before this
-- migration, and ones an archive brought in, have neither and stay NULL. `unfollowed_at` is when it was last unfollowed (NULL while followed), to
-- tell a source that was followed for a month from one that was dropped within days. None of the three is part of an export or an archive.
ALTER TABLE sources ADD COLUMN discovery_route TEXT;
ALTER TABLE sources ADD COLUMN discovery_entry TEXT;
ALTER TABLE sources ADD COLUMN unfollowed_at TEXT;

-- The same two ids as daily counters across the whole installation: how many candidates a route showed ("offered") and how many were
-- followed, per UTC day and entry. Nothing here names an account, a workspace, a source or an address, so it is kept apart from every
-- account's data. Rows older than 180 days are deleted when a new one is written.
CREATE TABLE discovery_routes (
  day TEXT NOT NULL,       -- UTC date, YYYY-MM-DD
  entry TEXT NOT NULL,     -- how the person got to the lookup: paste, site-search, podcast-search, …
  route TEXT NOT NULL,     -- which way discovery found the candidate: alternate-link, known:github, page-list, …
  offered INTEGER NOT NULL DEFAULT 0 CHECK (offered >= 0),
  followed INTEGER NOT NULL DEFAULT 0 CHECK (followed >= 0),
  PRIMARY KEY (day, entry, route)
) STRICT;
