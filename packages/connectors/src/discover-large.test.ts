import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { lookupLink } from "./link-lookup.ts";
import { TRIM_FEED_BYTES, TRIM_FEED_ITEMS } from "./trimmed.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

/** A podcast feed of about `bytes`: every episode repeats its show notes, as the big ones do. */
function podcast(bytes: number, format: "rss" | "atom" = "rss"): string {
  const notes = "<p>Show notes with a link <a href=\"https://show.example\">here</a> and plenty of words. </p>".repeat(20);
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const day = new Date(Date.UTC(2026, 10, 1) - i * 86_400_000).toUTCString();
    const one = format === "rss"
      ? `<item><title>Episode ${i}</title><guid isPermaLink="false">ep-${i}</guid><pubDate>${day}</pubDate><enclosure url="https://cdn.example/${i}.mp3" length="1" type="audio/mpeg"/><description><![CDATA[${notes}]]></description><content:encoded><![CDATA[${notes}]]></content:encoded></item>\n`
      : `<entry><title>Entry ${i}</title><id>urn:ep:${i}</id><updated>${new Date(Date.UTC(2026, 10, 1) - i * 86_400_000).toISOString()}</updated><content type="html"><![CDATA[${notes}]]></content></entry>\n`;
    parts.push(one);
    size += one.length;
  }
  return format === "rss"
    ? `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Big Show</title><link>https://show.example</link><description>d</description><itunes:author>A</itunes:author>${parts.join("")}</channel></rss>`
    : `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Big Blog</title><id>urn:blog</id><link href="https://blog.example"/>${parts.join("")}</feed>`;
}

test("a feed bigger than the engine can read whole is marked large, however its size shows (declared, chunked, gzipped, Atom); a smaller one is not", async () => {
  const big = podcast(TRIM_FEED_BYTES + 500_000);
  const bigAtom = podcast(TRIM_FEED_BYTES + 500_000, "atom");
  const small = podcast(2_500_000); // under both limits: about 650 episodes
  const exact = podcast(1000);
  const json = JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "J", items: [{ id: "1", content_html: "<p>x</p>", date_published: "2026-11-01T00:00:00Z" }] });
  const item = (i: number) => `<item><title>E${i}</title><guid>e${i}</guid><pubDate>${new Date(Date.UTC(2026, 0, 1) - i * 3_600_000).toUTCString()}</pubDate></item>`;
  const feedOf = (n: number) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title><link>https://x.example/</link><description>d</description>${Array.from({ length: n }, (_, i) => item(i)).join("")}</channel></rss>`;
  const crowded = feedOf(TRIM_FEED_ITEMS + 1);
  const roomy = feedOf(TRIM_FEED_ITEMS);
  const server = await startServer((req, res) => {
    if (req.url === "/crowded.xml") return send(res, 200, "application/rss+xml", crowded);
    if (req.url === "/roomy.xml") return send(res, 200, "application/rss+xml", roomy);
    if (req.url === "/big.xml") return send(res, 200, "application/rss+xml", big, { "content-length": String(Buffer.byteLength(big)) });
    if (req.url === "/big-chunked.xml") return send(res, 200, "application/rss+xml", big); // no length: only the read says it is long
    if (req.url === "/big-gz.xml") return send(res, 200, "application/rss+xml", gzipSync(big), { "content-encoding": "gzip" });
    if (req.url === "/atom.xml") return send(res, 200, "application/atom+xml", bigAtom);
    if (req.url === "/small.xml") return send(res, 200, "application/rss+xml", small);
    if (req.url === "/tiny.xml") return send(res, 200, "application/rss+xml", exact);
    if (req.url === "/big.json") return send(res, 200, "application/feed+json", json);
    send(res, 404, "text/plain", "no");
  });
  const opts = { testAllowAddress: allowLoopback, timeoutMs: 30_000 };
  try {
    const flag = async (path: string) => {
      const r = await lookupLink(`${server.url}${path}`, opts);
      assert.ok(r.ok, path);
      assert.equal(r.candidates.length, 1, path);
      return r.candidates[0]!;
    };
    for (const path of ["/big.xml", "/big-chunked.xml", "/big-gz.xml", "/atom.xml"]) {
      const c = await flag(path);
      assert.equal(c.large, true, `${path} is larger than ${TRIM_FEED_BYTES}`);
      assert.ok(c.samples.length > 0, "a cut-off preview still shows its newest posts");
    }
    assert.equal((await flag("/big.xml")).title, "Big Show");
    assert.equal((await flag("/small.xml")).large, undefined);
    assert.equal((await flag("/tiny.xml")).large, undefined);
    assert.equal((await flag("/big.json")).large, undefined);
    assert.ok(crowded.length < TRIM_FEED_BYTES / 2);
    assert.equal((await flag("/crowded.xml")).large, true, "a small feed of more items than the engine can take is large too");
    assert.equal((await flag("/roomy.xml")).large, undefined);
  } finally {
    await server.close();
  }
});
