import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { exactQuery, searchItems } from "./search.ts";

function releases() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Releases", "feed/rel");
  // The exact version is the oldest; the versions that merely begin with the same numbers are newer.
  const titles = ["v26.12.1", "v26.12.10", "v26.12.11", "26.12.1-rc1", "v26.12", "Notes on 26 sediment cores"];
  applySyncBatch(app, p.engineUserId, batch(titles.map((title, i) => entry("feed/rel", {
    title, summaryHtml: `<p>Release ${title.replace(/^v/, "")} notes</p>`, publishedAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
  }))));
  return { app, p, cleanup };
}

test("a version-like word is asked for as the numbers in a row; other words stay word starts", () => {
  assert.equal(exactQuery("26.12.1"), '("26 12 1" OR "v26 12 1")', "a release is as often written v26.12.1");
  assert.equal(exactQuery("v26.12.1 release"), '"v26 12 1" AND "release"*');
  assert.equal(exactQuery("26.12.1 release"), '("26 12 1" OR "v26 12 1") AND "release"*', "a group is joined with an explicit AND, which the index requires");
  assert.equal(exactQuery("2026-11-05"), '("2026 11 05" OR "v2026 11 05")');
  assert.equal(exactQuery("tidal flats"), null);
  assert.equal(exactQuery("release 26"), null, "a lone number is an ordinary word start");
});

test("an exact version ranks before the newer versions that only begin with the same numbers", (t) => {
  const { app, p, cleanup } = releases();
  t.after(cleanup);
  const titles = searchItems(app, p, "26.12.1").map((i) => i.title);
  assert.deepEqual(titles.slice(0, 2), ["26.12.1-rc1", "v26.12.1"], "both items that hold 26.12.1 in a row come first, newest first");
  assert.ok(titles.includes("v26.12.10") && titles.includes("v26.12.11"), "the near matches are still offered after them");
  assert.equal(new Set(titles).size, titles.length, "nothing is listed twice");
});

test("a version with other words is searched as well", (t) => {
  const { app, p, cleanup } = releases();
  t.after(cleanup);
  assert.deepEqual(searchItems(app, p, "26.12.1 release").map((i) => i.title).slice(0, 2), ["26.12.1-rc1", "v26.12.1"]);
  assert.deepEqual(searchItems(app, p, "v26.12.1 notes").map((i) => i.title).slice(0, 1), ["v26.12.1"]);
});

test("a search without a version is unchanged", (t) => {
  const { app, p, cleanup } = releases();
  t.after(cleanup);
  assert.deepEqual(searchItems(app, p, "sediment").map((i) => i.title), ["Notes on 26 sediment cores"]);
});

test("the limit holds, and exact matches fill it first", (t) => {
  const { app, p, cleanup } = releases();
  t.after(cleanup);
  assert.deepEqual(searchItems(app, p, "26.12.1", 1).map((i) => i.title), ["26.12.1-rc1"]);
});
