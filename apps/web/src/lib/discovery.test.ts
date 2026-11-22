import assert from "node:assert/strict";
import { test } from "node:test";
import { byChance, preselect, shuffled } from "./discovery.ts";

const m = (...flags: (boolean | undefined)[]) => flags.map((matchesPage) => ({ matchesPage }));

test("the feed that matches the pasted page is chosen, not the first of the list", () => {
  assert.equal(preselect(m(false, true, false)), 1);
  assert.equal(preselect(m(true, true)), 0, "several of the page's own: the first of them");
});

test("a single result is chosen; so is the first when nothing says they differ", () => {
  assert.equal(preselect([]), -1);
  assert.equal(preselect(m(undefined)), 0);
  assert.equal(preselect(m(false)), 0);
  assert.equal(preselect(m(undefined, undefined, undefined)), 0, "a service's fixed feeds, or a feed address pasted directly");
});

test("several feeds merely listed on the page and none of them its own: none is chosen", () => {
  assert.equal(preselect(m(false, false, false)), -1);
  assert.equal(preselect(m(false, undefined)), -1);
});

test("an alternative (a journal through Crossref) is never chosen over the others, and is chosen when it is all there is", () => {
  const alt = { matchesPage: undefined, alternative: true };
  assert.equal(preselect([{ matchesPage: true }, alt]), 0, "the journal's own feed and its Crossref choice");
  assert.equal(preselect([{ matchesPage: false }, alt]), 0, "a lone listed feed stays chosen as it was without the alternative");
  assert.equal(preselect([{ matchesPage: false }, { matchesPage: false }, alt]), -1, "several listed feeds: still none");
  assert.equal(preselect([{ ...alt, matchesPage: true }, { matchesPage: false }]), 1, "an alternative claiming the page doesn't win");
  assert.equal(preselect([alt]), 0);
});

test("a page list is chosen only when PURSS is confident of it: a medium one is offered and left to the person, even alone", () => {
  const high = { matchesPage: true, pageList: { confidence: "high" as const } };
  const medium = { matchesPage: false, pageList: { confidence: "medium" as const } };
  assert.equal(preselect([high, medium, medium]), 0, "the confident list, the others offered");
  assert.equal(preselect([medium]), -1, "a lone medium list is not chosen");
  assert.equal(preselect([medium, medium, medium]), -1, "several medium lists: none");
  assert.equal(preselect([{ matchesPage: undefined, pageList: { confidence: "medium" as const } }]), -1, "whatever the page's flag says");
  assert.equal(preselect([medium, { matchesPage: false, alternative: true }]), 1, "an alternative that isn't a page list is still chosen when it is all there is");
  assert.equal(preselect([medium, { matchesPage: true }]), 1, "an ordinary feed beside a medium list");
});

test("anything found in the page's scripts is offered and never chosen for the person, whether it is the only candidate or one of several", () => {
  const feed = { matchesPage: false, fromScripts: true };
  const list = { matchesPage: false, fromScripts: true, pageList: { confidence: "high" as const } };
  assert.equal(preselect([feed]), -1, "a lone feed named in a script is not chosen");
  assert.equal(preselect([list]), -1, "nor a lone list, though PURSS was sure of it on its page");
  assert.equal(preselect([feed, feed, feed]), -1);
  assert.equal(preselect([list, { matchesPage: false, fromScripts: true, pageList: { confidence: "medium" as const } }]), -1);
  assert.equal(preselect([{ ...feed, matchesPage: true }]), -1, "whatever the page's flag says");
  assert.equal(preselect([feed, { matchesPage: true }]), 1, "a candidate that is shown to be the page's own is still chosen");
  assert.equal(preselect([feed, { matchesPage: undefined, alternative: true }]), 1, "an alternative that is not from scripts is chosen when it is all there is");
});

/** A seeded stand-in for Math.random. */
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) + 0.5) / 2 ** 31;

test("popular sources come in a different order on each visit, yet the most popular usually come first", () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: i, weight: 14 - i * 0.4 }));
  const a = byChance(list, seeded(1)).map((s) => s.id);
  const b = byChance(list, seeded(2)).map((s) => s.id);
  assert.notDeepEqual(a, b, "chance changes the order");
  assert.deepEqual([...a].sort((x, y) => x - y), list.map((s) => s.id), "nothing lost or doubled");
  let topSix = 0;
  for (let seed = 1; seed <= 200; seed++) topSix += byChance(list, seeded(seed)).slice(0, 6).filter((s) => s.id < 6).length;
  assert.ok(topSix / 200 > 3, `on average more than half of a box is the six most popular (${topSix / 200})`);
});

test("the category boxes are shuffled without losing or doubling one", () => {
  const boxes = ["news", "technology", "science", "food", "sports"];
  const out = shuffled(boxes, seeded(3));
  assert.deepEqual([...out].sort(), [...boxes].sort());
  assert.deepEqual(boxes, ["news", "technology", "science", "food", "sports"], "the list given is left as it was");
});
