import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { listItemIds, listItems } from "./items.ts";
import { changeState } from "./state.ts";
import { MAX_BULK_ITEMS } from "@purss/domain";

test("Select all takes every item the list shows, past the loaded pages, in the list's order", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  const src = makeSource(app, p, "First", "feed/1");
  const other = makeSource(app, p, "Second", "feed/2");
  applySyncBatch(app, p.engineUserId, batch([...Array.from({ length: 7 }, () => entry("feed/1")), entry("feed/2")]));
  const paged: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listItems(app, p, { scope: "all", sort: "oldest", limit: 3, cursor });
    paged.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(listItemIds(app, p, { scope: "all", sort: "oldest" }), { ids: paged, total: 8 }, "same items, same order as paging");
  assert.equal(listItemIds(app, p, { scope: "all", without: other }).total, 7, "follows the chips");
  assert.equal(listItemIds(app, p, { scope: `source:${src}`, source: other }).total, 0);
  changeState(app, p, paged[0]!, { workflow: "ignored", expectedRevision: 0 });
  assert.equal(listItemIds(app, p, { scope: "all" }).total, 7, "follows the list's state filter");
  const outsider = makeOwner(app, { admin: false });
  assert.deepEqual(listItemIds(app, outsider, { scope: "all", filter: "all" }), { ids: [], total: 0 }, "never another PURSS's items");
});

test("Select all past its limit says there are more instead of counting them all", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  makeSource(app, p, "Busy", "feed/1");
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: MAX_BULK_ITEMS + 1 }, () => entry("feed/1"))));
  const out = listItemIds(app, p, { scope: "all", filter: "all" });
  assert.equal(out.ids.length, MAX_BULK_ITEMS);
  assert.equal(out.total, null);
});
