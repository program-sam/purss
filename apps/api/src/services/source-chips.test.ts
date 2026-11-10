import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { listItemIds, listItems } from "./items.ts";

test("the source chips narrow a list to the sources picked, or leave the ones switched off out", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  const first = makeSource(app, p, "First", "feed/1");
  const second = makeSource(app, p, "Second", "feed/2");
  const third = makeSource(app, p, "Third", "feed/3");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/2"), entry("feed/3")]));
  const from = (q: { source?: string; without?: string }) => listItems(app, p, { scope: "all", filter: "all", ...q }).items.map((i) => i.sourceId).sort();
  assert.deepEqual(from({ source: `${first},${third}` }), [first, third].sort());
  assert.deepEqual(from({ without: second }), [first, third].sort());
  assert.deepEqual(from({ without: `${first},${second}` }), [third]);
  assert.deepEqual(from({}), [first, second, third].sort());
  assert.equal(listItemIds(app, p, { scope: "all", without: `${first},${third}` }).total, 1, "Select all follows the chips");
  assert.throws(() => from({ source: "a b" }), "only source ids");
});
