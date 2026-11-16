-- Pictures of Bluesky posts. Bluesky's feed carries a post's text and none of what is attached, so a post's picture is asked of the public API
-- once the post is here (services/bluesky.ts): how often it has been asked about and when last, so a post that can't be learned about is tried a
-- few times and then left alone. A Bluesky post is a post, not an article: the ones already collected take that kind too.
ALTER TABLE items ADD COLUMN embed_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN embed_at TEXT;
UPDATE items SET kind = 'post' WHERE kind = 'article' AND url LIKE 'https://bsky.app/profile/%/post/%';
CREATE INDEX items_embed_todo ON items(discovered_at) WHERE kind = 'post' AND image_url IS NULL AND embed_tries < 3;
