import assert from "node:assert/strict";
import { test } from "node:test";
import { isStrictIsoDate, looksLikeDateOnly, parseAbsoluteDate, parseDate, strtotimeReadsAs } from "./page-dates.ts";

const NOW = new Date("2026-11-21T13:00:00Z");

test("reads ISO dates with and without a time", () => {
  assert.deepEqual(parseDate("2026-11-09", "en", NOW), { iso: "2026-11-09", precision: "day", kind: "absolute" });
  assert.deepEqual(parseDate("2026-11-09T10:30:00+01:00", "en", NOW), { iso: "2026-11-09T10:30", precision: "time", kind: "absolute" });
  assert.equal(parseDate("2026-13-45", "en", NOW), null);
  assert.equal(parseDate("2026-02-30", "en", NOW), null);
});

test("reads English and Dutch month names", () => {
  for (const [text, iso] of [
    ["Nov 9, 2026", "2026-11-09"],
    ["November 9th, 2026", "2026-11-09"],
    ["9 Nov 2026", "2026-11-09"],
    ["Sat, 21 Nov 2026", "2026-11-21"],
    ["Nov. 20, 2026", "2026-11-20"],
    ["9 november 2026", "2026-11-09"],
    ["20 oktober 2026", "2026-10-20"],
    ["3 mei 2026", "2026-05-03"],
    ["12 maart 2026", "2026-03-12"],
    ["9 Nov 2026, 10:30", "2026-11-09T10:30"],
    ["Nov 9, 2026 10:30pm", "2026-11-09T22:30"],
  ] as const) {
    assert.equal(parseDate(text, "en", NOW)?.iso, iso, text);
  }
});

test("numeric dates follow the page's language, and a part above 12 is the day", () => {
  assert.equal(parseDate("09/11/2026", "en-US", NOW)?.iso, "2026-09-11");
  assert.equal(parseDate("09/11/2026", "nl", NOW)?.iso, "2026-11-09");
  assert.equal(parseDate("09/11/2026", "en-GB", NOW)?.iso, "2026-11-09");
  assert.equal(parseDate("25/12/2026", "en-US", NOW)?.iso, "2026-12-25");
  assert.equal(parseDate("18-11-2026 | 10:00", "nl", NOW)?.iso, "2026-11-18T10:00");
  assert.equal(parseDate("2026/11/09", "en", NOW)?.iso, "2026-11-09");
});

test("a month and year, and a day without a year, are read for what they are", () => {
  assert.deepEqual(parseDate("November 2026", "en", NOW), { iso: "2026-11", precision: "month", kind: "absolute" });
  const noYear = parseDate("Nov 20", "en", NOW);
  assert.equal(noYear?.iso, "2026-11-20");
  assert.equal(noYear?.precision, "noYear");
  // The year closest to now: a date in early January seen in late December is next year's.
  assert.equal(parseDate("2 Jan", "en", NOW)?.iso, "2027-01-02");
  assert.equal(parseDate("30 Dec", "en", new Date("2027-01-02T00:00:00Z"))?.iso, "2026-12-30");
});

test("relative expressions count back from now", () => {
  assert.deepEqual(parseDate("3 hours ago", "en", NOW), { iso: "2026-11-21T10:00", precision: "relative", kind: "relative" });
  assert.equal(parseDate("an hour ago", "en", NOW)?.iso, "2026-11-21T12:00");
  assert.equal(parseDate("2 days ago", "en", NOW)?.iso, "2026-11-19T13:00");
  assert.equal(parseDate("10 minuten geleden", "nl", NOW)?.iso, "2026-11-21T12:50");
  assert.equal(parseDate("yesterday", "en", NOW)?.iso, "2026-11-20");
  assert.equal(parseDate("gisteren 08:15", "nl", NOW)?.iso, "2026-11-20T08:15");
  assert.equal(parseAbsoluteDate("3 hours ago", "en", NOW), null);
});

test("text with no digits is never an absolute date", () => {
  assert.equal(parseDate("Read the November issue", "en", NOW), null);
  assert.equal(parseDate("", "en", NOW), null);
  assert.equal(parseDate("   ", "en", NOW), null);
});

test("an element is a date element only when the date is nearly all it says", () => {
  assert.equal(looksLikeDateOnly("Nov 9, 2026", "en", NOW), true);
  assert.equal(looksLikeDateOnly("Posted on November 9, 2026", "en", NOW), true);
  assert.equal(looksLikeDateOnly("3 hours ago", "en", NOW), true);
  assert.equal(looksLikeDateOnly("20 november 2026", "nl", NOW), true);
  assert.equal(looksLikeDateOnly("Nov 9, 2026 · 3 comments from Maya", "en", NOW), false);
  assert.equal(looksLikeDateOnly("Release 2026 plans", "en", NOW), false);
  assert.equal(looksLikeDateOnly("x".repeat(60), "en", NOW), false);
});

// The rows below were checked against PHP 8.2's strtotime in the pinned RSS-Bridge image.
test("strtotime reads these forms as the date the page means", () => {
  for (const text of [
    "2026-11-09",
    "2026-11-21T10:00Z",
    "2026-11-21T10:00:00.123Z",
    "2026-11-21T10:00:00+0100",
    "2026-11-21 10:00",
    "9 Nov 2026",
    "9 Nov. 2026",
    "9th November 2026",
    "Nov 9, 2026",
    "November 9th, 2026",
    "Sept 9, 2026",
    "Mon, 9 Nov 2026",
    "Monday 9 November 2026",
    "9 Nov 2026, 10:30",
    "November 9, 2026, 10:30 am",
    "9 Nov 2026 10:30 pm",
    "Nov 21, 2026 10:30 UTC",
    "2026/11/09",
    "9 november 2026",
  ]) {
    assert.equal(strtotimeReadsAs(text, parseDate(text, "en-US", NOW)), true, text);
  }
  // PHP reads dashes and dots day first and slashes month first.
  for (const text of ["09-11-2026", "09.11.2026"]) {
    assert.equal(strtotimeReadsAs(text, parseDate(text, "nl", NOW)), true, text);
    assert.equal(strtotimeReadsAs(text, parseDate(text, "en-US", NOW)), false, `${text} read month first`);
  }
  // A numeric date with slashes is month first for PHP, so it only counts when the page reads it that way.
  assert.equal(strtotimeReadsAs("12/25/2026", parseDate("12/25/2026", "en-US", NOW)), true);
  assert.equal(strtotimeReadsAs("09/11/2026", parseDate("09/11/2026", "nl", NOW)), false);
  assert.equal(strtotimeReadsAs("09/11/2026", parseDate("09/11/2026", "en-US", NOW)), true);
});

test("strtotime does not read these as the date the page means", () => {
  for (const text of [
    "Tue, 21 Nov 2026 10:30:15 +0100", // 21 Nov 2026 is a Saturday: PHP moves to the next Tuesday
    "Nov 21, 2026 at 10:30 AM", // PHP refuses "at"
    "9 oktober 2026", // Dutch month names other than november, september and december
    "9 mei 2026",
    "12 maart 2026",
    "18-11-2026 | 10:00",
    " | November 20, 2026",
    "Nov.\u00a020,\u00a02026", // no-break spaces
    "2026-12-05T11:00:00+01:00[Europe/Amsterdam]",
    "Jan 5 \u00b7 3 comments",
    "Nov\n9, 2026",
  ]) {
    assert.equal(strtotimeReadsAs(text, parseDate(text, "en-US", NOW)), false, JSON.stringify(text));
  }
  assert.equal(strtotimeReadsAs("anything", null), false);
});

test("a date PHP would read only by guessing is not relied on", () => {
  for (const text of [
    "Nov 20", // no year: PHP assumes this year, wrong in January for a December date
    "November 2026", // PHP reads the first of the month
    "3 hours ago", // relative to when the feed is polled
    "yesterday",
    "Nov  9, 2026", // two spaces
  ]) {
    assert.equal(strtotimeReadsAs(text, parseDate(text, "en-US", NOW)), false, text);
  }
});

test("an attribute is trusted only when it is plain ISO", () => {
  for (const v of ["2026-11-09", "2026-11-09T10:30:00Z", "2026-11-09T10:30:00+0100", "2026-11-09 10:30", " 2026-11-09 "]) assert.equal(isStrictIsoDate(v), true, v);
  for (const v of ["2026-11-20T18:33:14 1763663594", "Nov 9, 2026", "2026-11-09T10:30:00+01:00[Europe/Amsterdam]", "2026-W47", "20261109", ""]) assert.equal(isStrictIsoDate(v), false, v);
});
