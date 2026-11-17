import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "@purss/connectors";
import { FeedTrimmer, rootWithBase, TRIM_LIMITS, trimDocument } from "./trim.ts";
import type { TrimResult } from "./trim.ts";

const NS =
  'xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom"';
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" ${NS}>
<channel>
  <title>The Show</title>
  <link>https://show.example/</link>
  <description><![CDATA[A show about <item>things</item> & more]]></description>
  <itunes:author>Show Author</itunes:author>
  <itunes:image href="https://show.example/art.jpg"/>
  <image><url>https://show.example/art.jpg</url><title>The Show</title><link>https://show.example/</link></image>
`;
const TAIL = "</channel>\n</rss>\n";
const minutes = (i: number): Date => new Date(Date.UTC(2026, 0, 1, 0, i));

function item(i: number, opts: { date?: Date | null; body?: string; title?: string } = {}): string {
  const date = opts.date === undefined ? minutes(i) : opts.date;
  return `<item>
  <title>${opts.title ?? `Episode ${i}`}</title>
  <guid isPermaLink="false">ep-${i}</guid>
  <link>https://show.example/ep/${i}</link>${date ? `\n  <pubDate>${date.toUTCString()}</pubDate>` : ""}
  <itunes:duration>12:34</itunes:duration>
  <enclosure url="https://cdn.example/${i}.mp3" length="123" type="audio/mpeg"/>
  <description><![CDATA[${opts.body ?? `<p>Notes ${i}</p>`}]]></description>
</item>
`;
}

const feed = (items: string[], head = HEAD, tail = TAIL): string => head + items.join("") + tail;
const ok = (r: TrimResult): Extract<TrimResult, { ok: true }> => {
  assert.ok(r.ok, r.ok ? "" : `failed: ${r.reason}`);
  return r as Extract<TrimResult, { ok: true }>;
};
const titles = (body: Buffer): string[] => parseFeed(body, "application/rss+xml", { maxItems: 1000 }).items.map((i) => i.title ?? "");
const guids = (body: Buffer): number[] => [...body.toString("latin1").matchAll(/<guid[^>]*>ep-(\d+)<\/guid>/g)].map((m) => Number(m[1]));

test("a newest-first feed gives its newest items, verbatim, and is read to its end", () => {
  const all = Array.from({ length: 1000 }, (_, k) => item(1000 - k)); // newest first: ep-1000 ... ep-1
  const doc = feed(all);
  const r = ok(trimDocument(doc, { maxItems: 100 }));
  assert.equal(r.kept, 100);
  assert.equal(r.seen, 1000);
  assert.equal(r.complete, true);
  assert.equal(r.bytesRead, doc.length, "nothing in a feed says that the rest is older, so all of it is read");
  const out = r.body.toString("latin1");
  assert.ok(out.startsWith(HEAD), "the channel's metadata comes back exactly");
  assert.ok(out.includes("<itunes:image href=\"https://show.example/art.jpg\"/>"));
  assert.ok(out.endsWith("</channel></rss>\n"), "the channel is closed");
  assert.deepEqual(guids(r.body), Array.from({ length: 100 }, (_, k) => 1000 - k));
  for (const k of [1000, 951, 901]) assert.ok(out.includes(item(k)), `ep-${k} is unchanged`);
  assert.equal(titles(r.body).length, 100, "the copy is a feed the preview parser reads");
});

test("an unordered feed gives its newest items however they are listed, and is read to its end", () => {
  const order = Array.from({ length: 600 }, (_, k) => (k * 37) % 600); // a permutation of 0..599
  const doc = feed(order.map((i) => item(i)));
  const r = ok(trimDocument(doc, { maxItems: 100 }));
  assert.equal(r.complete, true);
  assert.equal(r.seen, 600);
  assert.deepEqual(guids(r.body), Array.from({ length: 100 }, (_, k) => 599 - k), "the 100 newest, newest first");
});

test("an oldest-first feed gives its last (newest) items", () => {
  const doc = feed(Array.from({ length: 300 }, (_, i) => item(i)));
  const r = ok(trimDocument(doc, { maxItems: 50 }));
  assert.deepEqual(guids(r.body), Array.from({ length: 50 }, (_, k) => 299 - k));
  assert.equal(r.complete, true);
});

test("a newer item after more than 200 items in descending order is kept: the first ones in order say nothing of the rest", () => {
  // The case that an early stop on "the first items are in order" loses: 200 descending items, the newest at position 201, then older ones.
  const descending = (from: number, count: number) => Array.from({ length: count }, (_, k) => item(from - k));
  const doc = feed([...descending(1200, 200), item(9999), ...descending(800, 800)]);
  for (const size of [16 * 1024, 997, 1 << 20]) {
    const r = ok(trimDocument(doc, { maxItems: 100 }, size));
    assert.equal(r.seen, 1001);
    assert.equal(r.complete, true);
    assert.deepEqual(guids(r.body), [9999, ...Array.from({ length: 99 }, (_, k) => 1200 - k)], `chunks of ${size}`);
  }
  // The same when it is the room in bytes, not the number of items, that is full.
  const big = (i: number) => item(i, { body: "z".repeat(20_000) });
  const heavy = feed([...Array.from({ length: 60 }, (_, k) => big(600 - k)), big(9000), ...Array.from({ length: 60 }, (_, k) => big(500 - k))]);
  const h = ok(trimDocument(heavy, { maxItems: 100, maxKeptBytes: 150_000 }, 8192));
  assert.equal(guids(h.body)[0], 9000);
});

test("a feed whose first items only happen to be in order is still read to its end", () => {
  const lucky = [...Array.from({ length: 100 }, (_, k) => item(100 - k)), ...Array.from({ length: 150 }, (_, k) => item(500 - k))];
  const r = ok(trimDocument(feed(lucky), { maxItems: 100 }));
  assert.deepEqual(guids(r.body), Array.from({ length: 100 }, (_, k) => 500 - k).filter((n) => n >= 401), "the newest 100 are the later ones");
  assert.equal(r.complete, true);
  const sameDay = new Date(Date.UTC(2026, 0, 1));
  const ties = [...Array.from({ length: 120 }, (_, k) => item(k, { date: sameDay })), ...Array.from({ length: 20 }, (_, k) => item(1000 + k))];
  const t = ok(trimDocument(feed(ties), { maxItems: 100 }));
  assert.deepEqual(guids(t.body).slice(0, 20), Array.from({ length: 20 }, (_, k) => 1019 - k), "later, newer items beat a long run of equal dates");
});

test("a feed with fewer items than the limit comes back whole and in the same order", () => {
  const items = [item(5), item(3), item(4)];
  const r = ok(trimDocument(feed(items), { maxItems: 100 }));
  assert.equal(r.kept, 3);
  assert.deepEqual(guids(r.body), [5, 4, 3]); // newest first
  for (const it of items) assert.ok(r.body.toString("latin1").includes(it));
});

test("items with no dates keep the feed's own order, and undated items follow the date before them", () => {
  const undated = Array.from({ length: 30 }, (_, i) => item(i, { date: null }));
  const r = ok(trimDocument(feed(undated), { maxItems: 10 }));
  assert.deepEqual(guids(r.body), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(r.complete, true);
  assert.equal(r.seen, 30, "an undated feed is read to its end as well, and the first ones listed are kept");
  const mixed = ok(trimDocument(feed([item(9), item(8, { date: null }), item(7), item(6)]), { maxItems: 3 }));
  assert.deepEqual(guids(mixed.body), [9, 8, 7]);
});

test("date spellings: dc:date, Atom published and updated, dates in CDATA", () => {
  const dc = (i: number) => `<item><title>t${i}</title><guid>ep-${i}</guid><dc:date>${minutes(i).toISOString()}</dc:date></item>\n`;
  const cd = (i: number) => `<item><title>t${i}</title><guid>ep-${i}</guid><pubDate><![CDATA[${minutes(i).toUTCString()}]]></pubDate></item>\n`;
  const head = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>x</title>`;
  assert.deepEqual(guids(ok(trimDocument(feed([dc(1), dc(5), dc(3)], head), { maxItems: 2 })).body), [5, 3]);
  assert.deepEqual(guids(ok(trimDocument(feed([cd(1), cd(5), cd(3)], head), { maxItems: 2 })).body), [5, 3]);
  const atomEntry = (i: number) => `<entry><title>t${i}</title><id>ep-${i}</id><updated>${minutes(i).toISOString()}</updated><published>${minutes(i + 1000).toISOString()}</published></entry>\n`;
  const atomHead = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><id>urn:a</id>`;
  const a = ok(trimDocument(`${atomHead}${atomEntry(1)}${atomEntry(9)}${atomEntry(4)}</feed>`, { maxItems: 2 }));
  assert.equal(a.root, "feed");
  assert.deepEqual([...a.body.toString("latin1").matchAll(/<id>ep-(\d+)<\/id>/g)].map((m) => Number(m[1])), [9, 4]);
  assert.ok(a.body.toString("latin1").endsWith("</feed>\n"));
});

test("CDATA, comments and processing instructions never start or end an item, and a > in an attribute is no end of a tag", () => {
  const tricky = item(7, { body: "<p>see </item><item><guid>ep-evil</guid></item> here</p>" });
  const commented = `<item>\n<!-- </item> not the end -->\n<?pi </item> ?>\n<title a=">" b='x>y'>Commented</title><guid>ep-8</guid><pubDate>${minutes(8).toUTCString()}</pubDate></item>\n`;
  const head = HEAD.replace("</channel>", "") + "<!-- <item><guid>ep-ghost</guid></item> -->\n<![CDATA[ <item><guid>ep-ghost2</guid></item> ]]>\n";
  const doc = feed([item(9), commented, tricky, item(6)], head);
  const r = ok(trimDocument(doc, { maxItems: 3 }, 5));
  const out = r.body.toString("latin1");
  assert.equal(r.seen, 4, "all four were met");
  assert.ok(out.includes(tricky) && out.includes(commented), "both come back exactly, tags in their CDATA and comments included");
  assert.ok(!out.includes("ep-6"), "the fourth (oldest) is left out");
  assert.ok(out.includes("ep-ghost2"), "the head keeps its own markup as written");
  assert.deepEqual(guids(r.body), [9, 8, 7]);
});

test("namespaces and the root's declarations come through; nested elements of the item's own name don't end it", () => {
  const nested = `<item><title>Outer</title><guid>ep-1</guid><pubDate>${minutes(1).toUTCString()}</pubDate><media:group><item>inner</item></media:group></item>\n`;
  const r = ok(trimDocument(feed([nested]), { maxItems: 5 }));
  assert.ok(r.body.toString("latin1").includes(nested));
  assert.equal(r.kept, 1);
  assert.ok(r.body.toString("latin1").includes(NS));
});

test("RSS 1.0 (RDF) items that follow the channel as siblings, and prefixed Atom roots", () => {
  const rdfHead = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://x.example/"><title>X</title><link>https://x.example/</link><description>d</description></channel>\n`;
  const rdfItem = (i: number) => `<item rdf:about="https://x.example/${i}"><title>t${i}</title><link>https://x.example/${i}</link><dc:date>${minutes(i).toISOString()}</dc:date></item>\n`;
  const r = ok(trimDocument(`${rdfHead}${[1, 4, 2].map(rdfItem).join("")}</rdf:RDF>`, { maxItems: 2 }));
  assert.equal(r.root, "rdf");
  assert.ok(r.body.toString("latin1").startsWith(rdfHead));
  assert.ok(r.body.toString("latin1").endsWith("</rdf:RDF>\n"));
  assert.deepEqual([...r.body.toString("latin1").matchAll(/<title>t(\d)<\/title>/g)].map((m) => m[1]), ["4", "2"]);
  const a = (i: number) => `<a:entry><a:title>t${i}</a:title><a:updated>${minutes(i).toISOString()}</a:updated></a:entry>`;
  const p = ok(trimDocument(`<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>T</a:title>${a(1)}${a(3)}${a(2)}</a:feed>`, { maxItems: 1 }));
  assert.ok(p.body.toString("latin1").includes(a(3)) && !p.body.toString("latin1").includes(a(2)));
  assert.ok(p.body.toString("latin1").endsWith("</a:feed>\n"));
});

test("the result does not depend on where the chunks split, and bytes are kept exactly (UTF-8 and ISO-8859-1)", () => {
  const utf8 = feed(
    [item(3, { title: "Ünï — café ☕ 日本語" }), item(2, { body: "<p>naïve — “quotes” 𝄞</p>" }), item(1)],
    HEAD,
  );
  const reference = ok(trimDocument(Buffer.from(utf8, "utf8"), { maxItems: 2 }, 1 << 20));
  for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
    const r = ok(trimDocument(Buffer.from(utf8, "utf8"), { maxItems: 2 }, size));
    assert.ok(r.body.equals(reference.body), `chunk size ${size}`);
  }
  assert.equal(reference.body.toString("utf8").includes("Ünï — café ☕ 日本語"), true);
  const latin = Buffer.from(feed([item(2, { title: "café" }), item(1)], HEAD.replace("UTF-8", "ISO-8859-1")), "latin1");
  const l = ok(trimDocument(latin, { maxItems: 1 }, 3));
  assert.ok(l.body.includes(Buffer.from("<title>caf\xe9</title>", "latin1")), "an ISO-8859-1 byte stays one byte");
  assert.ok(!l.body.includes(Buffer.from([0xc3, 0xa9])));
});

test("huge items are left out whole and counted; the others are kept", () => {
  const huge = item(50, { body: "x".repeat(300_000) });
  const r = ok(trimDocument(feed([item(52), huge, item(51), item(49)]), { maxItems: 10, maxItemBytes: 100_000 }, 4096));
  assert.equal(r.tooBig, 1);
  assert.deepEqual(guids(r.body), [52, 51, 49]);
  assert.ok(!r.body.toString("latin1").includes("xxxx"), "no part of it, cut or not");
  assert.ok(r.body.toString("latin1").endsWith("</channel></rss>\n"));
  // When every item is bigger than an item may be there is nothing to keep, and the feed is its channel: not a failure to be worded to anyone.
  const allHuge = ok(trimDocument(feed([huge, item(60, { body: "y".repeat(200_000) })]), { maxItems: 10, maxItemBytes: 100_000 }));
  assert.deepEqual([allHuge.kept, allHuge.seen, allHuge.tooBig, allHuge.complete], [0, 2, 2, true]);
  assert.equal(allHuge.body.toString("latin1"), `${HEAD}</channel></rss>\n`);
});

test("the copy keeps the newest 50 items unless told otherwise: what the engine keeps of any feed", () => {
  assert.equal(TRIM_LIMITS.maxItems, 50);
  const doc = feed(Array.from({ length: 1000 }, (_, k) => item(1000 - k)));
  const r = ok(trimDocument(doc));
  assert.equal(r.kept, 50);
  assert.deepEqual(guids(r.body), Array.from({ length: 50 }, (_, k) => 1000 - k));
  assert.ok(r.body.length < doc.length / 15, `the copy is ${r.body.length} bytes of ${doc.length}`);
});

test("when the newest items are bigger together than the room, the oldest of them go", () => {
  const big = (i: number) => item(i, { body: "z".repeat(40_000) });
  const doc = feed(Array.from({ length: 400 }, (_, k) => big(400 - k)));
  const r = ok(trimDocument(doc, { maxItems: 100, maxKeptBytes: 200_000 }, 8192));
  assert.ok(r.kept >= 4 && r.kept <= 5, `kept ${r.kept}`);
  assert.deepEqual(guids(r.body), Array.from({ length: r.kept }, (_, k) => 400 - k));
  assert.ok(r.body.length < 260_000, `the copy is ${r.body.length} bytes of ${doc.length}`);
});

test("past the byte ceiling the newest of what was read is the answer, and reading stops there, whatever the order; nothing says it was cut", () => {
  const unordered = Array.from({ length: 2000 }, (_, k) => item((k * 7) % 2000));
  const doc = feed(unordered);
  const t = new FeedTrimmer({ maxBytes: 100_000, maxItems: 100 });
  let wrote = 0;
  for (let at = 0; at < doc.length; at += 8192) {
    wrote = at;
    if (t.write(Buffer.from(doc.slice(at, at + 8192), "latin1")) === "stop") break;
  }
  assert.ok(wrote <= 100_000, `stopped at the ceiling (${wrote})`);
  const r = ok(t.finish());
  assert.equal(r.bytesRead, 100_000, "exactly the ceiling was read, in the middle of whatever it came to");
  assert.deepEqual([r.capped, r.complete, r.kept], [true, false, 100]);
  const readBytes = doc.slice(0, 100_000);
  const read = [...readBytes.slice(0, readBytes.lastIndexOf("</item>")).matchAll(/<guid[^>]*>ep-(\d+)<\/guid>/g)].map((m) => Number(m[1]));
  assert.deepEqual(guids(r.body), read.sort((a, b) => b - a).slice(0, 100), "the newest of what came before the ceiling, and the item it cut is not in it");
  assert.ok(r.body.toString("latin1").endsWith("</channel></rss>\n"), "the copy is a whole feed");
  assert.equal(titles(r.body).length, 100, "the preview parser reads it");

  // The same through any chunking, and a newest-first feed is no exception: its ceiling is a size, not a count.
  const ordered = feed(Array.from({ length: 2000 }, (_, k) => item(2000 - k)));
  const exact = ok(trimDocument(ordered, { maxBytes: ordered.length, maxItems: 100 }));
  assert.deepEqual([exact.kept, exact.capped, exact.complete], [100, false, true], "a document exactly the ceiling is not cut");
  for (const size of [8192, 997, 1 << 20]) {
    const over = ok(trimDocument(ordered, { maxBytes: ordered.length - 1000, maxItems: 100 }, size));
    assert.deepEqual([over.kept, over.capped, over.complete], [100, true, false], `chunks of ${size}`);
    assert.deepEqual(guids(over.body), Array.from({ length: 100 }, (_, k) => 2000 - k));
  }
  // A document that is all ceiling and no feed (it ended inside the channel's details before any item) has nothing to serve.
  const inHead = trimDocument(ordered, { maxBytes: HEAD.length - 5 });
  assert.ok(!inHead.ok && inHead.reason === "malformed");
});

test("a ceiling that falls inside the first item leaves the channel and no piece of that item; only a feed with no readable item at all fails", () => {
  const big = item(7, { body: `<p>${"long notes ".repeat(60_000)}</p>` }); // about 660 KB, so under the item limit and well past the ceiling
  const doc = feed([big, item(6)]);
  for (const size of [8192, 997, 1 << 20]) {
    const r = ok(trimDocument(doc, { maxBytes: 100_000 }, size));
    assert.deepEqual([r.kept, r.seen, r.tooBig, r.capped, r.complete, r.bytesRead], [0, 0, 0, true, false, 100_000], `chunks of ${size}`);
    const text = r.body.toString("latin1");
    assert.ok(text.startsWith(HEAD.slice(0, 40)) && text.includes("<title>The Show</title>"), "the channel's own markup is kept");
    assert.ok(text.endsWith("</channel></rss>\n"), "the channel is closed");
    // The channel's own description holds "<item>" inside CDATA on purpose; only markup outside CDATA counts.
    assert.doesNotMatch(text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""), /<item|long notes/, "no piece of the cut item");
    const parsed = parseFeed(r.body, "application/rss+xml", { maxItems: 1000 });
    assert.equal(parsed.title, "The Show");
    assert.equal(parsed.items.length, 0);
  }
  // After items that were whole the cut one is dropped and the whole ones are kept.
  const later = feed([item(1), item(2), big]);
  const after = ok(trimDocument(later, { maxBytes: 100_000 }));
  assert.deepEqual([after.kept, after.capped, after.complete], [2, true, false]);
  assert.deepEqual(guids(after.body), [2, 1]);
  assert.doesNotMatch(after.body.toString("latin1"), /long notes/);
  // An item over the item limit is left out whole whether or not the ceiling comes inside it.
  const tooBig = ok(trimDocument(doc, { maxBytes: 100_000, maxItemBytes: 10_000 }));
  assert.deepEqual([tooBig.kept, tooBig.capped, tooBig.complete], [0, true, false]);
  assert.equal(parseFeed(tooBig.body, "application/rss+xml", { maxItems: 1000 }).items.length, 0);
  // Not the ceiling's doing: a document that just ends inside its first item, or inside the channel before any item, is still not a feed.
  const ends = trimDocument(doc.slice(0, HEAD.length + 200), {});
  assert.ok(!ends.ok && ends.reason === "malformed");
  const inHead = trimDocument(doc, { maxBytes: HEAD.length - 5 });
  assert.ok(!inHead.ok && inHead.reason === "malformed");
});

test("what is not a feed, or can't be read, fails with a reason", () => {
  const reason = (doc: Buffer | string, limits = {}) => {
    const r = trimDocument(doc, limits);
    assert.ok(!r.ok);
    return r.reason;
  };
  assert.equal(reason(""), "empty");
  assert.equal(reason("<html><head><title>x</title></head><body>hi</body></html>"), "not_feed");
  assert.equal(reason('{"version":"https://jsonfeed.org/version/1.1","items":[]}'), "not_feed");
  assert.equal(reason("just some text"), "not_feed");
  assert.equal(reason(Buffer.from('<?xml version="1.0"?><rss><channel><item/></channel></rss>', "utf16le")), "unsupported_encoding");
  assert.equal(reason(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<rss/>", "utf16le")])), "unsupported_encoding");
  assert.equal(reason(`${HEAD}${item(1).slice(0, 30)}`), "malformed", "cut before any item and before the channel closed");
  assert.equal(reason(HEAD.slice(0, 120)), "not_feed", "cut inside the root tag");
  assert.equal(reason(feed([item(1)], HEAD + "x".repeat(2000)), { maxHeadBytes: 1000 }), "head_too_large");
  assert.equal(reason(`<rss version="2.0"><channel><title a="${"q".repeat(80_000)}`), "malformed", "a tag that never ends");
  assert.equal(reason(`<rss><channel>${"<a>".repeat(500)}`), "malformed", "elements opened and never closed do not pile up without end");
  assert.equal(reason(`${HEAD}${item(2)}${"<x>".repeat(5000)}${item(1)}</channel></rss>`), "malformed", "nor after the first item, where nothing is kept");
});

test("a document cut inside an item keeps the items that were whole; one with no items is served as it is", () => {
  const doc = feed([item(3), item(2), item(1)]);
  const cut = doc.slice(0, doc.indexOf("<item>", doc.indexOf("ep-2")) + 40); // inside the third item
  const r = ok(trimDocument(cut, { maxItems: 10 }));
  assert.deepEqual(guids(r.body), [3, 2]);
  assert.equal(r.complete, false);
  assert.ok(r.body.toString("latin1").endsWith("</channel></rss>\n"));
  const empty = ok(trimDocument(`${HEAD}${TAIL}`));
  assert.equal(empty.body.toString("latin1"), `${HEAD}${TAIL}`.trimEnd());
  assert.equal(empty.kept, 0);
  const none = ok(trimDocument(`<?xml version="1.0"?><rss version="2.0"/>`));
  assert.equal(none.kept, 0);
  const hollow = ok(trimDocument(`${HEAD}<item/><item></item>${TAIL}`));
  assert.deepEqual([hollow.kept, hollow.seen], [1, 2], "an item with nothing in it is still an item, as the engine sees it; an empty element is only counted");
  assert.ok(hollow.body.toString("latin1").endsWith("</channel></rss>\n"));
  const hollowOnly = ok(trimDocument(`${HEAD}<item/><item/>${TAIL}`));
  assert.deepEqual([hollowOnly.kept, hollowOnly.seen], [0, 2]);
  assert.equal(hollowOnly.body.toString("latin1"), `${HEAD}</channel></rss>\n`);
});

test("tags in the wrong order and stray text do not stop it", () => {
  const sloppy = `${HEAD}${item(2)}</p></b>\n   stray text   ${item(1)}</wrong></channel>trailing\n</rss>garbage after`;
  const r = ok(trimDocument(sloppy, { maxItems: 10 }));
  assert.deepEqual(guids(r.body), [2, 1]);
});

test("a feed served with a byte order mark and a DOCTYPE keeps both in its head", () => {
  const doc = `﻿<?xml version="1.0"?>\n<!DOCTYPE rss [ <!ENTITY e "x"> ]>\n<rss version="2.0"><channel><title>&e;</title>${item(2)}${item(1)}</channel></rss>`;
  const r = ok(trimDocument(Buffer.from(doc, "utf8"), { maxItems: 1 }));
  const out = r.body.toString("utf8");
  assert.ok(out.startsWith("﻿<?xml version=\"1.0\"?>\n<!DOCTYPE rss [ <!ENTITY e \"x\"> ]>"));
  assert.deepEqual(guids(r.body), [2]);
});

const BASE = "https://pub.example/feeds/podcast.xml";

test("the copy keeps the address it was read from: the root gets an xml:base, everything else stays byte for byte", () => {
  const doc = feed([item(2), item(1)]);
  const plain = ok(trimDocument(doc, { maxItems: 5 })).body.toString("latin1");
  const based = ok(trimDocument(doc, { maxItems: 5 }, 16 * 1024, BASE));
  const tag = /<rss [^>]*>/.exec(plain)![0];
  assert.equal(based.body.toString("latin1"), plain.replace(tag, `${tag.slice(0, -1)} xml:base="${BASE}">`), "only the root tag differs");
  assert.ok(based.body.toString("latin1").includes(item(2)) && based.body.toString("latin1").includes(item(1)));
  assert.equal(parseFeed(based.body, "application/rss+xml", { maxItems: 10 }).items.length, 2, "still a feed the preview parser reads");
  // A channel with no items, an Atom feed and an RDF one are given it too.
  const empty = ok(trimDocument(`${HEAD}${TAIL}`, {}, 16 * 1024, BASE)).body.toString("latin1");
  assert.ok(empty.includes(`xml:base="${BASE}"`));
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>t</title><link href="/posts/one"/><updated>${minutes(1).toISOString()}</updated></entry></feed>`;
  const a = ok(trimDocument(atom, {}, 16 * 1024, BASE)).body.toString("latin1");
  assert.ok(a.includes(`<feed xmlns="http://www.w3.org/2005/Atom" xml:base="${BASE}"><title>A</title>`) && a.includes('<link href="/posts/one"/>'), a);
});

test("the root's start tag is found wherever the chunks split, after a byte order mark, comments, a DOCTYPE, and with a > in an attribute", () => {
  const doc = `﻿<?xml version="1.0"?>\n<!-- <rss xml:base="/wrong/"> -->\n<!DOCTYPE rss [ <!ENTITY e "x"> ]>\n<rss version="2.0" note="a > b" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>&e;</title>${item(2)}${item(1)}</channel></rss>`;
  const reference = ok(trimDocument(Buffer.from(doc, "utf8"), { maxItems: 5 }, 1 << 20, BASE)).body.toString("utf8");
  assert.ok(reference.includes(`<rss version="2.0" note="a > b" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xml:base="${BASE}">`), reference);
  assert.ok(reference.startsWith('﻿<?xml version="1.0"?>\n<!-- <rss xml:base="/wrong/"> -->\n<!DOCTYPE rss [ <!ENTITY e "x"> ]>\n<rss'), "what comes before the root is untouched");
  for (const size of [1, 2, 3, 7, 11, 64, 500]) {
    assert.equal(ok(trimDocument(Buffer.from(doc, "utf8"), { maxItems: 5 }, size, BASE)).body.toString("utf8"), reference, `chunk size ${size}`);
  }
});

test("an xml:base the root already has stays if it is absolute, and is resolved against the address if it is relative", () => {
  const at = (tag: string) => rootWithBase(tag, BASE);
  assert.equal(at('<rss version="2.0">'), `<rss version="2.0" xml:base="${BASE}">`);
  assert.equal(at('<feed xmlns="http://www.w3.org/2005/Atom"/>'), `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="${BASE}"/>`);
  assert.equal(at('<a:feed xmlns:a="http://www.w3.org/2005/Atom" >'), `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="${BASE}" >`);
  assert.equal(at('<feed xml:base="https://other.example/blog/" xmlns="x">'), '<feed xml:base="https://other.example/blog/" xmlns="x">');
  assert.equal(at('<feed xml:base="/blog/">'), '<feed xml:base="https://pub.example/blog/">');
  assert.equal(at("<feed xmlns='x' xml:base = 'posts/'>"), "<feed xmlns='x' xml:base = 'https://pub.example/feeds/posts/'>");
  assert.equal(at('<feed xml:base="../">'), '<feed xml:base="https://pub.example/">');
  assert.equal(at('<feed xml:base="//cdn.example/x/">'), '<feed xml:base="https://cdn.example/x/">');
  assert.equal(at('<feed xml:base="">'), `<feed xml:base="${BASE}">`);
  assert.equal(at('<feed xml:base="?page=2">'), '<feed xml:base="https://pub.example/feeds/podcast.xml?page=2">');
  assert.equal(at('<feed xml:base="a&amp;b/c&#47;d/">'), '<feed xml:base="https://pub.example/feeds/a&amp;b/c/d/">', "character references are read and the result is written escaped");
  assert.equal(at('<feed xml:base="/caf\xc3\xa9/">'), '<feed xml:base="https://pub.example/caf%C3%A9/">', "bytes of a UTF-8 document are read as UTF-8");
  assert.equal(at('<feed title="xml:base=&quot;x&quot;" xmlns="x">'), `<feed title="xml:base=&quot;x&quot;" xmlns="x" xml:base="${BASE}">`, "an attribute's text that looks like one is not one");
  assert.equal(rootWithBase('<rss>', "https://pub.example/f?a=1&b=2"), '<rss xml:base="https://pub.example/f?a=1&amp;b=2">');
  assert.equal(rootWithBase('<feed xml:base="x\'y">', "https://pub.example/a/"), '<feed xml:base="https://pub.example/a/x\'y">');
});

test("a relative xml:base in a feed that isn't UTF-8 is read in the feed's own encoding", () => {
  const latin1 = (s: string) => Buffer.from(s, "latin1");
  const doc = (decl: string) => latin1(`${decl}<feed xmlns="http://www.w3.org/2005/Atom" xml:base="/caf\xe9/"><title>T</title><entry><id>1</id><title>One</title><updated>2026-11-01T00:00:00Z</updated><link href="one"/></entry></feed>`);
  const linkOf = (body: Buffer, charset: string) => parseFeed(new TextDecoder(charset).decode(body), "application/atom+xml", { baseUrl: "https://gateway.example/t/x" }).items[0]!.url;
  // Declared in the XML declaration
  const declared = new FeedTrimmer();
  declared.write(doc('<?xml version="1.0" encoding="ISO-8859-1"?>'));
  const a = declared.finish("https://pub.example/feed.xml");
  assert.ok(a.ok);
  assert.equal(linkOf(a.body, "latin1"), "https://pub.example/caf%C3%A9/one");
  // Sent as the answer's charset, with no declaration
  const sent = new FeedTrimmer();
  sent.write(doc(""));
  const b = sent.finish("https://pub.example/feed.xml", "iso-8859-1");
  assert.ok(b.ok);
  assert.equal(linkOf(b.body, "latin1"), "https://pub.example/caf%C3%A9/one");
  // UTF-8 stays as before
  assert.equal(rootWithBase('<feed xml:base="/caf\xc3\xa9/">', "https://pub.example/feed.xml"), '<feed xml:base="https://pub.example/caf%C3%A9/">');
});

test("an encoding that writes other characters in 7-bit bytes (ISO-2022-JP) is decoded too", () => {
  const nichi = Buffer.from([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x1b, 0x28, 0x42]).toString("latin1"); // 日 in ISO-2022-JP
  assert.equal(rootWithBase(`<feed xml:base="/${nichi}/">`, "https://pub.example/feed.xml", "iso-2022-jp"), '<feed xml:base="https://pub.example/%E6%97%A5/">');
});
