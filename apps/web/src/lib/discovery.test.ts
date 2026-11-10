import assert from "node:assert/strict";
import { test } from "node:test";
import { preselect } from "./discovery.ts";

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
