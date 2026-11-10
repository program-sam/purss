import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlainWord, privateUrlReason } from "./privacy.ts";

test("public feeds of the common podcast hosts, ordinary slugs and ordinary query values are not taken for private links", () => {
  for (const url of [
    "https://feeds.acast.com/public/shows/5f2d9c8b1a3e4d7c6b5a4f3e",
    "https://feeds.acast.com/public/shows/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d",
    "https://www.omnycontent.com/d/playlist/aaa12345-1234-4abc-9def-0123456789ab/bbb12345-1234-4abc-9def-0123456789ab/ccc12345-1234-4abc-9def-0123456789ab/podcast.rss",
    "https://api.omny.fm/orgs/some-org/programs/some-show/podcast.rss",
    "https://pinecast.com/feed/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d",
    "https://feeds.megaphone.fm/ADL9840290619",
    "https://feeds.simplecast.com/abc123XY",
    "https://feeds.buzzsprout.com/1234567.rss",
    "https://anchor.fm/s/7c3a9e1f/podcast/rss",
    "https://feeds.transistor.fm/the-daily-show-2023-season",
    "https://example.org/the-daily-show-2023-season/feed",
    "https://example.org/podcasts/my-favourite_show_episode-list-2024/feed.xml",
    "https://example.org/feed?key=tech-news",
    "https://example.org/rss?code=sports",
    "https://example.org/access/updates/feed",
    "https://example.org/key/ideas/feed.xml",
    // On a podcast host a 24-character hex id is an object id (a show), not a secret.
    "https://feeds.transistor.fm/5f2d9c8b1a3e4d7c6b5a4f3e",
  ]) assert.equal(privateUrlReason(url), null, url);
});

test("real credentials still trip it: userinfo, named secrets, keys and long random values in the path or the query", () => {
  for (const url of [
    "https://u:p@feeds.acast.com/public/shows/x",
    "https://feeds.acast.com/public/shows/5f2d9c8b1a3e4d7c6b5a4f3e?token=abcdef123456",
    "https://pinecast.com/feed/the-show?access_token=abcdef",
    "https://feeds.acast.com/private/shows/5f2d9c8b1a3e4d7c6b5a4f3e",
    "https://example.org/feed?token=abcdef",
    "https://example.org/feed?secret=abc123",
    "https://example.org/feed?password=hunter22",
    "https://example.org/feed?key=Zk9aQ2xRbTJw",
    "https://example.org/feed?key=abcd1234",
    // A letters-only value reads as a word only if it does; a long random run of letters does not.
    "https://example.org/feed?key=xkqzvbnmplrtwhjd",
    "https://example.org/feed?code=xkqzvbnmplrtwhjd",
    // Only key and code may carry a word: under these a word is a password.
    "https://example.org/feed?pass=sunshine",
    "https://example.org/feed?auth=correcthorse",
    "https://example.org/feed?sign=lollipops",
    "https://example.org/feed?private=hunterhunter",
    "https://example.org/feed?pk=mypassword",
    "https://example.org/auth/news/rss",
    // Hex is a secret from 20 characters; the object-id exemption is for the podcast hosts only.
    "https://example.org/shows/5f2d9c8b1a3e4d7c6b5a4f3e/feed",
    "https://example.org/rss/0123456789abcdef0123",
    // On a podcast host only ids are exempt: uuids, hex ids and short ones. A long mixed-case token is still a token.
    "https://feeds.simplecast.com/Zk9aQ2xRbTJwYzVkM2VhN2ZiYWJj0xAb",
    "https://subscribers.transistor.fm/Zk9aQ2xRbTJwYzVkM2VhN2Zi",
    "https://feeds.acast.com/public/shows/Zk9aQ2xRbTJwYzVkM2VhN2Zi",
    "https://www.omnycontent.com/d/playlist/Zk9aQ2xRbTJwYzVkM2VhN2Zi/podcast.rss",
    "https://example.org/feed?code=AB12cd34EF56",
    "https://example.org/feed?auth=abcdefgh1234",
    "https://example.org/key/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA/feed",
    "https://example.org/access/8f14e45fceea167a5a36dedd4bea2543/feed",
    "https://example.org/auth/8f14e45fceea167a5a36dedd4bea2543/feed",
    "https://example.org/private/feed.xml",
    "https://example.org/secret/anything/rss",
    "https://example.org/rss/0123456789abcdef0123456789abcdef0123",
    "https://example.org/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/rss",
    "https://example.org/u/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d/rss",
    "https://example.org/rss/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
    "https://example.org/feed?id=3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d3f9a1c7e",
  ]) assert.notEqual(privateUrlReason(url), null, url);
});

test("a plain word is a lowercase word or words with separators that reads like words, never a mixed-case, digit-bearing or random-letter value", () => {
  for (const w of ["news", "tech-news", "sports_extra", "a.b", "international-relations", "internationalisation"]) assert.ok(isPlainWord(w), w);
  for (const w of ["Zk9aQ2xRbTJw", "abcd1234", "News", "", "-x", "x".repeat(41), "xkqzvbnmplrtwhjd", "qwrtpsdfghjklzxcvb"]) assert.ok(!isPlainWord(w), w);
});
