import test from "node:test";
import assert from "node:assert/strict";
import type { ActivityDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { plural } from "./format.ts";
import { activityLine, calmLine, freshDaysChoices, hasKeyboard, inQueue, isToListen, isToRead, isToWatch, nextCheckLine, pausedUntilLine, sinceLine } from "./returning.ts";

const t = app.lib.returning;
const nouns = app.lib.nouns;
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const o = { now: NOW, timeZone: "UTC", locale: "en-GB" };
const idle: ActivityDTO = { checking: false, sourceCount: 0, subscribing: 0, savingText: 0, lastCheckedAt: null, nextCheckAt: null, problem: null, sources: [], events: [] };

test("the summary band names the last visit and, with counts on, how many are New", () => {
  const since = { total: 412, boxes: [{ id: "a", name: "Essays", count: 300 }, { id: "b", name: "News", count: 112 }] };
  assert.equal(sinceLine(since, "2026-11-02T12:00:00.000Z", { ...o, showCounts: true }), t.sinceWithCount("3 days ago", "412", t.inPlace(plural(2, app.words.collectionLower))));
  assert.equal(sinceLine(since, "2026-11-02T12:00:00.000Z", { ...o, showCounts: false }), t.sinceWithoutCount("3 days ago", t.inPlace(plural(2, app.words.collectionLower))));
  assert.equal(sinceLine({ total: 1, boxes: [since.boxes[0]!] }, "2026-11-04T12:00:00.000Z", { ...o, showCounts: true }), t.sinceWithCount("yesterday", "1", t.inPlace("Essays")));
});

test("background activity reads as one calm line", () => {
  assert.deepEqual(activityLine({ ...idle, subscribing: 2, checking: true }, o), { text: t.settingUp(plural(2, app.words.sourceLower)), busy: true, problem: false });
  assert.equal(activityLine({ ...idle, checking: true, sourceCount: 3 }, o).text, t.checking(plural(3, app.words.sourceLower)));
  assert.equal(activityLine({ ...idle, savingText: 1 }, o).text, t.savingText(plural(1, app.words.item)));
  assert.deepEqual(activityLine({ ...idle, problem: "x" }, o), { text: t.cantCheck, busy: false, problem: true });
  assert.equal(activityLine({ ...idle, lastCheckedAt: "2026-11-05T11:56:00.000Z" }, o).text, t.upToDateChecked("4 min ago"));
  assert.equal(activityLine(idle, o).text, t.waitingFirstCheck);
});

test("the next check is an estimate in the person's time zone", () => {
  assert.equal(nextCheckLine({ ...idle, nextCheckAt: "2026-11-05T12:20:00.000Z" }, NOW, "UTC", "en-GB"), t.nextCheckAbout("12:20"));
  assert.equal(nextCheckLine({ ...idle, nextCheckAt: "2026-11-05T11:00:00.000Z" }, NOW, "UTC", "en-GB"), t.nextCheckSoon);
  assert.equal(nextCheckLine(idle, NOW, "UTC", "en-GB"), null);
});

test("a pause for a while says when it ends", () => {
  assert.equal(pausedUntilLine("2026-11-12T10:00:00.000Z", "UTC", "en-GB"), t.resumes("Thu 12 Nov"));
});

test("the keyboard hint is for devices that have a keyboard", () => {
  const device = (...matching: string[]) => (q: string) => matching.includes(q);
  assert.equal(hasKeyboard(device()), true, "a mouse-and-keyboard computer");
  assert.equal(hasKeyboard(device("(pointer: coarse)")), false, "a phone or tablet");
  assert.equal(hasKeyboard(device("(pointer: coarse)", "(any-pointer: fine)")), true, "a touch laptop");
});

test("the New-marker choices keep a saved value that is not one of the usual ones, in order", () => {
  assert.deepEqual(freshDaysChoices(30).map((c) => c.value), [7, 14, 30, 90, 0]);
  assert.deepEqual(freshDaysChoices(45).map((c) => c.value), [7, 14, 30, 45, 90, 0]);
  assert.equal(freshDaysChoices(365).find((c) => c.value === 365)!.label, t.freshDays.other(365));
});

test("Home does not say it is up to date while older items nobody has looked at are waiting", () => {
  const facts = { visited: true, items: 120, showCounts: true };
  assert.equal(calmLine({ unread: 54 }, facts), `${t.nothingNewSince}${t.olderNotLookedAt(plural(54, nouns.olderItem))}`);
  assert.equal(calmLine({ unread: 1 }, facts), `${t.nothingNewSince}${t.olderNotLookedAt(plural(1, nouns.olderItem))}`);
  assert.equal(calmLine({ unread: 54 }, { ...facts, showCounts: false }), t.nothingNewSince);
  assert.equal(calmLine({ unread: 54 }, { ...facts, visited: false }), `${t.nothingMarkedNew}${t.olderNotLookedAt(plural(54, nouns.olderItem))}`, "a first visit has no earlier visit to be new since");
  assert.equal(calmLine({ unread: 0 }, facts), t.upToDate);
  assert.equal(calmLine({ unread: 0 }, { ...facts, items: 0 }), t.nothingArrived);
});

test("what was put aside lands in one row by kind: articles To read, videos To watch, podcasts To listen", () => {
  const rows = (workflow: "toread" | "inprogress" | "new" | "finished" | "ignored", kind: string) => [isToRead, isToWatch, isToListen].map((keeps) => keeps({ workflow, kind } as never));
  assert.deepEqual(rows("toread", "article"), [true, false, false]);
  assert.deepEqual(rows("toread", "paper"), [true, false, false], "every kind that is not a video or a podcast is read");
  assert.deepEqual(rows("toread", "video"), [false, true, false]);
  assert.deepEqual(rows("toread", "podcast"), [false, false, true]);
  assert.deepEqual(rows("new", "video"), [false, false, false], "only what was put aside");
  assert.deepEqual(rows("finished", "podcast"), [false, false, false]);
});

test("the queue is what was put aside and what was started: an episode half heard stays in its row", () => {
  const rows = (workflow: "toread" | "inprogress" | "new" | "finished" | "ignored", kind: string) => [isToRead, isToWatch, isToListen].map((keeps) => keeps({ workflow, kind } as never));
  assert.deepEqual(rows("inprogress", "podcast"), [false, false, true]);
  assert.deepEqual(rows("inprogress", "video"), [false, true, false]);
  assert.deepEqual(rows("inprogress", "article"), [true, false, false]);
  assert.deepEqual(rows("ignored", "podcast"), [false, false, false]);
  assert.deepEqual(["new", "toread", "inprogress", "finished", "ignored"].map((workflow) => inQueue({ workflow } as never)), [false, true, true, false, false]);
});
