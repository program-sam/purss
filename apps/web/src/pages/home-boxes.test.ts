import test from "node:test";
import assert from "node:assert/strict";
import type { CollectionDTO, SourceDTO } from "@purss/domain";
import { boxScope, distribute, homeBoxes, isOtherBox, moreInBoxes, OTHER_BOX_ID } from "./home-boxes.ts";

const col = (id: string, position: number): CollectionDTO => ({ id, name: id.toUpperCase(), emoji: null, mode: "sources", view: "list", position, showOnHome: true, sourceIds: [], query: null, newCount: 0, itemCount: 0, aiFiltered: false });
const src = (id: string, newCount: number, itemCount: number) => ({ id, newCount, itemCount }) as SourceDTO;

test("Other sources shows after the collections until Customise moves it", () => {
  const shown = [col("a", 0), col("b", 1)];
  const loose = [src("s1", 2, 10), src("s2", 3, 5)];
  const boxes = homeBoxes(shown, loose, { homeOther: true, homeCollectionIds: [] });
  assert.deepEqual(boxes.map((b) => b.id), ["a", "b", OTHER_BOX_ID]);
  assert.deepEqual([boxes[2]!.newCount, boxes[2]!.itemCount, boxes[2]!.sourceIds], [5, 15, ["s1", "s2"]]);
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

test("an item shows in the first Home box that has it", () => {
  const it = (id: string) => ({ id });
  const lists = distribute([[it("a"), it("b"), it("c")], [it("b"), it("d")], [it("a"), it("d"), it("e")]], [9, 9, 9]);
  assert.deepEqual(lists.map((l) => l.map((x) => x.id)), [["a", "b", "c"], ["d"], ["e"]], "b, a and d by the first box that has them");
  assert.deepEqual(distribute([], []), []);
});

test("a box reserves only the items it shows: one it fetched beyond its rows, or a collapsed box, leaves the item to a later box", () => {
  const items = (...ids: string[]) => ids.map((id) => ({ id }));
  const first = items("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17");
  const shown = distribute([first, items("6")], [5, 5]).map((l) => l.map((x) => x.id));
  assert.deepEqual(shown, [["1", "2", "3", "4", "5"], ["6"]], "the sixth item is not shown by the first box, so the second box shows it");
  // A box that is collapsed shows nothing and keeps nothing.
  assert.deepEqual(distribute([items("a", "b"), items("a", "c")], [0, 5]).map((l) => l.map((x) => x.id)), [[], ["a", "c"]]);
  // What a box skips because an earlier box has it does not count against its rows.
  assert.deepEqual(distribute([items("a", "b"), items("a", "b", "c", "d")], [5, 2]).map((l) => l.map((x) => x.id)), [["a", "b"], ["c", "d"]]);
});

test("a box offers more only for the items it holds beyond the ones Home shows, here or in an earlier box", () => {
  const it = (id: string) => ({ id });
  const lists = [[it("a"), it("b")], [it("a"), it("c"), it("d")], [it("e")]];
  const shown = distribute(lists, [1, 1, 1]);
  assert.deepEqual(shown.map((l) => l.map((x) => x.id)), [["a"], ["c"], ["e"]]);
  assert.deepEqual(moreInBoxes(lists, shown, [2, 3, 1], [false, false, false]), [1, 1, 0], "one shown, one more; one shown and one in the first box; all shown");
  assert.deepEqual(moreInBoxes(lists, shown, [1, null, null], [false, false, true]), [0, null, null], "no total: more when fetched beyond the rows or the list goes on");
  assert.deepEqual(moreInBoxes([[it("e")]], [[it("e")]], [null], [false]), [0]);
});
