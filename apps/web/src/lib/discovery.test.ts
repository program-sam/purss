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
