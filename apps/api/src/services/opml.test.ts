import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { createCollection } from "./collections.ts";
import { generateOpml, parseOpml, previewOpml } from "./opml.ts";
import { HttpError } from "../http.ts";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><head><title>Subscriptions</title></head><body>
  <outline text="Science">
    <outline type="rss" text="Sediment &amp; Silt" xmlUrl="https://example.org/feed/1.xml" htmlUrl="https://example.org/"/>
    <outline text="Deep folder"><outline type="rss" title="Deep feed" xmlUrl="https://deep.example/rss"/></outline>
  </outline>
  <outline type="rss" text="Loose" xmlUrl="https://loose.example/feed"/>
  <outline type="rss" text="Duplicate" xmlUrl="https://EXAMPLE.org/feed/1.xml#frag"/>
  <outline type="rss" text="Bad scheme" xmlUrl="javascript:alert(1)"/>
  <outline type="rss" text="File" xmlUrl="file:///etc/passwd"/>
  <outline type="rss" text="Credentials" xmlUrl="https://user:pw@secret.example/feed"/>
  <outline type="rss" text="Token" xmlUrl="https://tok.example/feed?token=ABCDEF123456"/>
  <outline text="No url at all"/>
</body></opml>`;

test("OPML parsing keeps folders, decodes entities, skips non-web addresses and duplicates", () => {
  const r = parseOpml(SAMPLE);
  assert.deepEqual(r.feeds.map((f) => [f.title, f.feedUrl, f.folder]), [
    ["Sediment & Silt", "https://example.org/feed/1.xml", "Science"],
    ["Deep feed", "https://deep.example/rss", "Deep folder"],
    ["Loose", "https://loose.example/feed", null],
    ["Token", "https://tok.example/feed?token=ABCDEF123456", null],
  ]);
  assert.equal(r.feeds[0]!.siteUrl, "https://example.org/");
  assert.deepEqual(r.skipped, { notWebAddress: 3, duplicates: 1 });
  assert.equal(r.truncated, false);
});

test("OPML parsing refuses other documents, deep nesting and oversized input; entities are never expanded", () => {
  assert.throws(() => parseOpml("<html><body>hi</body></html>"), (e: unknown) => e instanceof HttpError && e.code === "not_opml");
  assert.throws(() => parseOpml("not xml at all"), (e: unknown) => e instanceof HttpError && e.code === "not_opml");
  assert.throws(() => parseOpml(`<opml><body>${"<outline text='x'>".repeat(40)}${"</outline>".repeat(40)}</body></opml>`), (e: unknown) => e instanceof HttpError && e.code === "too_deep");
  // Deep nesting of any element, not only outlines, is refused before it can stall the parser.
  const started = Date.now();
  assert.throws(() => parseOpml(`<opml>${"<a>".repeat(200_000)}`), (e: unknown) => e instanceof HttpError && e.code === "too_deep");
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.throws(() => parseOpml("<opml>" + " ".repeat(2 * 1024 * 1024 + 1) + "</opml>"), (e: unknown) => e instanceof HttpError && e.status === 400);
  const xxe = parseOpml(`<?xml version="1.0"?><!DOCTYPE o [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml><body><outline type="rss" text="&x;" xmlUrl="https://a.example/f"/></body></opml>`);
  assert.ok(!xxe.feeds[0]!.title.includes("root:"), "external entities are not resolved");
  const many = parseOpml(`<opml><body>${Array.from({ length: 5100 }, (_, i) => `<outline xmlUrl="https://h${i}.example/f" text="f${i}"/>`).join("")}</body></opml>`);
  assert.equal(many.feeds.length, 5000);
  assert.equal(many.truncated, true);
});

test("preview flags feeds already followed and credential-shaped addresses", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Sediment Letters", "feed/1"); // https://example.org/feed/1.xml
  const r = previewOpml(app, p, SAMPLE);
  assert.equal(r.feeds[0]!.alreadyFollowing, true);
  assert.ok(r.feeds[0]!.sourceId);
  assert.equal(r.feeds[1]!.alreadyFollowing, false);
  assert.equal(r.feeds.find((f) => f.title === "Token")!.looksPrivate, true);
  assert.equal(r.feeds[2]!.looksPrivate, false);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 0, "an upload never reaches the engine");
});

test("OPML export lists only public followed sources, grouped by collection, with escaped attributes", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const a = makeSource(app, p, `Sediment "Letters" & <more>`, "feed/1");
  makeSource(app, p, "Private one", "feed/2", { isPrivate: true });
  const c = makeSource(app, p, "Credentialed", "feed/3");
  app.db.run("UPDATE sources SET feed_url = 'https://x.example/f?token=ABCDEF123456' WHERE id = ?", c);
  const d = makeSource(app, p, "Unfollowed", "feed/4");
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", d);
  makeSource(app, p, "Loose feed", "feed/5");
  createCollection(app, p, { name: "Science & Co", emoji: null, mode: "sources", sourceIds: [a], query: null, view: "list" });
  const out = generateOpml(app, p);
  assert.equal(out.included, 2);
  assert.equal(out.leftOut, 2);
  assert.ok(!out.xml.includes("token=") && !out.xml.includes("Private one") && !out.xml.includes("Unfollowed"));
  assert.ok(out.xml.includes('text="Sediment &quot;Letters&quot; &amp; &lt;more&gt;"'));
  assert.ok(out.xml.includes('<outline text="Science &amp; Co"'));
  const back = parseOpml(out.xml);
  assert.deepEqual(back.feeds.map((f) => [f.title, f.folder]).sort(), [[`Sediment "Letters" & <more>`, "Science & Co"], ["Loose feed", null]].sort());
});

test("preview and import judge a private link by the same rules discovery does: a key in the path counts, not only a key in the query", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const pathKey = "https://feeds.example/private/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c/feed.xml";
  const hexKey = "https://feeds.example/u/0123456789abcdef0123456789abcdef/rss";
  const plain = "https://feeds.example/blog/feed.xml";
  const doc = `<opml><body>${[pathKey, hexKey, plain].map((u, i) => `<outline type="rss" text="F${i}" xmlUrl="${u}"/>`).join("")}</body></opml>`;
  assert.deepEqual(previewOpml(app, p, doc).feeds.map((f) => f.looksPrivate), [true, true, false]);
});
