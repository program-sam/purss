import assert from "node:assert/strict";
import test from "node:test";
import { syncEntrySchema } from "@purss/domain";
import { EngineError } from "./errors.ts";
import type { RawStreamItem } from "./greader.ts";
import { clamp, engineItemIdToDecimal, normalizeItem, restoreEscapedText } from "./normalize.ts";

const base: RawStreamItem = {
  id: "tag:google.com,2005:reader/item/0006a8f1c2d3e4f5",
  timestampUsec: "1762100000123456",
  crawlTimeMsec: "1762100000123",
  published: 1762000000,
  title: "Q＆A: ＜b＞bold＜/b＞ and more",
  author: "Ann ＆ Bob",
  canonical: [{ href: "https://example.org/post/1" }],
  alternate: [{ href: "https://example.org/post/1" }],
  summary: { content: "<p>Hello</p>" },
  origin: { streamId: "feed/12", title: "Example" },
};

test("hex item id becomes the decimal id edit-tag accepts", () => {
  assert.equal(engineItemIdToDecimal("tag:google.com,2005:reader/item/0000000000000010"), "16");
  assert.equal(engineItemIdToDecimal(base.id), BigInt("0x0006a8f1c2d3e4f5").toString());
  assert.throws(() => engineItemIdToDecimal("nonsense"), EngineError);
});

test("maps a stream item to the SyncEntry contract", () => {
  const { entry, crawlUsec } = normalizeItem(base);
  assert.equal(syncEntrySchema.safeParse(entry).success, true);
  assert.equal(entry.externalId, BigInt("0x0006a8f1c2d3e4f5").toString());
  assert.equal(entry.streamId, "feed/12");
  assert.equal(entry.url, "https://example.org/post/1");
  assert.equal(entry.title, "Q&A: <b>bold</b> and more");
  assert.equal(entry.author, "Ann & Bob");
  assert.equal(entry.contentHtml, "<p>Hello</p>");
  assert.equal(entry.summaryHtml, null);
  assert.equal(entry.originalGuid, null, "the standard stream never carries the original GUID");
  assert.equal(entry.crawledAt, "2025-11-02T16:13:20.123Z");
  assert.equal(entry.publishedAt, "2025-11-01T12:26:40.000Z");
  assert.equal(crawlUsec, "1762100000123456");
});

test("fullwidth restoration only touches the three characters the engine rewrites", () => {
  assert.equal(restoreEscapedText("＆＜＞ ’ ＂ ／"), "&<> ’ ＂ ／");
});

test("image comes from an image enclosure, else from the engine's thumbnail figure", () => {
  const withEnclosure = normalizeItem({
    ...base,
    enclosure: [
      { href: "https://cdn.example.org/a.mp3", type: "audio/mpeg", length: "1234" },
      { href: "https://cdn.example.org/a.jpg", type: "image/jpeg" },
    ],
  }).entry;
  assert.equal(withEnclosure.imageUrl, "https://cdn.example.org/a.jpg");
  assert.deepEqual(withEnclosure.enclosures[0], { url: "https://cdn.example.org/a.mp3", type: "audio/mpeg", length: 1234 });

  const thumb = normalizeItem({
    ...base,
    summary: { content: '<p>x</p><figure class="enclosure"><p><img class="enclosure-thumbnail" src="https://cdn.example.org/t.png?a=1&amp;b=2" alt="" /></p></figure>' },
  }).entry;
  assert.equal(thumb.imageUrl, "https://cdn.example.org/t.png?a=1&b=2");
  assert.equal(normalizeItem(base).entry.imageUrl, null);
});

test("of several image enclosures, the one the feed declares biggest is the item's picture, else the first", () => {
  const pick = (enclosure: { href: string; type: string; length?: number | string }[]) => normalizeItem({ ...base, enclosure }).entry.imageUrl;
  assert.equal(pick([{ href: "https://cdn.example.org/small.jpg", type: "image/jpeg", length: 8000 }, { href: "https://cdn.example.org/big.jpg", type: "image/jpeg", length: "480000" }, { href: "https://cdn.example.org/mid.jpg", type: "image/jpeg", length: 90000 }]), "https://cdn.example.org/big.jpg");
  assert.equal(pick([{ href: "https://cdn.example.org/first.jpg", type: "image/jpeg" }, { href: "https://cdn.example.org/second.jpg", type: "image/jpeg" }]), "https://cdn.example.org/first.jpg");
  assert.equal(pick([{ href: "https://cdn.example.org/a.mp3", type: "audio/mpeg", length: 99999999 }, { href: "https://cdn.example.org/cover.jpg", type: "image/jpeg", length: 100 }]), "https://cdn.example.org/cover.jpg", "an audio file is not a picture, however big");
});

test("an enclosure's address arrives HTML-escaped from the engine and is kept as the feed gave it", () => {
  const { enclosures } = normalizeItem({
    ...base,
    enclosure: [{ href: "https://traffic.example.fm/audio.mp3?utm_source=Podcast&amp;in_playlist=p1&amp;x=&#039;&quot;&amp;amp;", type: "audio/mpeg" }],
  }).entry;
  assert.equal(enclosures[0]?.url, "https://traffic.example.fm/audio.mp3?utm_source=Podcast&in_playlist=p1&x='\"&amp;");
});

test("non-http links and enclosures are dropped, missing optional fields become null", () => {
  const { entry } = normalizeItem({
    id: base.id,
    timestampUsec: base.timestampUsec,
    origin: { streamId: "feed/3" },
    canonical: [{ href: "javascript:alert(1)" }],
    enclosure: [{ href: "ftp://x/y.mp3", type: "audio/mpeg" }],
    published: 0,
  });
  assert.equal(entry.url, null);
  assert.equal(entry.title, "");
  assert.equal(entry.author, null);
  assert.equal(entry.publishedAt, null);
  assert.equal(entry.contentHtml, null);
  assert.deepEqual(entry.enclosures, []);
});

test("oversized fields are clamped so one long title can never poison a whole batch", () => {
  const long = "x".repeat(5000);
  const { entry } = normalizeItem({ ...base, title: long, author: long, canonical: [{ href: `https://example.org/${long}` }] });
  assert.equal(syncEntrySchema.safeParse(entry).success, true);
  assert.equal(entry.title.length, 2000);
  assert.equal(entry.author?.length, 500);
  assert.equal(entry.url?.length, 4000);
});

test("clamp does not split a surrogate pair", () => {
  const s = "a" + "😀".repeat(3);
  const out = clamp(s, 2);
  assert.equal(out, "a");
  assert.equal(clamp("abc", 10), "abc");
});

test("an item without a source stream is a protocol error, not a silent skip", () => {
  assert.throws(() => normalizeItem({ id: base.id, timestampUsec: base.timestampUsec }), (e: unknown) => e instanceof EngineError && e.kind === "protocol");
});
