import test from "node:test";
import assert from "node:assert/strict";
import { feedAddress } from "./feed-link.ts";

test("feed links become the address inside them; the shorthand becomes https, an explicit http stays http", () => {
  assert.equal(feedAddress("feed:https://example.org/rss.xml"), "https://example.org/rss.xml");
  assert.equal(feedAddress("feed:http://example.org/rss"), "http://example.org/rss");
  assert.equal(feedAddress("feed://example.org/rss?x=1"), "https://example.org/rss?x=1");
  assert.equal(feedAddress("podcast://pod.example/feed"), "https://pod.example/feed");
  assert.equal(feedAddress("pcast://pod.example/feed"), "https://pod.example/feed");
  assert.equal(feedAddress("  FEED:HTTPS://Example.org/A  "), "https://example.org/A");
});

test("anything else isn't a feed link", () => {
  for (const link of ["https://example.org/rss", "feed:javascript:alert(1)", "feed:file:///etc/passwd", "feed:", "feed:example.org/rss",
    "podcast:ftp://x.example/f", "feed://user:pw@example.org/rss", "purss://open?item=x", "feed:///nohost"]) {
    assert.equal(feedAddress(link), null, link);
  }
});
