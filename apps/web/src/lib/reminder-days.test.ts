import test from "node:test";
import assert from "node:assert/strict";
import { addDays, dayIn, dayLabel, daysBetween } from "./reminder-days.ts";

test("a day is the calendar date the person's own zone has, not the UTC one", () => {
  const instant = new Date(Date.UTC(2026, 10, 6, 23, 30)); // 23:30 UTC on the 6th
  assert.equal(dayIn("UTC", instant), "2026-11-06");
  assert.equal(dayIn("Pacific/Auckland", instant), "2026-11-07"); // already the 7th there
  assert.equal(dayIn("America/Los_Angeles", instant), "2026-11-06");
  assert.match(dayIn("Not/AZone", instant), /^\d{4}-\d{2}-\d{2}$/, "an unusable zone falls back to the device's");
});

test("days add and count across month, year and leap days", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-11-06", "2026-11-13"), 7);
  assert.equal(daysBetween("2026-11-06", "2026-11-05"), -1);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
});

test("a day reads as today, tomorrow, or the weekday and date", () => {
  assert.equal(dayLabel("2026-11-06", "2026-11-06", "en-GB"), "Today");
  assert.equal(dayLabel("2026-11-07", "2026-11-06", "en-GB"), "Tomorrow");
  assert.match(dayLabel("2026-11-12", "2026-11-06", "en-GB"), /^Thu,? 12 Nov$/);
  assert.match(dayLabel("2027-01-02", "2026-11-06", "en-GB"), /^Sat,? 2 Jan 2027$/, "another year says so");
});
