import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedParseError, detectSummariesOnly, parseDuration, parseFeed, parseFeedDate } from "./feed.ts";

const LONG_TEXT = "This is a long paragraph of real article text that goes on. ".repeat(60);

const RSS_BLOG = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Maya &amp; Co. Notes</title>
  <link>https://maya.example/</link>
  <atom:link href="https://maya.example/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Slow thoughts on gardens</description>
  <language>en-gb</language>
  <image><url>/logo.png</url><title>x</title><link>https://maya.example/</link></image>
  <item>
    <title><![CDATA[Compost &amp; patience]]></title>
    <link>https://maya.example/compost</link>
    <guid isPermaLink="false">post-1001</guid>
    <dc:creator><![CDATA[Maya Lindqvist]]></dc:creator>
    <pubDate>Mon, 02 Nov 2026 08:30:00 +0100</pubDate>
    <description><![CDATA[<p>Short intro</p>]]></description>
    <content:encoded><![CDATA[<p>${LONG_TEXT}</p><img src="/img/pile.jpg" width="640" height="480"><img src="https://t.example/p.gif" width="1" height="1">]]></content:encoded>
    <media:thumbnail url="https://maya.example/thumb.jpg"/>
  </item>
  <item>
    <title>Second post</title>
    <link>/second</link>
    <guid>https://maya.example/second</guid>
    <pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate>
    <description>Plain description</description>
    <author>maya@maya.example (Maya L.)</author>
  </item>
  <item>
    <title>No date, no guid</title>
    <link>https://maya.example/third</link>
  </item>
</channel>
</rss>`;

const RSS_EXCERPTS = `<rss version="2.0"><channel><title>Journal of Things</title><link>https://journal.example/</link><description>d</description>
${[1, 2, 3, 4]
  .map(
    (n) => `<item><title>Paper ${n}</title><link>https://journal.example/p${n}</link><guid>p${n}</guid><pubDate>Tue, 0${n} Sep 2026 10:00:00 GMT</pubDate><description>Abstract of paper ${n}, which studies things in detail and concludes that [&#8230;]</description></item>`,
  )
  .join("\n")}
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en" xml:base="https://atom.example/">
  <title type="html">Atom &amp;amp; Friends</title>
  <subtitle>All the news</subtitle>
  <link rel="self" href="https://atom.example/feed.atom"/>
  <link rel="alternate" type="text/html" href="/"/>
  <updated>2026-11-01T10:00:00Z</updated>
  <id>tag:atom.example,2026:feed</id>
  <entry>
    <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <em>there</em></div></title>
    <link rel="alternate" href="posts/hello"/>
    <link rel="enclosure" type="audio/mpeg" href="https://atom.example/hello.mp3" length="1234"/>
    <id>tag:atom.example,2026:hello</id>
    <published>2026-11-01T09:00:00-05:00</published>
    <updated>2026-11-01T10:00:00Z</updated>
    <author><name>Ada Atom</name></author>
    <summary>Just a summary</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Body with <a href="https://x.example/">link</a> &amp; stuff</p></div></content>
  </entry>
  <entry>
    <title>Second</title>
    <link href="https://atom.example/posts/second"/>
    <id>urn:uuid:2</id>
    <updated>2026-10-20T00:00:00Z</updated>
    <content type="html">&lt;p&gt;html body&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/"><title>RDF Site</title><link>https://rdf.example/</link><description>rdf desc</description></channel>
  <item rdf:about="https://rdf.example/a"><title>RDF A</title><link>https://rdf.example/a</link><description>A desc</description><dc:date>2026-09-09T09:09:09Z</dc:date><dc:creator>Rae</dc:creator></item>
  <item rdf:about="https://rdf.example/b"><title>RDF B</title><link>https://rdf.example/b</link></item>
</rdf:RDF>`;

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Cast",
  home_page_url: "https://json.example/",
  description: "A json feed",
  icon: "https://json.example/icon.png",
  items: [
    {
      id: "ep-1",
      url: "https://json.example/ep1",
      title: "Episode 1",
      content_text: "Line one\n\nLine two <b>",
      summary: "Sum",
      date_published: "2026-10-10T10:00:00Z",
      authors: [{ name: "Jules" }],
      attachments: [{ url: "https://json.example/ep1.mp3", mime_type: "audio/mpeg", size_in_bytes: 99, duration_in_seconds: 1830 }],
    },
    { id: 2, content_html: "<p>hi</p>", image: "/pic.png", date_modified: "2026-10-11T00:00:00Z", external_url: "https://elsewhere.example/x" },
  ],
});

const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id>
 <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
 <title>Some Channel</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <author><name>Some Channel</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
 <published>2015-01-01T00:00:00+00:00</published>
 <entry>
  <id>yt:video:VID00000001</id>
  <yt:videoId>VID00000001</yt:videoId>
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>Building a shed, part 1</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=VID00000001"/>
  <author><name>Some Channel</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
  <published>2026-10-30T15:00:00+00:00</published>
  <updated>2026-10-31T15:00:00+00:00</updated>
  <media:group>
   <media:title>Building a shed, part 1</media:title>
   <media:content url="https://www.youtube.com/v/VID00000001?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/VID00000001/hqdefault.jpg" width="480" height="360"/>
   <media:description>We start the foundations.
Second line.</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:VID00000002</id>
  <yt:videoId>VID00000002</yt:videoId>
  <title>Part 0</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=VID00000002"/>
  <published>2026-10-23T15:00:00+00:00</published>
  <media:group><media:thumbnail url="https://i2.ytimg.com/vi/VID00000002/hqdefault.jpg"/></media:group>
 </entry>
</feed>`;

const YOUTUBE_PLAYLIST = YOUTUBE.replace("<yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>\n <title>Some Channel</title>", "<yt:playlistId>PLabcdefghijklmnopqrstuvwxyz012345</yt:playlistId>\n <title>Shed playlist</title>");

const PODCAST = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
<title>The Garden Hour</title><link>https://garden.example</link><description>Weekly chat</description>
<itunes:author>Garden Hour Crew</itunes:author><itunes:image href="https://garden.example/cover.jpg"/><itunes:category text="Leisure"/>
<item><title>Ep 12: Soil</title><guid isPermaLink="false">ep-12</guid><pubDate>Wed, 28 Oct 2026 06:00:00 GMT</pubDate>
<enclosure url="https://cdn.garden.example/ep12.mp3?token=abc" length="48000000" type="audio/mpeg"/><itunes:duration>1:02:03</itunes:duration><itunes:image href="https://garden.example/ep12.jpg"/>
<description>Show notes for 12</description></item>
<item><title>Ep 11</title><guid>ep-11</guid><pubDate>Wed, 21 Oct 2026 06:00:00 GMT</pubDate><enclosure url="https://cdn.garden.example/ep11.mp3" length="1" type="audio/mpeg"/><itunes:duration>3723</itunes:duration></item>
</channel></rss>`;

test("RSS 2.0 blog: channel, items, content, creators, dates, images", () => {
  const feed = parseFeed(RSS_BLOG, "application/rss+xml");
  assert.equal(feed.format, "rss");
  assert.equal(feed.title, "Maya & Co. Notes");
  assert.equal(feed.siteUrl, "https://maya.example/");
  assert.equal(feed.description, "Slow thoughts on gardens");
  assert.equal(feed.language, "en-gb");
  assert.equal(feed.imageUrl, "https://maya.example/logo.png");
  assert.equal(feed.isPodcast, false);
  assert.equal(feed.items.length, 3);
  const [a, b, c] = feed.items;
  assert.equal(a!.title, "Compost & patience");
  assert.equal(a!.guid, "post-1001");
  assert.equal(a!.url, "https://maya.example/compost");
  assert.equal(a!.author, "Maya Lindqvist");
  assert.equal(a!.publishedAt, "2026-11-02T07:30:00.000Z");
  assert.match(a!.contentHtml ?? "", /<p>This is a long paragraph/);
  assert.equal(a!.summaryHtml, "<p>Short intro</p>");
  assert.equal(a!.imageUrl, "https://maya.example/thumb.jpg");
  assert.equal(b!.url, "https://maya.example/second");
  assert.equal(b!.guid, "https://maya.example/second");
  assert.equal(b!.author, "Maya L.");
  assert.equal(b!.publishedAt, "2026-10-30T12:00:00.000Z");
  assert.equal(c!.guid, null);
  assert.equal(c!.publishedAt, null);
  assert.equal(c!.contentHtml, null);
  assert.equal(feed.summariesOnly, false);
});

test("image falls back to the first real <img> and skips tracking pixels", () => {
  const feed = parseFeed(RSS_BLOG.replace('<media:thumbnail url="https://maya.example/thumb.jpg"/>', ""));
  assert.equal(feed.items[0]!.imageUrl, "https://maya.example/img/pile.jpg");
});

test("excerpt-only feeds are flagged summariesOnly; full-content feeds are not", () => {
  const excerpts = parseFeed(RSS_EXCERPTS);
  assert.equal(excerpts.items.length, 4);
  assert.equal(excerpts.summariesOnly, true);
  assert.equal(parseFeed(RSS_BLOG).summariesOnly, false);
  assert.equal(parseFeed(ATOM).summariesOnly, false);
  assert.equal(detectSummariesOnly([], false), false);
});

test("Atom: xhtml, html and text constructs, xml:base, enclosures, authors", () => {
  const feed = parseFeed(ATOM, "application/atom+xml");
  assert.equal(feed.format, "atom");
  assert.equal(feed.title, "Atom & Friends");
  assert.equal(feed.description, "All the news");
  assert.equal(feed.siteUrl, "https://atom.example/");
  assert.equal(feed.language, "en");
  const [a, b] = feed.items;
  assert.equal(a!.title, "Hello there");
  assert.equal(a!.url, "https://atom.example/posts/hello");
  assert.equal(a!.guid, "tag:atom.example,2026:hello");
  assert.equal(a!.author, "Ada Atom");
  assert.equal(a!.publishedAt, "2026-11-01T14:00:00.000Z");
  assert.equal(a!.summaryHtml, "Just a summary");
  assert.equal(a!.contentHtml, '<p>Body with <a href="https://x.example/">link</a> &amp; stuff</p>');
  assert.deepEqual(a!.enclosures, [{ url: "https://atom.example/hello.mp3", type: "audio/mpeg", length: 1234 }]);
  assert.equal(b!.contentHtml, "<p>html body</p>");
  assert.equal(b!.url, "https://atom.example/posts/second");
  assert.equal(b!.publishedAt, "2026-10-20T00:00:00.000Z");
});

test("prefixed Atom (atom:feed) is understood", () => {
  const xml = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Prefixed</atom:title><atom:entry><atom:title>E</atom:title><atom:id>1</atom:id><atom:link href="https://p.example/e"/></atom:entry></atom:feed>`;
  const feed = parseFeed(xml);
  assert.equal(feed.title, "Prefixed");
  assert.equal(feed.items[0]!.url, "https://p.example/e");
});

test("RSS 1.0 / RDF", () => {
  const feed = parseFeed(RDF);
  assert.equal(feed.format, "rdf");
  assert.equal(feed.title, "RDF Site");
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0]!.guid, "https://rdf.example/a");
  assert.equal(feed.items[0]!.author, "Rae");
  assert.equal(feed.items[0]!.publishedAt, "2026-09-09T09:09:09.000Z");
  assert.equal(feed.items[1]!.url, "https://rdf.example/b");
});

test("JSON Feed with attachments, authors, text content and fallbacks", () => {
  const feed = parseFeed(JSON_FEED, "application/feed+json");
  assert.equal(feed.format, "jsonfeed");
  assert.equal(feed.title, "JSON Cast");
  assert.equal(feed.siteUrl, "https://json.example/");
  assert.equal(feed.imageUrl, "https://json.example/icon.png");
  const [a, b] = feed.items;
  assert.equal(a!.author, "Jules");
  assert.equal(a!.durationSeconds, 1830);
  assert.equal(a!.enclosures[0]!.url, "https://json.example/ep1.mp3");
  assert.equal(a!.contentHtml, "<p>Line one</p><p>Line two &lt;b&gt;</p>");
  assert.equal(a!.summaryHtml, "Sum");
  assert.equal(b!.guid, "2");
  assert.equal(b!.url, "https://elsewhere.example/x");
  assert.equal(b!.imageUrl, "https://json.example/pic.png");
  assert.equal(b!.publishedAt, "2026-10-11T00:00:00.000Z");
  assert.equal(feed.isPodcast, true); // audio attachments on most items
});

test("a JSON document that is not a feed is rejected", () => {
  assert.throws(() => parseFeed('{"hello":"world"}'), FeedParseError);
  assert.throws(() => parseFeed('{"version":"https://jsonfeed.org/version/1","items":'), FeedParseError);
  assert.throws(() => parseFeed("[1,2,3]"), FeedParseError);
});

test("YouTube channel feed: identity, thumbnails, descriptions; the flash player URL is not an enclosure", () => {
  const feed = parseFeed(YOUTUBE, "application/atom+xml; charset=UTF-8");
  assert.deepEqual(feed.youtube, { channelId: "UCabcdefghijklmnopqrstuv", playlistId: null });
  assert.equal(feed.title, "Some Channel");
  assert.equal(feed.siteUrl, "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
  assert.equal(feed.summariesOnly, false);
  const [a, b] = feed.items;
  assert.equal(a!.videoId, "VID00000001");
  assert.equal(a!.title, "Building a shed, part 1");
  assert.equal(a!.url, "https://www.youtube.com/watch?v=VID00000001");
  assert.equal(a!.imageUrl, "https://i2.ytimg.com/vi/VID00000001/hqdefault.jpg");
  assert.equal(a!.author, "Some Channel");
  assert.equal(a!.enclosures.length, 0);
  assert.equal(a!.summaryHtml, "We start the foundations.<br>Second line.");
  assert.equal(b!.imageUrl, "https://i2.ytimg.com/vi/VID00000002/hqdefault.jpg");
  const playlist = parseFeed(YOUTUBE_PLAYLIST);
  assert.equal(playlist.youtube?.playlistId, "PLabcdefghijklmnopqrstuvwxyz012345");
  assert.equal(playlist.title, "Shed playlist");
});

test("podcast feeds are detected from iTunes tags and audio enclosures, with durations", () => {
  const feed = parseFeed(PODCAST);
  assert.equal(feed.isPodcast, true);
  assert.equal(feed.imageUrl, "https://garden.example/cover.jpg");
  const [a, b] = feed.items;
  assert.equal(a!.durationSeconds, 3723);
  assert.equal(b!.durationSeconds, 3723);
  assert.deepEqual(a!.enclosures, [{ url: "https://cdn.garden.example/ep12.mp3?token=abc", type: "audio/mpeg", length: 48000000 }]);
  assert.equal(a!.imageUrl, "https://garden.example/ep12.jpg");
  assert.equal(feed.summariesOnly, false);
  // audio enclosures alone (no itunes tags) also count when most items carry one
  const bare = parseFeed(`<rss><channel><title>t</title><item><title>a</title><enclosure url="https://a.example/1.mp3" type="audio/mpeg"/></item><item><title>b</title><enclosure url="https://a.example/2.mp3"/></item></channel></rss>`);
  assert.equal(bare.isPodcast, true);
  const blog = parseFeed(`<rss><channel><title>t</title><item><title>a</title><enclosure url="https://a.example/1.mp3" type="audio/mpeg"/></item><item><title>b</title></item><item><title>c</title></item></channel></rss>`);
  assert.equal(blog.isPodcast, false);
});

test("durations and dates in the many spellings feeds use", () => {
  assert.equal(parseDuration("62:03"), 3723);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("45"), 45);
  assert.equal(parseDuration("PT1H2M3S"), 3723);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseFeedDate("Sun, 06 Nov 2026 08:49:37 EST"), "2026-11-06T13:49:37.000Z");
  assert.equal(parseFeedDate("2026-11-03T10:00:00.000+0100"), "2026-11-03T09:00:00.000Z");
  assert.equal(parseFeedDate("2026-11-03 10:00:00 +0100"), "2026-11-03T09:00:00.000Z");
  assert.equal(parseFeedDate("not a date"), null);
  assert.equal(parseFeedDate("0001-01-01T00:00:00Z"), null);
  assert.equal(parseFeedDate(""), null);
});

test("malformed feeds are parsed as far as possible", () => {
  const broken = `<?xml version="1.0"?><rss version="2.0"><channel><title>Broken &nbsp; Feed</title><link>https://b.example/</link>
    <item><title>One<link>https://b.example/1</link><pubDate>garbage</pubDate></item>
    <item><title>Two</title><link>javascript:alert(1)</link><description>fine &bogus; text
    <item><title>Three</title><link>https://b.example/3</link></item>
    </channel>`; // unclosed tags, bad entity, no </rss>
  const feed = parseFeed(broken);
  assert.equal(feed.title, "Broken Feed");
  assert.ok(feed.items.length >= 1);
  assert.ok(feed.items.every((i) => i.url === null || i.url.startsWith("https://")), "no javascript: links survive");
  assert.ok(feed.items.every((i) => i.publishedAt === null));
});

test("non-feeds raise a plain FeedParseError", () => {
  assert.throws(() => parseFeed("<html><body>hello</body></html>"), (e: unknown) => e instanceof FeedParseError && e.code === "notfeed");
  assert.throws(() => parseFeed("   "), (e: unknown) => e instanceof FeedParseError && e.code === "empty");
  assert.throws(() => parseFeed("plain text"), FeedParseError);
  assert.throws(() => parseFeed("<rss><nochannel/></rss>"), FeedParseError);
});

test("item count is bounded and flagged", () => {
  const items = Array.from({ length: 500 }, (_, i) => `<item><title>t${i}</title><link>https://c.example/${i}</link></item>`).join("");
  const feed = parseFeed(`<rss><channel><title>big</title>${items}</channel></rss>`, null, { maxItems: 50 });
  assert.equal(feed.items.length, 50);
  assert.equal(feed.truncated, true);
  assert.equal(parseFeed(`<rss><channel><title>big</title>${items}</channel></rss>`).items.length, 200);
});

test("hostile nesting is refused quickly and entity tricks do not expand", () => {
  const depth = 300_000;
  const nested = `<rss><channel><title>deep</title><item><title>${"<b>".repeat(depth)}x</title></item></channel></rss>`;
  const started = Date.now();
  assert.throws(() => parseFeed(nested), (e: unknown) => e instanceof FeedParseError && e.code === "notfeed");
  const atomDeep = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><content type="xhtml"><div>${"<span>".repeat(depth)}deep</div></content></entry></feed>`;
  assert.throws(() => parseFeed(atomDeep), FeedParseError);
  assert.ok(Date.now() - started < 3000, "deep input must be rejected without stalling the parser");
  // Deep markup escaped inside a text node is just text for the feed parser (later stages bound it again).
  const escaped = `<rss><channel><title>t</title><item><title>a</title><description>${"&lt;div&gt;".repeat(depth)}</description></item></channel></rss>`;
  assert.equal(parseFeed(escaped).items.length, 1);
  // Reasonable nesting is fine.
  const fine = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><content type="xhtml"><div>${"<span>".repeat(100)}ok${"</span>".repeat(100)}</div></content></entry></feed>`;
  assert.match(parseFeed(fine).items[0]!.contentHtml ?? "", /ok/);
  const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><rss><channel><title>&lol2;</title><item><title>&lol2;&lol2;</title></item></channel></rss>`;
  const bomb = parseFeed(lol);
  assert.ok((bomb.title ?? "").length < 100, "DTD entities are not expanded");
  assert.throws(() => parseFeed("x".repeat(13 * 1024 * 1024)), (e: unknown) => e instanceof FeedParseError && e.code === "toolarge");
});

test("raw bytes are decoded using the declared encoding", () => {
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Café Müller</title><item><title>Crème</title></item></channel></rss>`;
  const feed = parseFeed(Buffer.from(xml, "latin1"), "application/rss+xml");
  assert.equal(feed.title, "Café Müller");
  assert.equal(feed.items[0]!.title, "Crème");
  const bom = parseFeed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<rss><channel><title>BOM</title></channel></rss>')]));
  assert.equal(bom.title, "BOM");
});

test("an empty channel yields a warning, not an error", () => {
  const feed = parseFeed("<rss><channel><title>quiet</title></channel></rss>");
  assert.equal(feed.items.length, 0);
  assert.match(feed.warnings.join(" "), /no entries/i);
});
