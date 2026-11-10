import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorById, connectorCatalog } from "./catalog.ts";
import { decodeBody, isFeedKind, parseContentType, sniffContent } from "./content-type.ts";
import { generateOpml, parseOpml, OPML_MAX_OUTLINES } from "./opml.ts";
import { looksPrivateUrl, privateUrlReason, redactUrl } from "./privacy.ts";

const SUBS = [
  { title: "Maya & Co. <Notes>", feedUrl: "https://maya.example/feed.xml", siteUrl: "https://maya.example/", folder: "Gardens" },
  { title: "Journal \"of\" Things", feedUrl: "https://journal.example/rss", siteUrl: null, folder: "Gardens" },
  { title: "Loose feed", feedUrl: "http://loose.example/atom", folder: null },
  { title: "Members only", feedUrl: "https://members.example/feed?token=abcdef123456789", folder: "Private" },
  { title: "Marked private", feedUrl: "https://ok.example/feed", private: true },
  { title: "Broken", feedUrl: "javascript:alert(1)" },
  { title: "Credentials", feedUrl: "https://user:pw@example.com/feed" },
];

test("OPML export writes validated fields only and leaves out private and credential-bearing sources", () => {
  const out = generateOpml(SUBS, { title: "My feeds", now: new Date("2026-11-03T12:00:00Z") });
  assert.equal(out.included, 3);
  assert.deepEqual(out.omitted, [
    { title: "Members only", reason: "private" },
    { title: "Marked private", reason: "private" },
    { title: "Broken", reason: "invalid" },
    { title: "Credentials", reason: "invalid" },
  ]);
  assert.match(out.xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<opml version="2.0">/);
  assert.match(out.xml, /<title>My feeds<\/title>/);
  assert.match(out.xml, /text="Maya &amp; Co\. &lt;Notes&gt;"/);
  assert.match(out.xml, /text="Journal &quot;of&quot; Things"/);
  assert.doesNotMatch(out.xml, /token=|abcdef123|user:pw|javascript:|members\.example|ok\.example/);
});

test("OPML round trip: export then import returns the same subscriptions and folders", () => {
  const out = generateOpml(SUBS.slice(0, 3));
  const parsed = parseOpml(out.xml);
  assert.ok(parsed.ok);
  assert.equal(parsed.title, "Subscriptions");
  assert.deepEqual(
    parsed.outlines.map((o) => [o.title, o.feedUrl, o.siteUrl, o.folder]),
    [
      ["Maya & Co. <Notes>", "https://maya.example/feed.xml", "https://maya.example/", "Gardens"],
      ['Journal "of" Things', "https://journal.example/rss", null, "Gardens"],
      ["Loose feed", "http://loose.example/atom", null, null],
    ],
  );
  assert.deepEqual(parsed.skipped, []);
});

test("OPML import: nested folders, alternative attributes, bad entries and duplicates are reported, not trusted", () => {
  const xml = `<?xml version="1.0"?><opml version="1.0"><head><title>Export from elsewhere</title></head><body>
    <outline text="Tech"><outline text="Deep"><outline type="rss" text="Nested" xmlUrl="https://nested.example/feed"/></outline></outline>
    <outline type="rss" title="Uses url attr" url="https://urlattr.example/rss"/>
    <outline text="No url folder only"/>
    <outline type="rss" text="Dup" xmlUrl="https://nested.example/feed"/>
    <outline type="rss" text="Localhost" xmlUrl="http://localhost:8080/feed"/>
    <outline type="rss" text="Private IP"  xmlUrl="http://127.0.0.1/feed"/>
    <outline type="rss" text="Login" xmlUrl="https://user:pw@login.example/feed"/>
    <outline type="rss" text="Script" xmlUrl="javascript:alert(1)"/>
    <outline type="rss" text="Secret" xmlUrl="https://secret.example/feed?token=abcdef123456789"/>
    <outline type="rss" text="Entities" xmlUrl="https://e.example/feed?a=1&amp;b=2" htmlUrl="https://e.example/"/>
  </body></opml>`;
  const r = parseOpml(xml);
  assert.ok(r.ok);
  assert.equal(r.title, "Export from elsewhere");
  assert.deepEqual(
    r.outlines.map((o) => [o.title, o.feedUrl, o.folder, o.looksPrivate]),
    [
      ["Nested", "https://nested.example/feed", "Tech / Deep", false],
      ["Uses url attr", "https://urlattr.example/rss", null, false],
      ["Secret", "https://secret.example/feed?token=abcdef123456789", null, true],
      ["Entities", "https://e.example/feed?a=1&b=2", null, false],
    ],
  );
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.reason, s.count]));
  assert.deepEqual(reasons, { duplicate: 1, "internal-address": 2, "has-login": 1, "not-a-web-address": 1 });
  assert.equal(r.truncated, false);
});

test("OPML import is bounded and robust", () => {
  const many = Array.from({ length: OPML_MAX_OUTLINES + 50 }, (_, i) => `<outline type="rss" text="f${i}" xmlUrl="https://f${i}.example/feed"/>`).join("");
  const r = parseOpml(`<opml><body>${many}</body></opml>`);
  assert.ok(r.ok);
  assert.equal(r.outlines.length, OPML_MAX_OUTLINES);
  assert.equal(r.truncated, true);
  const big = parseOpml("x".repeat(3 * 1024 * 1024));
  assert.ok(!big.ok);
  assert.equal(big.reason, "toolarge");
  for (const bad of ["", "   ", "<rss><channel/></rss>", "not xml at all", "<opml></opml>", "<opml><body></body></opml>"]) {
    const x = parseOpml(bad);
    assert.ok(!x.ok, bad);
  }
  const deep = parseOpml(`<opml><body>${"<outline text='x'>".repeat(5000)}</body></opml>`);
  assert.ok(!deep.ok);
  const lol = parseOpml(`<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lollollollollollollollollollol">]><opml><body><outline type="rss" text="&lol;&lol;&lol;" xmlUrl="https://x.example/f"/></body></opml>`);
  assert.ok(lol.ok);
  assert.ok(lol.outlines[0]!.title.length < 30, "DTD entities are not expanded");
  const withBytes = parseOpml(Buffer.from(`<opml><body><outline text="Café" xmlUrl="https://c.example/f"/></body></opml>`));
  assert.ok(withBytes.ok);
  assert.equal(withBytes.outlines[0]!.title, "Café");
});

test("private URL heuristics are warnings with sensible boundaries", () => {
  for (const url of [
    "https://x.example/feed?token=abcdef123456",
    "https://x.example/feed?auth=abcdefgh1234",
    "https://x.example/feed?api_key=abcdef&x=1",
    "https://x.example/private/feed.xml",
    "https://x.example/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/rss",
    "https://x.example/feed?id=3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d3f9a1c7e",
    "https://u:p@x.example/feed",
    "https://x.example/rss/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
  ]) {
    assert.ok(looksPrivateUrl(url), url);
  }
  for (const url of [
    "https://x.example/feed",
    "https://x.example/feed.xml?page=2",
    "https://x.example/2026/11/03/a-long-but-ordinary-slug-about-gardens/feed/",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghijklmnopqrstuvwxyz0123",
    "https://x.example/feed?key=1",
  ]) {
    assert.equal(privateUrlReason(url), null, url);
  }
});

test("redactUrl strips query, credentials and token-looking path pieces", () => {
  assert.equal(redactUrl("https://u:p@x.example/a/b?token=SECRET#frag"), "https://x.example/a/b?…");
  assert.equal(redactUrl("https://x.example/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/feed.xml"), "https://x.example/u/…/feed.xml");
  assert.equal(redactUrl("https://x.example/private/mysecretword/feed"), "https://x.example/private/…/feed");
  assert.equal(redactUrl("not a url"), "[invalid address]");
});

test("connector catalog is declarative, complete and honest", () => {
  assert.deepEqual(connectorCatalog.map((c) => c.id), ["native-feed", "youtube-channel", "fediverse-account", "bluesky-account"]);
  for (const c of connectorCatalog) {
    assert.equal(c.auth.needs, "none");
    assert.equal(c.version, 1);
    assert.ok(c.sourceTypes.length > 0);
    assert.ok(c.coverageLimits.length > 60);
    assert.ok(c.healthCodes.some((h) => h.code === "ok"));
    assert.ok(c.permittedDomains === "public-web" || c.permittedDomains.length > 0);
    assert.equal(c.capabilities.feedGeneration, false, "no adapter generates feeds in this build");
    assert.equal(c.capabilities.mediaPlayback, false);
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.capabilities), "descriptors are immutable");
  }
  const yt = connectorById("youtube-channel")!;
  assert.match(yt.coverageLimits, /most recent videos/);
  assert.match(yt.coverageLimits, /does not include full channel history/);
  assert.ok(yt.permittedDomains !== "public-web" && yt.permittedDomains.includes("youtube.com"));
  assert.equal(connectorById("nope"), undefined);
  assert.throws(() => {
    (connectorCatalog as unknown as unknown[]).push({});
  });
});

test("content sniffing and decoding helpers", () => {
  assert.equal(sniffContent(Buffer.from('<?xml version="1.0"?><rss version="2.0"><channel/></rss>')), "rss");
  assert.equal(sniffContent(Buffer.from('﻿  <feed xmlns="http://www.w3.org/2005/Atom"/>')), "atom");
  assert.equal(sniffContent(Buffer.from('<rdf:RDF xmlns:rdf="x"/>')), "rdf");
  assert.equal(sniffContent(Buffer.from('{"version":"https://jsonfeed.org/version/1.1","items":[]}')), "jsonfeed");
  assert.equal(sniffContent(Buffer.from('{"a":1}')), "json");
  assert.equal(sniffContent(Buffer.from("<!DOCTYPE html><html><head></head></html>")), "html");
  assert.equal(sniffContent(Buffer.from("<!-- c --><!DOCTYPE html PUBLIC 'x'><HTML>")), "html");
  assert.equal(sniffContent(Buffer.from("<?xml version='1.0'?><opml><head/><body/></opml>")), "xml");
  assert.equal(sniffContent(Buffer.from("<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml'><body/></html>"), "application/xhtml+xml"), "html");
  assert.equal(sniffContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), "binary");
  assert.equal(sniffContent(Buffer.from("just some words")), "text");
  assert.equal(isFeedKind("rss") && isFeedKind("jsonfeed") && !isFeedKind("html"), true);
  assert.deepEqual(parseContentType('Text/HTML; Charset="UTF-8"'), { mediaType: "text/html", charset: "utf-8" });
  assert.deepEqual(parseContentType(undefined), { mediaType: "", charset: null });
  assert.equal(decodeBody(Buffer.from("café", "latin1"), "text/html; charset=iso-8859-1"), "café");
  assert.equal(decodeBody(Buffer.from('<meta charset="windows-1252">caf\xe9', "latin1")), '<meta charset="windows-1252">café');
  assert.equal(decodeBody(Buffer.from("plain"), "text/plain; charset=nonsense-xyz"), "plain");
});

test("redactUrl always hides a bridge router signature, digits or not", () => {
  const digitFree = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
  assert.equal(digitFree.length, 43);
  assert.equal(redactUrl(`http://feed-bridge.internal:8945/b/telegram/durov/${digitFree}`), "http://feed-bridge.internal:8945/b/telegram/durov/…");
  assert.equal(redactUrl("https://example.org/b/blog/post/title"), "https://example.org/b/blog/post/title", "an ordinary path is left alone");
});
