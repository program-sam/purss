import assert from "node:assert/strict";
import { test } from "node:test";
import { createPictureCache } from "./pictures.ts";

function setup(opts: { fail?: Set<string> } = {}) {
  const loads: string[] = [];
  let n = 0;
  const picture = createPictureCache({
    budgetBytes: 1_000_000,
    load: async (path) => {
      loads.push(path);
      if (opts.fail?.has(path)) throw new Error("offline");
      return new Blob([new Uint8Array(path.length * 10)]);
    },
    createUrl: () => `blob:test/${++n}`,
    revokeUrl: () => assert.fail("nothing is let go under the budget"),
  });
  return { picture, loads };
}

test("a picture is fetched once: asking again while it loads waits for the same fetch, and afterwards is answered at once", async () => {
  const { picture, loads } = setup();
  const first = picture("/api/sources/a/icon?v=1");
  const again = picture("/api/sources/a/icon?v=1");
  assert.ok(first instanceof Promise);
  assert.equal(again, first);
  assert.equal(await first, "blob:test/1");
  assert.equal(picture("/api/sources/a/icon?v=1"), "blob:test/1", "known now, so an <img> gets it on its first render");
  assert.deepEqual(loads, ["/api/sources/a/icon?v=1"]);
});

test("a picture that failed is asked for again next time", async () => {
  const fail = new Set(["/p/x"]);
  const { picture, loads } = setup({ fail });
  await assert.rejects(Promise.resolve(picture("/p/x")));
  fail.clear();
  assert.equal(await picture("/p/x"), "blob:test/1");
  assert.deepEqual(loads, ["/p/x", "/p/x"]);
});

test("over the budget the least recently asked-for copies go, never the one just fetched or one still loading", async () => {
  const revoked: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let n = 0;
  // Every picture is 40 bytes: three fit in 120.
  const picture = createPictureCache({
    budgetBytes: 120,
    load: async (path) => { if (path === "/p/held") await held; return new Blob([new Uint8Array(40)]); },
    createUrl: () => `blob:test/${++n}`,
    revokeUrl: (u) => revoked.push(u),
  });
  await picture("/p/a");
  await picture("/p/b");
  await picture("/p/c");
  picture("/p/a"); // used again: now b is the oldest
  const loading = picture("/p/held");
  await picture("/p/d");
  assert.deepEqual(revoked, ["blob:test/2"], "b went to make room for d; the one still loading stayed");
  release();
  assert.equal(await loading, "blob:test/5");
  assert.deepEqual(revoked, ["blob:test/2", "blob:test/3"], "then c for it");
  assert.equal(picture("/p/a"), "blob:test/1");
  assert.equal(picture("/p/held"), "blob:test/5");
  assert.ok(picture("/p/b") instanceof Promise, "b is fetched again when shown again");
});
