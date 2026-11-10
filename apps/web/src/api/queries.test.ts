import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import type { ItemDTO } from "@purss/domain";
import { findItem, itemDetailQuery, itemListQuery, itemPreviewQuery, keys, putItem } from "./queries.ts";

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "itm_a", sourceId: "src_a", sourceTitle: "S", kind: "article", title: "T", url: null, author: null, excerpt: null, imageUrl: null, durationSeconds: null, readMinutes: null,
    doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 5, stateVersion: 4, fresh: true,
    progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null, ...over,
  };
}
const listKey = [...keys.items, "list", { scope: "all", filter: "active", sort: "newest" }] as const;

/** A cache holding a list page (not being watched) and the item's detail. */
function cacheWith(list: ItemDTO, detail: ItemDTO) {
  const qc = new QueryClient();
  qc.setQueryData(listKey, { pages: [{ items: [list], nextCursor: null, total: 1 }], pageParams: [undefined] });
  qc.setQueryData(keys.item(detail.id), { ...detail, contentHtml: null });
  return qc;
}
const inList = (qc: QueryClient) => (qc.getQueryData(listKey) as { pages: { items: ItemDTO[] }[] }).pages[0]!.items[0]!;

test("of two copies, the one with the higher state version is the one found, whatever the revision", () => {
  // The New marker was cleared (the detail was read afterwards); no revision moved, so only the state version tells which is newer.
  const stale = item({ fresh: true, stateVersion: 4 });
  const cleared = item({ fresh: false, opened: true, stateVersion: 5 });
  assert.equal(findItem(cacheWith(stale, cleared), "itm_a")!.fresh, false, "the list copy is stale, whichever comes first");
  assert.equal(findItem(cacheWith(cleared, stale), "itm_a")!.fresh, false, "and the other way round");
  // Clearing the marker and taking it back can happen within one millisecond and leave the revision alone: the later copy still wins.
  const restored = item({ fresh: true, opened: false, stateVersion: 6 });
  assert.equal(findItem(cacheWith(cleared, restored), "itm_a")!.fresh, true, "the Undo is the later copy");
  assert.equal(findItem(cacheWith(restored, cleared), "itm_a")!.fresh, true, "in either order");
  // A copy that moved the item on (revision and version both up) beats both.
  const moved = item({ workflow: "toread", revision: 6, stateVersion: 7, fresh: true });
  assert.equal(findItem(cacheWith(restored, moved), "itm_a")!.revision, 6);
  // The revision is for conflicts only: it does not order copies.
  assert.equal(findItem(cacheWith(item({ revision: 9, stateVersion: 3 }), item({ revision: 5, stateVersion: 4 })), "itm_a")!.stateVersion, 4);
});

test("a copy from PURSS replaces older copies, and never a newer one", () => {
  const qc = cacheWith(item({ fresh: true }), item({ fresh: true }));
  putItem(qc, item({ fresh: false, stateVersion: 5 }));
  assert.equal(inList(qc).fresh, false, "the stale list copy is replaced");
  assert.equal(findItem(qc, "itm_a")!.fresh, false);
  putItem(qc, item({ fresh: true, stateVersion: 4 })); // a late answer that is older
  assert.equal(inList(qc).fresh, false, "an older copy is ignored");
  putItem(qc, item({ fresh: true, opened: false, stateVersion: 6 })); // the Undo of the clear: the same revision, a later version
  assert.equal(inList(qc).fresh, true, "taking the clear back is the latest copy");
  // What the page itself shows for a change in flight (the same state version as the copy it started from) still goes through.
  putItem(qc, { ...inList(qc), opened: true });
  assert.equal(inList(qc).opened, true);
});

test("a keep that leaves the revision alone but moves the state version replaces the cached copy, and a late older copy cannot take it back out", () => {
  const qc = cacheWith(item({ basketIds: [], stateVersion: 4 }), item({ basketIds: [], stateVersion: 4 }));
  const kept = item({ basketIds: ["bkt_1"], stateVersion: 5 }); // same revision: keeping does not move it
  putItem(qc, kept);
  assert.deepEqual(inList(qc).basketIds, ["bkt_1"], "the list copy shows it kept");
  assert.deepEqual(findItem(qc, "itm_a")!.basketIds, ["bkt_1"]);
  assert.deepEqual((qc.getQueryData(keys.item("itm_a")) as ItemDTO).basketIds, ["bkt_1"], "and so does the detail copy");
  putItem(qc, item({ basketIds: [], stateVersion: 4 })); // an answer from before the keep, arriving late
  assert.deepEqual(inList(qc).basketIds, ["bkt_1"], "it stays kept");
  assert.deepEqual(findItem(cacheWith(item({ basketIds: [], stateVersion: 4 }), kept), "itm_a")!.basketIds, ["bkt_1"], "found whichever cache holds it");
  assert.deepEqual(findItem(cacheWith(kept, item({ basketIds: [], stateVersion: 4 })), "itm_a")!.basketIds, ["bkt_1"]);
});

test("a list reload answered from an older saved copy doesn't put back a state changed since", () => {
  const p = { scope: "toread", filter: "active", sort: "newest" };
  const shown = item({ workflow: "finished", revision: 6, stateVersion: 5 });
  const saved = item({ workflow: "toread", revision: 5, stateVersion: 4 });
  const other = item({ id: "itm_b", workflow: "toread" });
  const page = (items: ItemDTO[]) => ({ items, nextCursor: null, total: items.length });
  const share = itemListQuery(p).structuralSharing as (a: unknown, b: unknown) => unknown;
  const list = share({ pages: [page([shown])], pageParams: [undefined] }, { pages: [page([saved, other])], pageParams: [undefined] }) as { pages: { items: ItemDTO[] }[] };
  assert.deepEqual(list.pages[0]!.items.map((i) => [i.id, i.workflow]), [["itm_a", "finished"], ["itm_b", "toread"]]);
  const preview = (itemPreviewQuery(p, 5).structuralSharing as (a: unknown, b: unknown) => unknown)(page([shown]), page([saved])) as { items: ItemDTO[] };
  assert.equal(preview.items[0]!.workflow, "finished", "Home's previews too");
  const detail = (itemDetailQuery("itm_a").structuralSharing as (a: unknown, b: unknown) => unknown)({ ...shown, contentHtml: null }, { ...saved, contentHtml: "<p>x</p>" }) as ItemDTO & { contentHtml: string };
  assert.deepEqual([detail.workflow, detail.contentHtml], ["finished", "<p>x</p>"], "and the item itself");
  const newer = item({ workflow: "new", stateVersion: 9 });
  assert.equal((share({ pages: [page([shown])], pageParams: [undefined] }, { pages: [page([newer])], pageParams: [undefined] }) as { pages: { items: ItemDTO[] }[] }).pages[0]!.items[0]!.workflow, "new", "a newer answer wins");
});
