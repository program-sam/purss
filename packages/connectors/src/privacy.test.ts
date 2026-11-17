import assert from "node:assert/strict";
import { test } from "node:test";
import { trimRoutePath } from "./trimmed.ts";
import { isCredentialParam, isPlainWord, privateUrlReason, redactUrl } from "./privacy.ts";

/**
 * Public feeds whose addresses hold ids that look random. The first group was met in use: Serious Eats' feed address (a uuid, found in its
 * own pages) and the two Al Jazeera feeds (uuids in every one of its pages) were warned about; a Yorkshire Post section page's feed was too.
 */
const PUBLIC_FEEDS = [
  // met in use
  "https://feeds-api.dotdashmeredith.com/v1/rss/google/ad57d421-0ff5-41e7-a5da-f2167b6d7f7a",
  "https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9",
  "https://www.aljazeera.com/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9/",
  "https://www.yorkshirepost.co.uk/yorkshire-heritage/rss",
  "https://www.yorkshirepost.co.uk/news/rss",
  // a newspaper's address ends in the article's number
  "https://www.yorkshirepost.co.uk/heritage/historic-england-to-recruit-40-heritage-construction-apprentices-in-yorkshire-4912345/rss",
  "https://www.yorkshirepost.co.uk/feed/historic-england-to-recruit-40-heritage-construction-apprentices-in-yorkshire-4912345",
  // podcast hosts: ids of shows and playlists, public in every directory
  "https://feeds.acast.com/public/shows/5f2d9c8b1a3e4d7c6b5a4f3e",
  "https://feeds.acast.com/public/shows/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d",
  "https://feeds.acast.com/public/shows/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d",
  "https://www.omnycontent.com/d/playlist/aaa12345-1234-4abc-9def-0123456789ab/bbb12345-1234-4abc-9def-0123456789ab/ccc12345-1234-4abc-9def-0123456789ab/podcast.rss",
  "https://api.omny.fm/orgs/some-org/programs/some-show/podcast.rss",
  "https://pinecast.com/feed/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d",
  "https://feeds.megaphone.fm/ADL9840290619",
  "https://feeds.simplecast.com/abc123XY",
  "https://feeds.simplecast.com/54nAGcIl",
  "https://feeds.buzzsprout.com/1234567.rss",
  "https://anchor.fm/s/7c3a9e1f/podcast/rss",
  "https://feeds.transistor.fm/the-daily-show-2023-season",
  "https://feeds.transistor.fm/5f2d9c8b1a3e4d7c6b5a4f3e",
  "https://feeds.redcircle.com/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d",
  "https://rss.art19.com/the-daily",
  "https://api.substack.com/feed/podcast/1491476.rss",
  // other public feeds with ids in them, on hosts that are not podcast hosts
  "https://example.org/shows/5f2d9c8b1a3e4d7c6b5a4f3e/feed",
  "https://example.org/shows/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d/episodes.xml",
  "https://example.org/rss/google/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d",
  "https://example.org/podcasts/0123456789abcdef0123456789abcdef/feed",
  "https://example.org/feed?v=0123456789abcdef0123456789abcdef",
  "https://example.org/feed?section=3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d",
  "https://example.org/the-daily-show-2023-season/feed",
  "https://example.org/podcasts/my-favourite_show_episode-list-2024/feed.xml",
  "https://example.org/NewsAboutLondonElections2024ThisYear/feed",
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA",
  "https://www.youtube.com/feeds/videos.xml?playlist_id=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
  "https://onlinelibrary.wiley.com/feed/14753121/most-recent",
  "https://rss.sciencedirect.com/publication/science/0012821X",
  "https://github.com/someone/somerepo/releases.atom",
  "https://github.com/someone/somerepo/commits/0123456789abcdef0123456789abcdef01234567.atom",
  "https://github.com/someone.atom",
  "https://medium.com/feed/@someone",
  "https://mastodon.social/@someone.rss",
  "https://www.reddit.com/r/hamburg/.rss",
  "https://feeds.bbci.co.uk/news/rss.xml",
  // query values that are topics, or short
  "https://example.org/feed?key=tech-news",
  "https://example.org/rss?code=sports",
  "https://example.org/feed?page=2&feed=rss2",
  "https://example.org/access/updates/feed",
  "https://example.org/key/ideas/feed.xml",
  "https://example.org/feed?token=abc",
  "https://example.org/feed?sort_key=date",
  // a feed path with ids that are not a Ghost private hash: another length, or not right before `rss`
  "https://blog.example.com/rss/",
  "https://blog.example.com/tag/news/rss/",
  "https://blog.example.com/0123456789abcdef0123456789abcdef/rss/",
  "https://blog.example.com/0123456789abcdef0123456789ab/rss/",
  "https://blog.example.com/0123456789abcdef0123456789abcd/feed/",
  "https://blog.example.com/0123456789abcdef0123456789abcd/posts/rss/",
  "https://feeds.pinboard.in/rss/u:someone/t:gardens/",
  "https://feeds.pinboard.in/rss/popular/",
];

test("public feeds, ids that look random included, are not taken for private links", () => {
  for (const url of PUBLIC_FEEDS) assert.equal(privateUrlReason(url), null, url);
});

/** Addresses that carry a credential: named in the query, announced in the path, a known private shape, or unmistakably machine-made. */
const PRIVATE_FEEDS = [
  // userinfo
  "https://u:p@feeds.acast.com/public/shows/x",
  // credential-named query parameters, whatever the value looks like
  "https://feeds.acast.com/public/shows/5f2d9c8b1a3e4d7c6b5a4f3e?token=abcdef123456",
  "https://pinecast.com/feed/the-show?access_token=abcdef",
  "https://example.org/feed?token=abcdef",
  "https://example.org/feed?secret=abc123",
  "https://example.org/feed?password=hunter22",
  "https://example.org/feed?X-Plex-Token=abcdef",
  "https://example.org/feed?feed_token=abcdef",
  "https://example.org/feed?private_token=abcdef",
  "https://example.org/feed?clientSecret=abcdef",
  "https://example.org/feed?api-key=abcdef",
  "https://example.org/feed?X-Amz-Signature=0123abcd",
  "https://example.org/feed?pass=sunshine",
  "https://example.org/feed?auth=correcthorse",
  "https://example.org/feed?sign=lollipops",
  "https://example.org/feed?private=hunterhunter",
  "https://example.org/feed?pk=mypassword",
  // names that could be topics, with values that are not words
  "https://example.org/feed?key=Zk9aQ2xRbTJw",
  "https://example.org/feed?key=abcd1234",
  "https://example.org/feed?feed_key=abcd1234",
  "https://example.org/feed?key=xkqzvbnmplrtwhjd",
  "https://example.org/feed?code=xkqzvbnmplrtwhjd",
  "https://example.org/feed?code=AB12cd34EF56",
  "https://example.org/feed?auth=abcdefgh1234",
  // known private-feed shapes of services
  "https://www.patreon.com/rss/podcastname?auth=lettersandnumbers",
  "https://www.patreon.com/rss/podcastname",
  "https://api.substack.com/feed/podcast/87281/s/87957/private/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d.rss",
  "https://github.com/octocat.private.atom?token=abc123",
  "https://github.com/octocat.private.atom",
  "https://github.com/octocat.private.actor?token=abc123",
  "https://feedbin.com/starred/Lx3E5w94M3mOKFtcttHK8w.xml",
  "https://feeds.transistor.fm/my-shows-title-u79f32242a1ec86b8",
  "https://acme.memberful.com/account/feeds?id=5555",
  "https://gitlab.com/dashboard/projects.atom?feed_token=glft-abc123",
  // Pinboard's feeds of private bookmarks hold the token in the path
  "https://feeds.pinboard.in/rss/secret:6493a84f72d86e7de130/u:someone/private/",
  "https://feeds.pinboard.in/rss/secret:6493a84f72d86e7de130/u:someone/t:gardens/",
  // a Ghost site in private mode serves its feed unauthenticated at its 30-hex-character public hash, on any host and under any prefix
  "https://blog.example.com/0123456789abcdef0123456789abcd/rss/",
  "https://blog.example.com/0123456789abcdef0123456789abcd/rss",
  "https://blog.example.com/0123456789ABCDEF0123456789abcd/rss/",
  "https://blog.example.com/tag/news/0123456789abcdef0123456789abcd/rss/",
  "https://blog.example.com/author/someone/0123456789abcdef0123456789abcd/rss/",
  "https://blog.example.com/blog/0123456789abcdef0123456789abcd/rss/2/",
  "https://my-ghost.ghost.io/0123456789abcdef0123456789abcd/rss/",
  "https://newsletter.example.org/0123456789abcdef0123456789abcd/rss/",
  // announced in the path
  "https://feeds.acast.com/private/shows/5f2d9c8b1a3e4d7c6b5a4f3e",
  "https://example.org/auth/news/rss",
  "https://example.org/private/feed.xml",
  "https://example.org/secret/anything/rss",
  "https://example.org/key/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA/feed",
  "https://example.org/access/8f14e45fceea167a5a36dedd4bea2543/feed",
  "https://example.org/auth/8f14e45fceea167a5a36dedd4bea2543/feed",
  // random material right after a word that names a feed's key or a person's own feed
  "https://example.org/feed/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d",
  "https://example.org/feed/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d",
  "https://example.org/feeds/0123456789abcdef0123.xml",
  "https://example.org/rss/0123456789abcdef0123",
  "https://example.org/rss/0123456789abcdef0123456789abcdef0123",
  "https://example.org/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/rss",
  "https://example.org/u/3f9a1c7e-5b2d-4f8a-9c0e-1d2b3a4f5e6d/rss",
  "https://example.org/subscribers/5f2d9c8b1a3e4d7c6b5a4f3e/feed.xml",
  "https://example.org/members/Zk9aQ2xRbTJwYzVkM2VhN2Zi/feed",
  // unmistakably machine-made, with nothing around it saying so
  "https://example.org/rss/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
  "https://example.org/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA/feed",
  "https://example.org/podcast/Lx3E5w94M3mOKFtcttHK8w.xml",
  "https://example.org/shows/0123456789abcdef0123456789abcdef0123456789abcdef/feed",
  "https://example.org/feed?id=3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d3f9a1c7e",
  "https://example.org/feed?s=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MFpbYXJ",
  // on a podcast host only ids are exempt: uuids, hex ids and short ones. A long mixed-case token is still a token.
  "https://feeds.simplecast.com/Zk9aQ2xRbTJwYzVkM2VhN2ZiYWJj0xAb",
  "https://subscribers.transistor.fm/Zk9aQ2xRbTJwYzVkM2VhN2Zi",
  "https://feeds.acast.com/public/shows/Zk9aQ2xRbTJwYzVkM2VhN2Zi",
  "https://www.omnycontent.com/d/playlist/Zk9aQ2xRbTJwYzVkM2VhN2Zi/podcast.rss",
];

test("a credential in the address, named, announced or unmistakably random, still warns", () => {
  for (const url of PRIVATE_FEEDS) assert.notEqual(privateUrlReason(url), null, url);
});

test("a private Ghost site's feed is named as one, wherever the hash sits, and a public Ghost feed is not", () => {
  assert.equal(privateUrlReason("https://blog.example.com/0123456789abcdef0123456789abcd/rss/"), "a private Ghost site's feed");
  assert.equal(privateUrlReason("https://blog.example.com/tag/news/0123456789abcdef0123456789abcd/rss/"), "a private Ghost site's feed");
  assert.equal(privateUrlReason("https://feeds.pinboard.in/rss/secret:6493a84f72d86e7de130/u:someone/private/"), "a Pinboard private feed");
  assert.equal(privateUrlReason("https://blog.example.com/rss/"), null);
  assert.equal(privateUrlReason("https://blog.example.com/tag/news/rss/"), null);
});

test("a name that could be a topic needs a value that is not a word; a short value is never a key", () => {
  assert.equal(isCredentialParam("key", "tech-news"), false);
  assert.equal(isCredentialParam("code", "sports"), false);
  assert.equal(isCredentialParam("token", "abc"), false);
  assert.equal(isCredentialParam("token", "abcdef"), true);
  assert.equal(isCredentialParam("Access_Token", "abcdef"), true);
  assert.equal(isCredentialParam("userKey", "Zk9aQ2xRbTJw"), true);
  assert.equal(isCredentialParam("channel_id", "UCX6OQ3DkcsbYNE6H8uQQuVA"), false);
  assert.equal(isCredentialParam("page", "Zk9aQ2xRbTJwYzVkM2Vh"), false);
  // A token that only keeps a place in a list is no key.
  for (const name of ["pageToken", "next_token", "cursor-token", "continuation_token"]) assert.equal(isCredentialParam(name, "Zk9aQ2xRbTJwYzVkM2Vh"), false, name);
});

test("a title with an id at its end is a slug, not a key", () => {
  // After `feed` it would be judged: an article's number does not make it random.
  for (const url of [
    "https://example.org/feed/historic-england-to-recruit-40-heritage-construction-apprentices-4912345",
    "https://example.org/feed/the-daily-show-2023-season",
  ]) assert.equal(privateUrlReason(url), null, url);
  assert.notEqual(privateUrlReason("https://example.org/feed/ab12cd34ef56gh78ij90kl12mn34"), null);
});

test("a name is a plain word only when it reads like words", () => {
  for (const w of ["news", "tech-news", "sports_extra", "a.b", "international-relations", "internationalisation"]) assert.ok(isPlainWord(w), w);
  for (const w of ["Zk9aQ2xRbTJw", "abcd1234", "News", "", "-x", "x".repeat(41), "xkqzvbnmplrtwhjd", "qwrtpsdfghjklzxcvb"]) assert.ok(!isPlainWord(w), w);
});

test("a secret in a feed's own address still warns on the hosts whose ids are public; the same ids elsewhere do not", () => {
  const A = "a7c186be-1baa-4bd4-9d80-a84db769f779";
  const B = "73d0e1b4-532f-45ef-b135-bfdff8b8cab9";
  for (const url of [
    `https://www.aljazeera.net/aljazeerarss/${A}/${B}?token=abcdef123456`,
    `https://u:p@www.aljazeera.net/aljazeerarss/${A}/${B}`,
    `https://www.aljazeera.net/aljazeerarss/${A}/${B}/private/${A}`,
    `https://www.aljazeera.net/aljazeerarss/Zk9aQ2xRbTJwZGZ4c2VjcmV0MTIzNDU2`,
    `https://example.org/feed/${A}`,
  ]) assert.notEqual(privateUrlReason(url), null, url);
  for (const url of [`https://evil.example/aljazeerarss/${A}/${B}`, `https://notaljazeera.net/aljazeerarss/${A}/${B}`]) {
    assert.equal(privateUrlReason(url), null, `${url}: no key in it, whichever host`);
  }
});

test("the feed gateway's addresses are logged without their signature and without the feed address they carry", () => {
  const key = "k".repeat(43);
  for (const feed of ["https://feeds.simplecast.com/54nAGcIl", "https://x.example/f/abc", "https://patreon.example/rss/show?auth=0123456789abcdef"]) {
    const redacted = redactUrl(`http://feed-gateway.internal:8947${trimRoutePath(key, feed)}`);
    assert.equal(redacted, "http://feed-gateway.internal:8947/t/…/…", feed);
  }
  assert.equal(redactUrl("https://example.org/t/news/today"), "https://example.org/t/news/today", "an ordinary address of that shape is not touched");
});
