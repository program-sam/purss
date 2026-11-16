import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capacity } from "@purss/domain";
import { capacityOf, collectionLimitNote } from "./plan-limits.ts";

const cap = (plan: Capacity["plan"], used: number, limit: number | null): Capacity => ({
  plan, sources: { used: 3, limit: null }, collections: { used, limit }, storage: { used: 0, limit: null },
});

test("a Free account with all its collections is told so before it starts another, with what to do", () => {
  assert.equal(collectionLimitNote(cap("free", 5, 5)),
    "Your Free plan allows 5 collections, and you have 5. Remove one to add another. Plus has no limit on collections.");
});

test("an account over its limit (after moving to a smaller plan) is told the same", () => {
  assert.match(collectionLimitNote(cap("free", 7, 5)) ?? "", /allows 5 collections, and you have 7/);
});

test("there is nothing to say while there is room, without a limit, or on a self-hosted PURSS", () => {
  assert.equal(collectionLimitNote(cap("free", 4, 5)), null);
  assert.equal(collectionLimitNote(cap("plus", 40, null)), null);
  assert.equal(collectionLimitNote(cap(null, 40, null)), null, "self-hosted: no plan");
  assert.equal(collectionLimitNote(null), null, "a copy saved offline by an earlier version has no capacity");
});

test("capacity is read from the workspace when it carries it", () => {
  const c = cap("free", 5, 5);
  assert.equal(capacityOf({ capacity: c }), c);
  assert.equal(capacityOf({}), null);
});
