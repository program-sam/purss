import test from "node:test";
import assert from "node:assert/strict";
import { urlKey } from "./url-key.ts";

test("addresses that reach the same page share a key", () => {
  const same = (a: string, b: string) => assert.equal(urlKey(a), urlKey(b), `${a} vs ${b}`);
  same("https://Example.ORG/Post", "https://example.org/Post");
  same("http://example.org/post", "https://example.org/post");
  same("https://example.org:443/post", "https://example.org/post");
  same("http://example.org:80/post", "http://example.org/post");
  same("https://example.org./post", "https://example.org/post");
  same("https://example.org/post/", "https://example.org/post");
  same("https://example.org/post#comments", "https://example.org/post");
  same("https://example.org/post?utm_source=x&utm_medium=email&UTM_Campaign=y", "https://example.org/post");
  same("https://example.org/post?id=7&fbclid=abc&gclid=def&mc_eid=1", "https://example.org/post?id=7");
  same("https://example.org/post?", "https://example.org/post");
  same("https://bücher.example/a", "https://xn--bcher-kva.example/a");
  same("https://example.org", "https://example.org/");
  assert.equal(urlKey("https://example.org/a/b/?x=1#top"), "example.org/a/b?x=1");
});

test("addresses that may be different pages keep different keys", () => {
  const differ = (a: string, b: string) => assert.notEqual(urlKey(a), urlKey(b), `${a} vs ${b}`);
  differ("https://www.example.org/post", "https://example.org/post");
  differ("https://example.org/Post", "https://example.org/post");
  differ("https://example.org/post?id=1", "https://example.org/post?id=2");
  differ("https://example.org/post?a=1&b=2", "https://example.org/post?b=2&a=1");
  differ("https://example.org/post?ref=home", "https://example.org/post");
  differ("https://example.org:8443/post", "https://example.org/post");
  differ("https://app.example/#/article/1", "https://app.example/#/article/2");
  differ("https://old.example/#!/user/a", "https://old.example/#!/user/b");
  differ("https://example.org/post//", "https://example.org/post");
  differ("https://user@example.org/a", "https://example.org/a");
  // A default port is only dropped for its own scheme.
  differ("http://example.org:443/a", "https://example.org/a");
  // Encoded parameter names that decode to a tracking name are still removed; others stay as written.
  assert.equal(urlKey("https://example.org/?utm%5Fsource=x&q=a%20b"), "example.org/?q=a%20b");
});

test("only http and https addresses have a key", () => {
  for (const v of [null, undefined, "", "not a url", "ftp://example.org/a", "mailto:a@example.org", "javascript:alert(1)", "data:text/plain,hi", "file:///etc/passwd"]) {
    assert.equal(urlKey(v), null, String(v));
  }
});
