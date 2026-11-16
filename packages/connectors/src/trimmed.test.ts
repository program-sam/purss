import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ItemCounter, TRIM_FEED_BYTES, TRIM_FEED_ITEMS, countFeedItems, isLargeFeed, parseTrimTarget, trimRoutePath, trimSignature, trimSignatureMatches } from "./trimmed.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

const KEY = "k".repeat(40);

test("a gateway path names its feed address, and only this installation's key signs it", () => {
  const url = "https://feeds.simplecast.com/54nAGcIl?x=1&y=ü";
  const path = trimRoutePath(KEY, url);
  const [, t, sig, encoded] = path.split("/");
  assert.equal(t, "t");
  assert.equal(parseTrimTarget(encoded!), url);
  assert.ok(trimSignatureMatches(KEY, url, sig!));
  assert.equal(trimRoutePath(KEY, url), path, "the same address always gives the same path");
  assert.ok(!trimSignatureMatches("other-key-".repeat(5), url, sig!));
  assert.ok(!trimSignatureMatches(KEY, `${url}2`, sig!), "a signature is for one address");
  assert.ok(!trimSignatureMatches(KEY, url, sig!.slice(1)));
  assert.notEqual(trimSignature(KEY, url), trimSignature(KEY, "https://other.example/feed"));
});

test("only plain web addresses of reasonable length are accepted from a path", () => {
  const enc = (s: string) => Buffer.from(s).toString("base64url");
  assert.equal(parseTrimTarget(enc("http://a.example/feed")), "http://a.example/feed");
  for (const bad of ["file:///etc/passwd", "ftp://a.example/f", "javascript:alert(1)", "not a url", "", `https://a.example/${"x".repeat(2100)}`]) {
    assert.equal(parseTrimTarget(enc(bad)), null, bad.slice(0, 30));
  }
  assert.equal(parseTrimTarget("not*base64"), null);
  assert.equal(parseTrimTarget(`${enc("https://a.example/feed")}=`), null, "padding and other spellings of the same address are not accepted");
});

test("the size check stops at the first byte past the size, through the ordinary address rules", async () => {
  const big = Buffer.alloc(TRIM_FEED_BYTES + 10, 65);
  const small = Buffer.alloc(1000, 65);
  let sent = 0;
  const server = await startServer((req, res) => {
    if (req.url === "/endless") {
      res.writeHead(200, { "content-type": "application/xml" });
      const timer = setInterval(() => { sent += 65536; res.write(Buffer.alloc(65536, 65)); }, 1);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/gz") return send(res, 200, "application/xml", gzipSync(big), { "content-encoding": "gzip" });
    if (req.url === "/declared") return send(res, 200, "application/xml", big, { "content-length": String(big.length) });
    if (req.url === "/small") return send(res, 200, "application/xml", small);
    if (req.url === "/exact") return send(res, 200, "application/xml", Buffer.alloc(TRIM_FEED_BYTES, 65));
    send(res, req.url === "/gone" ? 404 : 503, "text/plain", "no");
  });
  const o = { testAllowAddress: allowLoopback };
  try {
    assert.equal(await isLargeFeed(`${server.url}/small`, o), false);
    assert.equal(await isLargeFeed(`${server.url}/exact`, o), false, "exactly the size is not over it");
    assert.equal(await isLargeFeed(`${server.url}/declared`, o), true);
    assert.equal(await isLargeFeed(`${server.url}/gz`, o), true);
    assert.equal(await isLargeFeed(`${server.url}/endless`, { ...o, timeoutMs: 10_000 }), true);
    assert.ok(sent < 3 * TRIM_FEED_BYTES, `the endless body stopped being read (${sent})`);
    assert.equal(await isLargeFeed(`${server.url}/gone`, o), null, "a missing feed is not a big one");
    assert.equal(await isLargeFeed(`${server.url}/down`, o), null);
    assert.equal(await isLargeFeed("http://10.0.0.5/feed", { resolver: async () => { throw new Error("no dns"); } }), null, "private addresses are never asked");
  } finally {
    await server.close();
  }
});

const manyItems = (n: number) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${Array.from({ length: n }, (_, i) => `<item><title>E${i}</title></item>`).join("")}</channel></rss>`;

test("items are counted as they stream by: RSS and Atom, prefixed or not, a tag split between pieces once, lookalikes never", () => {
  assert.equal(countFeedItems(Buffer.from(manyItems(50))), 50);
  assert.equal(countFeedItems(Buffer.from('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id></entry><a:entry/><entry\nx="1"></entry></feed>')), 3);
  assert.equal(countFeedItems(Buffer.from("<items><itemized/><entries/><itemx>1</itemx><x-item>2</x-item></items>")), 0);
  const doc = Buffer.from(manyItems(300));
  for (const size of [1, 2, 3, 7, 13, 64, 1000]) {
    const c = new ItemCounter();
    for (let at = 0; at < doc.length; at += size) c.add(doc.subarray(at, at + size));
    assert.equal(c.count, 300, `pieces of ${size}`);
  }
});

test("a feed with more items than the engine can take is large however small it is, and asking stops at the item that makes it so", async () => {
  const many = manyItems(TRIM_FEED_ITEMS + 1);
  const exact = manyItems(TRIM_FEED_ITEMS);
  assert.ok(many.length < TRIM_FEED_BYTES / 4, "the fixture is small in bytes");
  let sent = 0;
  const server = await startServer((req, res) => {
    if (req.url === "/endless") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.write('<rss version="2.0"><channel>');
      const timer = setInterval(() => { sent += 1; res.write("<item><title>x</title></item>".repeat(500)); }, 1);
      res.on("close", () => clearInterval(timer));
      return;
    }
    send(res, 200, "application/xml", req.url === "/many" ? many : exact);
  });
  const o = { testAllowAddress: allowLoopback };
  try {
    assert.equal(await isLargeFeed(`${server.url}/many`, o), true);
    assert.equal(await isLargeFeed(`${server.url}/exact`, o), false, "exactly the number is not over it");
    assert.equal(await isLargeFeed(`${server.url}/endless`, { ...o, timeoutMs: 10_000 }), true);
    assert.ok(sent < 200, `the endless feed stopped being read (${sent} writes)`);
  } finally {
    await server.close();
  }
});
