import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { zipDirectory } from "./bundle.ts";

/** Read a zip's entries the way an unzipper does: from the central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + size)));
    at += 46 + nameLength;
  }
  return out;
}

function sampleBuild(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-bundle-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><script src=\"/assets/app.js\"></script>");
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('é');".repeat(200));
  return dir;
}

test("the zip holds every file of the build at its relative path, and the same files give the same zip", () => {
  const dir = sampleBuild();
  try {
    const zip = zipDirectory(dir);
    const files = unzip(zip);
    assert.deepEqual([...files.keys()], ["assets/app.js", "index.html"]);
    assert.equal(files.get("assets/app.js")!.toString("utf8"), "console.log('é');".repeat(200));
    assert.deepEqual(zipDirectory(dir), zip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
