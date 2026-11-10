import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesLabel, clock, dateFormat, dateTime, dayKey, dayLabel, formatCount, groupByDay, interfaceLocale, plural, shortDate, timeAgo } from "./format.ts";

const NOW = Date.parse("2026-11-03T09:00:00Z");

test("timeAgo steps from minutes to dates", () => {
  assert.equal(timeAgo("2026-11-03T08:59:30Z", NOW, "UTC", "en-GB"), "now");
  assert.equal(timeAgo("2026-11-03T08:40:00Z", NOW, "UTC", "en-GB"), "20 min ago");
  assert.equal(timeAgo("2026-11-03T04:00:00Z", NOW, "UTC", "en-GB"), "5 hr ago");
  assert.equal(timeAgo("2026-11-02T04:00:00Z", NOW, "UTC", "en-GB"), "yesterday");
  assert.equal(timeAgo("2026-10-30T09:00:00Z", NOW, "UTC", "en-GB"), "4 days ago");
  assert.match(timeAgo("2026-09-23T09:00:00Z", NOW, "UTC", "en-GB"), /^23 Sept?/);
  assert.equal(timeAgo(null, NOW), "");
  assert.equal(timeAgo("not a date", NOW), "");
});

test("yesterday means the calendar day before today, not 24 to 48 hours ago", () => {
  // Monday 08:00; it is now Wednesday 07:00: 47 hours, but two calendar days.
  const wed = Date.parse("2026-11-04T07:00:00Z");
  assert.equal(timeAgo("2026-11-02T08:00:00Z", wed, "UTC", "en-GB"), "2 days ago");
  assert.equal(timeAgo("2026-11-03T23:00:00Z", wed, "UTC", "en-GB"), "8 hr ago");
  assert.equal(timeAgo("2026-11-03T12:00:00Z", wed, "UTC", "en-GB"), "yesterday");
  // The same instants fall on different calendar days in another zone.
  const then = "2026-11-03T20:00:00Z"; // 4 Nov 05:00 in Tokyo
  const later = Date.parse("2026-11-05T09:00:00Z"); // 5 Nov 09:00 UTC, 5 Nov 18:00 in Tokyo
  assert.equal(timeAgo(then, later, "UTC", "en-GB"), "2 days ago");
  assert.equal(timeAgo(then, later, "Asia/Tokyo", "en-GB"), "yesterday");
});

test("relative dates and exact times use the language they are given and the PURSS zone", () => {
  assert.equal(timeAgo("2026-11-02T04:00:00Z", NOW, "UTC", "de"), "gestern");
  assert.equal(timeAgo("2026-10-30T09:00:00Z", NOW, "UTC", "de"), "vor 4 Tagen");
  assert.equal(timeAgo("2026-10-30T09:00:00Z", NOW, "UTC", "nl"), "4 dgn geleden");
  assert.equal(dateTime("2026-11-03T09:05:00Z", "UTC", "en-GB"), "3 Nov 2026, 09:05");
  assert.equal(dateTime("2026-11-03T09:05:00Z", "Asia/Tokyo", "en-GB"), "3 Nov 2026, 18:05");
  assert.equal(dateTime("2026-11-03T09:05:00Z", "UTC", "de"), "03.11.2026, 09:05");
  assert.equal(dateTime(null), "");
  assert.equal(shortDate("2026-10-12T00:00:00Z", NOW, "UTC", "de"), "12. Okt.");
  assert.equal(dayLabel("2026-11-02T23:30:00Z", NOW, "UTC", "de"), "Gestern");
});

test("day labels follow the chosen time zone, not the machine's", () => {
  // 23:30 UTC on 2 Nov is already 3 Nov in Tokyo.
  assert.equal(dayKey("2026-11-02T23:30:00Z", "UTC"), "2026-11-02");
  assert.equal(dayKey("2026-11-02T23:30:00Z", "Asia/Tokyo"), "2026-11-03");
  assert.equal(dayLabel("2026-11-03T05:00:00Z", NOW, "UTC", "en-GB"), "Today");
  assert.equal(dayLabel("2026-11-02T23:30:00Z", NOW, "UTC", "en-GB"), "Yesterday");
  assert.equal(dayLabel("2026-11-02T23:30:00Z", NOW, "Asia/Tokyo", "en-GB"), "Today");
  assert.equal(dayLabel("2026-10-28T10:00:00Z", NOW, "UTC", "en-GB"), "Wednesday 28 October");
});

test("groupByDay groups consecutive days and keeps order", () => {
  const items = [
    { id: "a", at: "2026-11-03T07:00:00Z" }, { id: "b", at: "2026-11-03T01:00:00Z" },
    { id: "c", at: "2026-11-02T20:00:00Z" }, { id: "d", at: "2026-10-30T20:00:00Z" },
  ];
  const groups = groupByDay(items, (i) => i.at, NOW, "UTC", "en-GB");
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.id)]), [["Today", ["a", "b"]], ["Yesterday", ["c"]], ["Friday 30 October", ["d"]]]);
});

test("other-year dates show the year", () => {
  assert.equal(shortDate("2024-03-12T00:00:00Z", NOW, "UTC", "en-GB"), "12 Mar 2024");
});

test("clock and bytes", () => {
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3723), "1:02:03");
  assert.equal(bytesLabel(500), "500 B");
  assert.equal(bytesLabel(1536), "1.5 KB");
  assert.equal(bytesLabel(1_800_000_000), "1.68 GB");
});

test("counts carry the language's thousands separator, in plain counts and plurals", () => {
  assert.equal(formatCount(21413, "en-GB"), "21,413");
  assert.equal(formatCount(21413, "nl-NL"), "21.413");
  assert.equal(formatCount(7, "en-GB"), "7");
  assert.equal(plural(11571, "item", undefined, "en-GB"), "11,571 items");
  assert.equal(plural(1, "item", undefined, "en-GB"), "1 item");
});

/** Run `fn` with the browser's language set to `language`. */
function withBrowserLanguage<T>(language: string, fn: () => T): T {
  Object.defineProperty(globalThis.navigator, "language", { value: language, configurable: true });
  try { return fn(); } finally { delete (globalThis.navigator as unknown as { language?: string }).language; }
}

test("the words of dates follow the interface language, not a Dutch or Arabic browser's", () => {
  for (const language of ["nl-NL", "ar-EG", "de"]) {
    withBrowserLanguage(language, () => {
      assert.equal(interfaceLocale(), "en-GB");
      assert.equal(timeAgo("2026-11-03T08:59:30Z", NOW, "UTC"), "now");
      assert.equal(timeAgo("2026-10-30T09:00:00Z", NOW, "UTC"), "4 days ago");
      assert.equal(timeAgo("2026-11-03T08:40:00Z", NOW, "UTC"), "20 min ago");
      assert.equal(dayLabel("2026-11-02T23:30:00Z", NOW, "UTC"), "Yesterday");
      assert.equal(shortDate("2026-10-12T00:00:00Z", NOW, "UTC"), "12 Oct");
    });
  }
});

test("an English browser keeps its own style of dates", () => {
  withBrowserLanguage("en-US", () => {
    assert.equal(interfaceLocale(), "en-US");
    assert.equal(shortDate("2026-10-12T00:00:00Z", NOW, "UTC"), "Oct 12");
  });
});

test("formatters are built once per language and options, and keep answering per time zone", () => {
  assert.equal(dateFormat("en-GB", { year: "numeric", timeZone: "UTC" }), dateFormat("en-GB", { year: "numeric", timeZone: "UTC" }));
  assert.notEqual(dateFormat("en-GB", { year: "numeric", timeZone: "UTC" }), dateFormat("en-GB", { year: "numeric", timeZone: "Asia/Tokyo" }));
  // Late on 31 December in UTC is already the next day in Tokyo: each zone keeps its own answer.
  assert.equal(dayKey("2026-12-31T20:00:00Z", "UTC"), "2026-12-31");
  assert.equal(dayKey("2026-12-31T20:00:00Z", "Asia/Tokyo"), "2027-01-01");
  assert.equal(timeAgo("2026-11-03T08:40:00Z", NOW, "UTC", "nl-NL"), "20 min. geleden");
  assert.equal(timeAgo("2026-11-03T08:40:00Z", NOW, "UTC", "en-GB"), "20 min ago");
});

test("an unknown time zone still fails, every time", () => {
  assert.throws(() => dayKey("2026-11-03T08:00:00Z", "Mars/Olympus"), RangeError);
  assert.throws(() => dayKey("2026-11-03T08:00:00Z", "Mars/Olympus"), RangeError);
});
