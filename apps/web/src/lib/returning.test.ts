import test from "node:test";
import assert from "node:assert/strict";
import type { ActivityDTO } from "@purss/domain";
import { activityLine, calmLine, freshDaysChoices, hasKeyboard, nextCheckLine, pausedUntilLine, sinceLine } from "./returning.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const o = { now: NOW, timeZone: "UTC", locale: "en-GB" };
const idle: ActivityDTO = { checking: false, sourceCount: 0, subscribing: 0, savingText: 0, lastCheckedAt: null, nextCheckAt: null, problem: null, sources: [], events: [] };

test("the summary band names the last visit and, with counts on, how many are New", () => {
  const since = { total: 412, boxes: [{ id: "a", name: "Essays", count: 300 }, { id: "b", name: "News", count: 112 }] };
  assert.equal(sinceLine(since, "2026-11-02T12:00:00.000Z", { ...o, showCounts: true }), "Since your last visit (3 days ago): 412 new in 2 collections");
  assert.equal(sinceLine(since, "2026-11-02T12:00:00.000Z", { ...o, showCounts: false }), "New items since your last visit (3 days ago) in 2 collections");
  assert.equal(sinceLine({ total: 1, boxes: [since.boxes[0]!] }, "2026-11-04T12:00:00.000Z", { ...o, showCounts: true }), "Since your last visit (yesterday): 1 new in Essays");
});

test("background activity reads as one calm line", () => {
  assert.deepEqual(activityLine({ ...idle, subscribing: 2, checking: true }, o), { text: "Setting up 2 sources…", busy: true, problem: false });
  assert.equal(activityLine({ ...idle, checking: true, sourceCount: 3 }, o).text, "Checking 3 sources…");
  assert.equal(activityLine({ ...idle, savingText: 1 }, o).text, "Saving text for 1 item…");
  assert.deepEqual(activityLine({ ...idle, problem: "x" }, o), { text: "Couldn't check your sources", busy: false, problem: true });
  assert.equal(activityLine({ ...idle, lastCheckedAt: "2026-11-05T11:56:00.000Z" }, o).text, "Up to date · checked 4 min ago");
  assert.equal(activityLine(idle, o).text, "Waiting for the first check");
});

test("the next check is an estimate in the person's time zone", () => {
  assert.equal(nextCheckLine({ ...idle, nextCheckAt: "2026-11-05T12:20:00.000Z" }, NOW, "UTC", "en-GB"), "Next check about 12:20");
  assert.equal(nextCheckLine({ ...idle, nextCheckAt: "2026-11-05T11:00:00.000Z" }, NOW, "UTC", "en-GB"), "Next check: any moment");
  assert.equal(nextCheckLine(idle, NOW, "UTC", "en-GB"), null);
});

test("a pause for a while says when it ends", () => {
  assert.equal(pausedUntilLine("2026-11-12T10:00:00.000Z", "UTC", "en-GB"), "Resumes Thu 12 Nov");
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
  assert.equal(freshDaysChoices(365).find((c) => c.value === 365)!.label, "365 days");
});

test("Home does not say it is up to date while older items nobody has looked at are waiting", () => {
  const facts = { visited: true, items: 120, showCounts: true };
  assert.equal(calmLine({ unread: 54 }, facts), "Nothing new since your last visit · 54 older items not looked at");
  assert.equal(calmLine({ unread: 1 }, facts), "Nothing new since your last visit · 1 older item not looked at");
  assert.equal(calmLine({ unread: 54 }, { ...facts, showCounts: false }), "Nothing new since your last visit");
  assert.equal(calmLine({ unread: 54 }, { ...facts, visited: false }), "Nothing is marked New · 54 older items not looked at", "a first visit has no earlier visit to be new since");
  assert.equal(calmLine({ unread: 0 }, facts), "You're up to date");
  assert.equal(calmLine({ unread: 0 }, { ...facts, items: 0 }), "Nothing has arrived yet");
});
