import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPictures, pictureType } from "./pictures.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function serve(routes: Record<string, { status?: number; type?: string; body: Buffer }>) {
  const server = http.createServer((req, res) => {
    const r = routes[req.url ?? ""];
    if (!r) { res.writeHead(404).end("no"); return; }
    res.writeHead(r.status ?? 200, { "content-type": r.type ?? "image/png" }).end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}
const allow = { testAllowAddress: () => true };

test("the type of a picture comes from its bytes, and only formats a browser shows as a picture are kept", () => {
  assert.equal(pictureType(PNG), "image/png");
  assert.equal(pictureType(JPEG), "image/jpeg");
  assert.equal(pictureType(Buffer.from("GIF89a" + "x".repeat(20))), "image/gif");
  assert.equal(pictureType(SVG), null);
  assert.equal(pictureType(Buffer.from("<html>")), null);
  assert.equal(pictureType(Buffer.alloc(0)), null);
});

test("fetchPictures keeps the pictures that really are pictures, whatever the publisher says they are, and skips the rest", async () => {
  const s = await serve({
    "/a.png": { body: PNG },
    "/lies.png": { type: "image/png", body: SVG },
    "/page.jpg": { type: "image/jpeg", body: Buffer.from("<html><body>Please log in</body></html>") },
    "/no-type": { type: "application/octet-stream", body: JPEG },
    "/gone.png": { status: 404, body: Buffer.from("gone") },
  });
  try {
    const got = await fetchPictures(["/a.png", "/lies.png", "/page.jpg", "/no-type", "/gone.png"].map((p) => s.base + p), { maxBytes: 10_000, fetch: allow });
    assert.deepEqual(got.map((g) => [g.url.slice(s.base.length), g.contentType]), [["/a.png", "image/png"], ["/no-type", "image/jpeg"]]);
    assert.deepEqual(got[0]!.data, PNG);
  } finally { await s.close(); }
});

test("fetchPictures stops at the room it was given: a picture larger than what is left is skipped, a smaller one after it still fits", async () => {
  const s = await serve({ "/1.png": { body: PNG }, "/2.png": { body: Buffer.concat([PNG, Buffer.alloc(5000)]) }, "/3.png": { body: PNG }, "/4.png": { body: PNG } });
  try {
    const got = await fetchPictures(["/1.png", "/2.png", "/3.png", "/4.png"].map((p) => s.base + p), { maxBytes: PNG.length * 2 + 100, fetch: allow });
    assert.deepEqual(got.map((g) => g.url.slice(s.base.length)), ["/1.png", "/3.png"], "the big one was skipped and nothing past the room was kept");
    assert.ok(got.reduce((n, g) => n + g.data.length, 0) <= PNG.length * 2 + 100);
  } finally { await s.close(); }
});

test("fetchPictures follows the address rules of every other fetch: nothing on a private network is fetched", async () => {
  const s = await serve({ "/a.png": { body: PNG } });
  try {
    // No test allowance: the loopback server is refused, like a link to an internal address in a page would be.
    assert.deepEqual(await fetchPictures([s.base + "/a.png", "http://169.254.169.254/latest/meta-data/", "http://localhost:22/x.png", "file:///etc/passwd"], { maxBytes: 10_000 }), []);
  } finally { await s.close(); }
});

test("fetchPictures stops when asked to", async () => {
  const s = await serve({ "/a.png": { body: PNG } });
  try {
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(await fetchPictures([s.base + "/a.png"], { maxBytes: 10_000, signal: ac.signal, fetch: allow }), []);
  } finally { await s.close(); }
});
