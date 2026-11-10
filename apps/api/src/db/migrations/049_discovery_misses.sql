-- Sites people tried to follow without success (plan/41), for the administrator's Service health page. One row per UTC day, site and
-- reason, with a count. The site is only the registrable domain (`bandcamp.com`, never a path or a creator's subdomain); nothing here
-- names an account, a workspace or what was pasted, so it is kept apart from every account's data. Rows older than 180 days are deleted
-- when a new one is written.
CREATE TABLE discovery_misses (
  day TEXT NOT NULL,       -- UTC date, YYYY-MM-DD
  site TEXT NOT NULL,
  reason TEXT NOT NULL,    -- the discovery failure: nofeed, unsupported, unreachable or timeout
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, site, reason)
) STRICT;
