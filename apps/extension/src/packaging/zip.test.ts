import test from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";
import { zip } from "./zip.ts";

/** Read a ZIP through its central directory, as unzip tools do. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(crc32(data), buf.readUInt32LE(p + 16), `${name} checksum`);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

test("a zip holds every file intact, in name order, and the same input gives the same bytes", () => {
  const files = [
    { name: "popup/popup.html", data: Buffer.from("<!doctype html>✓") },
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ a: 1 })) },
    { name: "icons/16.png", data: Buffer.alloc(3000, 7) },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const a = zip(files);
  const read = unzip(a);
  assert.deepEqual([...read.keys()], ["empty.txt", "icons/16.png", "manifest.json", "popup/popup.html"]);
  for (const f of files) assert.deepEqual(read.get(f.name), Buffer.from(f.data));
  assert.deepEqual(zip([...files].reverse()), a, "reproducible");
  assert.throws(() => zip([{ name: "../evil", data: Buffer.alloc(1) }]));
});
