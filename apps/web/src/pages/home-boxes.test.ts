import test from "node:test";
import assert from "node:assert/strict";
import type { CollectionDTO, HomeOverview, ItemDTO, SourceDTO } from "@purss/domain";
import { boxScope, distribute, homeBoxes, isOtherBox, OTHER_BOX_ID, shownAbove } from "./home-boxes.ts";

const col = (id: string, position: number): CollectionDTO => ({ id, name: id.toUpperCase(), emoji: null, mode: "sources", view: "list", position, showOnHome: true, sourceIds: [], query: null, freshCount: 0, itemCount: 0, aiFiltered: false });
const src = (id: string, freshCount: number, itemCount: number) => ({ id, freshCount, itemCount }) as SourceDTO;

test("Other sources shows after the collections until Customise moves it", () => {
  const shown = [col("a", 0), col("b", 1)];
  const loose = [src("s1", 2, 10), src("s2", 3, 5)];
  const boxes = homeBoxes(shown, loose, { homeOther: true, homeCollectionIds: [] });
  assert.deepEqual(boxes.map((b) => b.id), ["a", "b", OTHER_BOX_ID]);
  assert.deepEqual([boxes[2]!.freshCount, boxes[2]!.itemCount, boxes[2]!.sourceIds], [5, 15, ["s1", "s2"]]);
  assert.deepEqual(homeBoxes(shown, loose, { homeOther: true, homeCollectionIds: ["a", OTHER_BOX_ID, "b"] }).map((b) => b.id), ["a", OTHER_BOX_ID, "b"]);
  assert.deepEqual(homeBoxes(shown, loose, { homeOther: true, homeCollectionIds: [OTHER_BOX_ID, "a", "b"] }).map((b) => b.id), [OTHER_BOX_ID, "a", "b"]);
});

test("Other sources is absent when switched off or when every source is in a collection", () => {
  const shown = [col("a", 0)];
  assert.deepEqual(homeBoxes(shown, [src("s1", 0, 0)], { homeOther: false, homeCollectionIds: [] }).map((b) => b.id), ["a"]);
  assert.deepEqual(homeBoxes(shown, [], { homeOther: true, homeCollectionIds: [] }).map((b) => b.id), ["a"]);
});

test("the box order does not depend on anything but the saved order", () => {
  const shown = [col("c", 2), col("a", 0), col("b", 1)];
  const loose = [src("s", 0, 0)];
  const first = homeBoxes(shown, loose, { homeOther: true, homeCollectionIds: ["c", "a"] }).map((b) => b.id);
  const again = homeBoxes([...shown], [...loose], { homeOther: true, homeCollectionIds: ["c", "a"] }).map((b) => b.id);
  assert.deepEqual(first, again);
});

test("a box lists items by its scope", () => {
  assert.equal(boxScope(col("a", 0)), "collection:a");
  assert.equal(boxScope({ id: OTHER_BOX_ID }), "loose");
  assert.equal(isOtherBox({ id: OTHER_BOX_ID }), true);
});

test("an item shows in the first Home section that has it", () => {
  const it = (id: string) => ({ id });
  const lists = distribute([[it("a"), it("b"), it("c")], [it("b"), it("d")], [it("a"), it("d"), it("e")]], new Set(["c"]), [9, 9, 9]);
  assert.deepEqual(lists.map((l) => l.map((x) => x.id)), [["a", "b"], ["d"], ["e"]], "c is shown above the boxes; b, a and d by the first box that has them");
  assert.deepEqual(distribute([], new Set(), []), []);
});

test("a box reserves only the items it shows: one it fetched beyond its rows, or a collapsed box, leaves the item to a later box", () => {
  const items = (...ids: string[]) => ids.map((id) => ({ id }));
  const first = items("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17");
  const shown = distribute([first, items("6")], new Set(), [5, 5]).map((l) => l.map((x) => x.id));
  assert.deepEqual(shown, [["1", "2", "3", "4", "5"], ["6"]], "the sixth item is not shown by the first box, so the second box shows it");
  // A box that is collapsed shows nothing and keeps nothing.
  assert.deepEqual(distribute([items("a", "b"), items("a", "c")], new Set(), [0, 5]).map((l) => l.map((x) => x.id)), [[], ["a", "c"]]);
  // What a box skips because an earlier box has it does not count against its rows.
  assert.deepEqual(distribute([items("a", "b"), items("a", "b", "c", "d")], new Set(), [5, 2]).map((l) => l.map((x) => x.id)), [["a", "b"], ["c", "d"]]);
});

const queued = (id: string, over: Partial<ItemDTO> = {}): ItemDTO => ({ id, kind: "article", workflow: "toread", publishedAt: null, discoveredAt: "2026-11-10T08:00:00Z", listedAt: "2026-11-10T08:00:00Z", ...over }) as ItemDTO;
const row = (items: ItemDTO[], total = items.length): HomeOverview["toRead"] => ({ items, total, totalAtMost: false });
const none = row([]);
const rows = (o: Partial<Pick<HomeOverview, "toRead" | "toWatch" | "toListen">>) => ({ toRead: none, toWatch: none, toListen: none, ...o });

test("a row above the boxes shows an item once it is open and has room for it, so the item leaves its box", () => {
  const open = ["home:toread", "home:towatch", "home:tolisten"];
  const o = rows({ toRead: row([queued("a"), queued("b")]) });
  assert.equal(shownAbove(queued("x"), o, open), true, "the row lists every queued item, so one more joins it");
  assert.equal(shownAbove(queued("x"), o, []), false, "a closed row shows nothing, so the item stays in its box");
  assert.equal(shownAbove(queued("x"), undefined, open), false, "before Home's overview is known");
  assert.equal(shownAbove(queued("x", { workflow: "new" }), o, open), false, "only what is queued");
  assert.equal(shownAbove(queued("x", { workflow: "finished" }), o, open), false);
  assert.equal(shownAbove(queued("a"), o, open), true, "an item the row already lists");
  assert.equal(shownAbove(queued("x", { kind: "podcast" }), o, open), true, "a podcast has the To listen row, which has room");
  assert.equal(shownAbove(queued("x", { kind: "podcast" }), o, ["home:toread"]), false, "and only that row's openness counts");
  assert.equal(shownAbove(queued("x", { kind: "video" }), rows({ toWatch: row([queued("v", { kind: "video" })]) }), ["home:towatch"]), true);
});

test("a full row shows a newly queued item only where it would rank: started first, then the oldest", () => {
  const open = ["home:toread"];
  const listed = row([queued("s", { workflow: "inprogress", listedAt: "2026-11-15T00:00:00Z" }), queued("o1", { listedAt: "2026-11-01T00:00:00Z" }), queued("o2", { listedAt: "2026-11-05T00:00:00Z" })], 9);
  const o = rows({ toRead: listed });
  assert.equal(shownAbove(queued("older", { listedAt: "2026-11-02T00:00:00Z" }), o, open), true, "older than the last one shown: it takes a place in the row");
  assert.equal(shownAbove(queued("newer", { listedAt: "2026-11-09T00:00:00Z" }), o, open), false, "newer than the last one shown: it stays in its box");
  assert.equal(shownAbove(queued("started", { workflow: "inprogress", listedAt: "2026-11-20T00:00:00Z" }), o, open), true, "started items come first, whatever their date");
  const allStarted = rows({ toRead: row([queued("s1", { workflow: "inprogress" })], 9) });
  assert.equal(shownAbove(queued("x", { listedAt: "2026-01-01T00:00:00Z" }), allStarted, open), false, "behind every started item");
});
