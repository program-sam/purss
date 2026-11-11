import test from "node:test";
import assert from "node:assert/strict";
import type { CollectionStatsRow, StatsNumbers } from "@purss/domain";
import { countWithShare, firstDirection, gapLabel, sharePercent, sortRows, sparklineLabel, weeklyAverage } from "./stats.ts";

function numbers(over: Partial<StatsNumbers> = {}): StatsNumbers {
  return {
    totalItems: 0, weekly: new Array<number>(26).fill(0), lastItemAt: null, longestGapDays: null,
    workflow: { new: 0, toread: 0, inprogress: 0, finished: 0, ignored: 0 },
    opened: 0, kept: 0, finishedLast30Days: 0, ignoredLast30Days: 0, filteredOut: 0, ...over,
  };
}
const row = (title: string, over: Partial<StatsNumbers> = {}): CollectionStatsRow => ({ sourceId: title.toLowerCase(), title, stats: numbers(over) });

test("a count always comes first, with its share beside it", () => {
  assert.equal(countWithShare(31, 129), "31 (24%)");
  assert.equal(countWithShare(0, 40), "0 (0%)");
  assert.equal(countWithShare(1, 1000), "1 (<1%)", "a small share is shown as small, never rounded to nothing");
  assert.equal(countWithShare(0, 0), "0", "no share of nothing");
  assert.equal(sharePercent(129, 129), "100%");
});

test("average, label and gap are plain numbers", () => {
  const weekly = new Array<number>(26).fill(0);
  weekly[25] = 3; weekly[24] = 2;
  assert.equal(weeklyAverage(weekly), 0.2);
  assert.equal(weeklyAverage([]), 0);
  assert.match(sparklineLabel(weekly), /^Items per week over the last 26 weeks, oldest first: 0, 0,.*2, 3\. Average 0\.2 per week\.$/);
  assert.deepEqual([gapLabel(null), gapLabel(1), gapLabel(56), gapLabel(0.4)], ["–", "1 day", "56 days", "0.4 days"]);
});

test("rows sort by the chosen column and fall back to the name on ties", () => {
  const rows = [row("Bravo", { totalItems: 5, kept: 1 }), row("alpha", { totalItems: 5, kept: 3, lastItemAt: "2026-10-01T00:00:00.000Z" }), row("Charlie", { totalItems: 9, workflow: { new: 0, toread: 0, inprogress: 0, finished: 4, ignored: 0 } })];
  const names = (key: Parameters<typeof sortRows>[1], dir: "asc" | "desc") => sortRows(rows, key, dir).map((r) => r.title);
  assert.deepEqual(names("name", "asc"), ["alpha", "Bravo", "Charlie"]);
  assert.deepEqual(names("name", "desc"), ["Charlie", "Bravo", "alpha"]);
  assert.deepEqual(names("items", "desc"), ["Charlie", "alpha", "Bravo"]);
  assert.deepEqual(names("items", "asc"), ["alpha", "Bravo", "Charlie"]);
  assert.deepEqual(names("kept", "desc"), ["alpha", "Bravo", "Charlie"]);
  assert.deepEqual(names("finished", "desc"), ["Charlie", "alpha", "Bravo"]);
  assert.deepEqual(names("last", "desc"), ["alpha", "Bravo", "Charlie"], "sources without items come last when the latest date comes first");
  assert.deepEqual(rows.map((r) => r.title), ["Bravo", "alpha", "Charlie"], "the input is not reordered");
  assert.deepEqual([firstDirection("name"), firstDirection("items"), firstDirection("last")], ["asc", "desc", "desc"]);
});
