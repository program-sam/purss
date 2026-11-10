import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportResult } from "@purss/domain";
import { effects, inFile, resultLines } from "./import-summary.ts";

test("only what the file holds is listed", () => {
  assert.deepEqual(inFile({ sources: 2, items: 10, baskets: 0, keptItems: 3, annotations: 4, itemReminders: 2 }),
    [{ label: "Sources", n: 2 }, { label: "Items", n: 10 }, { label: "Kept in baskets", n: 3 }, { label: "Your highlights and notes", n: 4 }, { label: "Your reminders", n: 2 }]);
  assert.deepEqual(inFile({}), []);
});

test("effects say what will happen, singular and plural", () => {
  assert.deepEqual(effects({ newItems: 1, existingItems: 2, sourcesToFollow: 1, sourcesToReconnect: 2, shares: 1 }), [
    "1 item will be added.",
    "2 items are already here and won't be added again.",
    "1 source will be followed again.",
    "2 private sources will need reconnecting, because their link wasn't in the file.",
    "Sharing settings of 1 basket or collection will come in switched off. Nothing is shared.",
  ]);
  assert.deepEqual(effects({}), []);
});

test("the result names what was added, what stayed and what needs the person", () => {
  const r: ImportResult = {
    created: { sources: 1, collections: 0, baskets: 1, items: 4, keptPins: 2, captures: 1, shares: 1, annotations: 5, reminders: 2 },
    alreadyPresent: { items: 3, sources: 0 }, following: 1, reconnectRequired: 1,
  };
  assert.deepEqual(resultLines(r), [
    "Added 4 items, 1 source, 1 basket, sharing settings for 1 basket or collection, switched off.",
    "2 kept items put back in baskets.",
    "1 saved text copy restored.",
    "2 reminders of yours restored.",
    "5 highlights and notes of yours restored.",
    "Already here and left as they were: 3 items.",
    "1 source followed again. New items arrive after the next check.",
    "1 private source needs reconnecting.",
  ]);
  const empty: ImportResult = { created: { sources: 0, collections: 0, baskets: 0, items: 0, keptPins: 0, captures: 0, shares: 0, annotations: 0, reminders: 0 }, alreadyPresent: { items: 0, sources: 0 }, following: 0, reconnectRequired: 0 };
  assert.deepEqual(resultLines(empty), ["Nothing new was added."]);
});
