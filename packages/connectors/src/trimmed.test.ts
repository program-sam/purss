import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ItemCounter, TRIM_FEED_BYTES, TRIM_FEED_ITEMS, countFeedItems, isLargeFeed, trimRoutePath, verifyTrimRoute } from "./trimmed.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

const KEY = "k".repeat(40);

/** What a listener hands to the check: the path's signature and its encoded address. */
function route(path: string): [encoded: string, signature: string] {
  const [, t, signature, encoded, ...rest] = path.split("/");
  assert.ok(t === "t" && signature && encoded !== undefined && rest.length === 0, path);
  return [encoded, signature];
}
const verified = (path: string, secret = KEY) => { const [encoded, signature] = route(path); return verifyTrimRoute(secret, encoded, signature); };
const enc = (s: string) => Buffer.from(s).toString("base64url");

test("a gateway path made for a feed address verifies back to it, and only under this installation's key", () => {
  const addresses = [
    "https://feeds.simplecast.com/54nAGcIl?x=1&y=ü",
    "http://a.example/feed",
    "https://user:pass@private.example:8443/feed.xml?token=a%2Fb%3Dc&x=%25#frag",
    "https://xn--bcher-kva.example/ü/%C3%BC?q=a+b&q=c",
    `https://a.example/${"x".repeat(2048 - "https://a.example/".length)}`,
  ];
  for (const url of addresses) {
    const path = trimRoutePath(KEY, url);
    assert.equal(verified(path), url, url.slice(0, 40));
    assert.equal(trimRoutePath(KEY, url), path, "the same address always gives the same path");
    assert.equal(verified(path, "other-key-".repeat(5)), null, `${url.slice(0, 40)}: another installation's key`);
  }
});

test("gateway paths already issued keep verifying: the signature and the path are fixed", () => {
  assert.equal(trimRoutePath(KEY, "http://a.example/feed"), "/t/INQcKbl1G-jAwa1vchX34_HsbT-VdRwOLVyu3rJ1vcA/aHR0cDovL2EuZXhhbXBsZS9mZWVk");
  assert.equal(
    trimRoutePath(KEY, "https://feeds.simplecast.com/54nAGcIl?x=1&y=ü"),
    "/t/iQez_kjHb_gA327bLLbndZuE1kWF4RvoicO6YyToKxM/aHR0cHM6Ly9mZWVkcy5zaW1wbGVjYXN0LmNvbS81NG5BR2NJbD94PTEmeT3DvA",
  );
  assert.equal(verified("/t/INQcKbl1G-jAwa1vchX34_HsbT-VdRwOLVyu3rJ1vcA/aHR0cDovL2EuZXhhbXBsZS9mZWVk"), "http://a.example/feed");
});

test("a gateway path is refused whatever is changed in it", () => {
  const url = "https://a.example/f?q=???>>>"; // its base64url has both of the characters that differ from base64's
  const [encoded, signature] = route(trimRoutePath(KEY, url));
  const check = (e: string, given: string) => verifyTrimRoute(KEY, e, given);
  assert.equal(check(encoded, signature), url);
  // The last character of an address whose length leaves bits over can be written two ways that decode the same.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const spelledOtherwise = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) ^ 1];
  assert.equal(Buffer.from(spelledOtherwise, "base64url").toString(), url);
  const refused: [string, string, string][] = [
    ["another address under this signature", enc("https://a.example/other"), signature],
    ["the address spelled another way", enc("https://a.example/f?q=%3F??>>>"), signature],
    ["the same address with its padding", `${encoded}=`, signature],
    ["the address spelled with other bits in its last character", spelledOtherwise, signature],
    ["the address in the other base64 alphabet", encoded.replace(/-/g, "+").replace(/_/g, "/"), signature],
    ["the address encoded twice", enc(encoded), trimRoutePath(KEY, encoded).split("/")[2]!],
    ["a signature one character off", encoded, `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`],
    ["a signature cut short", encoded, signature.slice(1)],
    ["a signature with more after it", encoded, `${signature}A`],
    ["no signature", encoded, ""],
    ["a signature of the same length with a letter outside ASCII", encoded, `${signature.slice(0, -1)}é`],
    ["no address", "", signature],
    ["an address that is not base64url", "not*base64", signature],
  ];
  assert.ok(/[-_]/.test(encoded));
  for (const [what, e, given] of refused) assert.equal(check(e, given), null, what);
});

test("only plain web addresses of reasonable length verify, even signed by this installation", () => {
  const signed = (url: string) => verified(trimRoutePath(KEY, url));
  assert.equal(signed("http://a.example/feed"), "http://a.example/feed");
  for (const bad of ["file:///etc/passwd", "ftp://a.example/f", "javascript:alert(1)", "not a url", "", `https://a.example/${"x".repeat(2100)}`]) {
    assert.equal(signed(bad), null, bad.slice(0, 30));
  }
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
