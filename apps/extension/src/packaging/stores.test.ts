import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, reasonToSkip, sameExtension, unzip } from "./stores.ts";
import type { Files } from "./stores.ts";
import { zip } from "./zip.ts";

const manifest = (extra: Record<string, unknown>) => Buffer.from(JSON.stringify({ manifest_version: 3, name: "PURSS", ...extra }));
const files = (entries: Record<string, Buffer | string>): Files => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
const built = files({ "manifest.json": manifest({ version: "26.316.3" }), "background.js": "run()", "icons/16.png": "png" });

test("reads back what the ZIP writer wrote, and a CRX's ZIP behind its header", () => {
  const archive = zip([...built].map(([name, data]) => ({ name, data })));
  assert.deepEqual(unzip(archive), built);
  const header = Buffer.from("signed header bytes");
  const crx = Buffer.alloc(12);
  crx.write("Cr24", 0, "latin1");
  crx.writeUInt32LE(3, 4);
  crx.writeUInt32LE(header.length, 8);
  assert.deepEqual(unzip(Buffer.concat([crx, header, archive])), built);
  assert.throws(() => unzip(Buffer.from("not a zip at all, just some bytes")), /Not a ZIP/);
});

test("the same extension, apart from the version and what the store adds, is the same", () => {
  const store = files({
    "manifest.json": manifest({ version: "26.314.2", update_url: "https://clients2.google.com/service/update2/crx", key: "abc" }),
    "background.js": "run()", "icons/16.png": "png", "_metadata/verified_contents.json": "{}", "META-INF/cose.sig": "sig",
  });
  assert.equal(sameExtension(built, store), true);
  assert.equal(sameExtension(built, new Map([...store, ["background.js", Buffer.from("run(2)")]])), false);
  assert.equal(sameExtension(built, new Map([...store, ["extra.js", Buffer.from("")]])), false);
  const fewer = new Map(store);
  fewer.delete("icons/16.png");
  assert.equal(sameExtension(built, fewer), false);
  assert.equal(sameExtension(built, new Map([...store, ["manifest.json", manifest({ version: "1", permissions: ["tabs"] })]])), false);
});

test("versions compare by number, not as text", () => {
  assert.equal(compareVersions("26.315.24", "26.315.3"), 1);
  assert.equal(compareVersions("26.99.1", "26.315.1"), -1);
  assert.equal(compareVersions("26.315.24", "26.315.24"), 0);
  assert.equal(compareVersions("27.1.1", "26.365.40"), 1);
});

test("a store gets the build only when it is new, different and nothing waits for review", async () => {
  const published = (version: string, f: Files) => ({ version, files: async () => f });
  const same = files({ "manifest.json": manifest({ version: "26.314.2" }), "background.js": "run()", "icons/16.png": "png" });
  const changed = new Map([...same, ["background.js", Buffer.from("old()")]]);
  assert.equal(await reasonToSkip({ inReview: null, published: null }, "26.316.3", built), null);
  assert.equal(await reasonToSkip({ inReview: null, published: published("26.314.2", changed) }, "26.316.3", built), null);
  assert.match(await reasonToSkip({ inReview: null, published: published("26.314.2", same) }, "26.316.3", built) ?? "", /same extension/);
  assert.match(await reasonToSkip({ inReview: "26.315.24", published: published("26.314.2", changed) }, "26.316.3", built) ?? "", /waiting for review/);
  assert.match(await reasonToSkip({ inReview: null, published: published("26.316.3", changed) }, "26.316.3", built) ?? "", /already has/);
});
