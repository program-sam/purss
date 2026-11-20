import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportResult } from "@purss/domain";
import { app } from "@purss/copy/app";
import { plural } from "../../lib/format.ts";
import { effects, inFile, resultLines } from "./import-summary.ts";

const t = app.data.importSummary;

test("only what the file holds is listed", () => {
  assert.deepEqual(inFile({ sources: 2, items: 10, baskets: 0, keptItems: 3, annotations: 4, itemReminders: 2 }),
    [{ label: app.words.sources, n: 2 }, { label: app.words.items, n: 10 }, { label: t.inFile.keptItems, n: 3 }, { label: t.inFile.annotations, n: 4 }, { label: t.inFile.itemReminders, n: 2 }]);
  assert.deepEqual(inFile({}), []);
});

test("effects say what will happen, singular and plural", () => {
  assert.deepEqual(effects({ newItems: 1, existingItems: 2, sourcesToFollow: 1, sourcesToReconnect: 2, shares: 1 }), [
    t.willBeAdded(plural(1, app.words.item)),
    t.alreadyHere(plural(2, app.words.item), 2),
    t.willBeFollowed(plural(1, app.words.sourceLower)),
    t.willNeedReconnecting(plural(2, app.words.privateSource), 2),
    t.sharingSwitchedOff(plural(1, t.basketOrCollection, t.basketsAndCollections)),
  ]);
  assert.deepEqual(effects({}), []);
});

test("the result names what was added, what stayed and what needs the person", () => {
  const r: ImportResult = {
    created: { sources: 1, collections: 0, baskets: 1, items: 4, keptPins: 2, captures: 1, shares: 1, annotations: 5, reminders: 2 },
    alreadyPresent: { items: 3, sources: 0 }, following: 1, reconnectRequired: 1,
  };
  assert.deepEqual(resultLines(r), [
    t.added([plural(4, app.words.item), plural(1, app.words.sourceLower), plural(1, app.words.basketLower), t.madeShares(plural(1, t.basketOrCollection, t.basketsAndCollections))].join(", ")),
    t.keptPins(plural(2, app.words.keptItem)),
    t.capturesRestored(plural(1, t.savedTextCopy, t.savedTextCopies)),
    t.remindersRestored(plural(2, t.reminder)),
    t.annotationsRestored(plural(5, app.words.highlightOrNote, app.words.highlightsAndNotes)),
    t.alreadyPresent(plural(3, app.words.item)),
    t.followingAgain(plural(1, app.words.sourceLower)),
    t.reconnectRequired(plural(1, app.words.privateSource), 1),
  ]);
  const empty: ImportResult = { created: { sources: 0, collections: 0, baskets: 0, items: 0, keptPins: 0, captures: 0, shares: 0, annotations: 0, reminders: 0 }, alreadyPresent: { items: 0, sources: 0 }, following: 0, reconnectRequired: 0 };
  assert.deepEqual(resultLines(empty), [t.nothingNew]);
});
