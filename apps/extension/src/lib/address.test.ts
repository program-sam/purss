import test from "node:test";
import assert from "node:assert/strict";
import { deepLink, isWebPage, itemLink, withoutFragment } from "./address.ts";

test("only web pages other than the PURSS can be kept", () => {
  assert.ok(isWebPage("https://news.example/a", "https://ws.example"));
  assert.ok(isWebPage("http://news.example/a", null));
  for (const u of [undefined, "", "chrome://extensions", "about:blank", "file:///home/x.html", "moz-extension://x/popup.html", "https://ws.example/b/x", "not a url"]) {
    assert.ok(!isWebPage(u, "https://ws.example"), String(u));
  }
  assert.equal(withoutFragment("https://a.example/p?q=1#frag"), "https://a.example/p?q=1");
  assert.equal(withoutFragment("https://a.example/p"), "https://a.example/p");
});

test("deep links carry the page, cut to what the PURSS accepts", () => {
  const add = new URL(deepLink("https://ws.example", { kind: "add", url: "https://blog.example/feed.xml?x=1&y=2", title: "ignored" })!);
  assert.equal(add.origin + add.pathname, "https://ws.example/app/");
  assert.deepEqual(Object.fromEntries(add.searchParams), { dialog: "add", url: "https://blog.example/feed.xml?x=1&y=2" });
  const keep = new URL(deepLink("https://ws.example", { kind: "keep", url: "https://a.example/p#x", title: `  ${"t".repeat(400)} ` })!);
  assert.deepEqual([keep.searchParams.get("dialog"), keep.searchParams.get("url"), keep.searchParams.get("title")?.length], ["keep", "https://a.example/p#x", 300]);
  assert.equal(new URL(deepLink("https://ws.example", { kind: "keep", url: "https://a.example/", title: "  " })!).searchParams.has("title"), false);
  assert.equal(deepLink("https://ws.example", { kind: "keep", url: `https://a.example/${"x".repeat(2000)}` }), null, "too long to hand over");
  const search = new URL(deepLink("https://ws.example", { kind: "search", q: " tides & storms " })!);
  assert.deepEqual(Object.fromEntries(search.searchParams), { dialog: "search", q: "tides & storms" });
  assert.equal(itemLink("https://ws.example", "itm_1", "bsk_2"), "https://ws.example/app/b/bsk_2?item=itm_1");
  assert.equal(itemLink("https://ws.example", "itm_1", null), "https://ws.example/app/?item=itm_1");
});
