-- The installation's own news: posts its administrators write, served as a public Atom feed (/news/feed.atom)
-- and put straight into every workspace that follows the built-in news source. No engine is involved.
CREATE TABLE news_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- as the administrator wrote it: paragraphs, "- " lists, [links](https://…), **bold**
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  author_account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
) STRICT;
CREATE INDEX news_posts_published ON news_posts(status, published_at DESC);

-- 'news': the workspace's built-in news source (one per workspace; unfollowing keeps the row, so it is not added again).
ALTER TABLE sources ADD COLUMN builtin TEXT CHECK (builtin IN ('news'));
CREATE UNIQUE INDEX sources_builtin ON sources(workspace_id, builtin) WHERE builtin IS NOT NULL;

-- One row per post per workspace it was put into, kept when the copy is deleted so it never comes back.
CREATE TABLE news_deliveries (
  post_id TEXT NOT NULL REFERENCES news_posts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT,                    -- the workspace's copy; it may since have been deleted
  delivered_at TEXT NOT NULL,
  revised_at TEXT NOT NULL DEFAULT '',   -- the post's updated_at the copy carries; an older one is brought up to date
  PRIMARY KEY (post_id, workspace_id)
) STRICT;
CREATE INDEX news_deliveries_workspace ON news_deliveries(workspace_id);
