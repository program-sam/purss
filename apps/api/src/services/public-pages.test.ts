import test from "node:test";
import assert from "node:assert/strict";
import { publicLink } from "./public-pages.ts";

test("a link is shown on a public page unless it carries a key; a private Ghost site's feed address does", () => {
  assert.equal(publicLink("https://blog.example.com/rss/"), "https://blog.example.com/rss/");
  assert.equal(publicLink("https://blog.example.com/tag/news/rss/"), "https://blog.example.com/tag/news/rss/");
  for (const url of [
    "https://blog.example.com/0123456789abcdef0123456789abcd/rss/",
    "https://blog.example.com/tag/news/0123456789abcdef0123456789abcd/rss/",
    "https://newsletter.example.org/0123456789abcdef0123456789abcd/rss/",
    "https://feeds.pinboard.in/rss/secret:6493a84f72d86e7de130/u:someone/private/",
  ]) assert.equal(publicLink(url), null, url);
});
