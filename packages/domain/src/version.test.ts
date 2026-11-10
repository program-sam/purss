import assert from "node:assert/strict";
import { test } from "node:test";
import { dottedVersion, parseVersion, plainVersion, versionDay, versionOf } from "./version.ts";

test("year, day of the year and that day's commit, at fixed width", () => {
  assert.equal(versionOf(new Date("2026-11-08T10:00:00Z"), 14), "2631214");
  assert.equal(versionOf(new Date("2026-01-01T00:00:00Z"), 1), "2600101");
  assert.equal(versionOf(new Date("2028-12-31T23:59:59Z"), 3), "2836603", "a leap year has 366 days");
  assert.equal(versionOf(new Date("2026-11-08T23:30:00+00:00"), 2), "2631202");
  assert.equal(versionOf(new Date("2026-11-09T00:30:00+01:00"), 2), "2631202", "the day is UTC's");
});

test("versions only grow, also where the unpadded date would not (Nov 8 #14, then Nov 10 #1)", () => {
  const a = versionOf(new Date("2026-11-08T12:00:00Z"), 14);
  const b = versionOf(new Date("2026-11-10T08:00:00Z"), 1);
  const c = versionOf(new Date("2027-01-01T08:00:00Z"), 1);
  assert.ok(Number(a) < Number(b) && Number(b) < Number(c));
  assert.notEqual(versionOf(new Date("2026-01-18T12:00:00Z"), 14), a);
});

test("a day has room for 99 commits; later ones share 99", () => {
  assert.equal(versionOf(new Date("2026-11-08T12:00:00Z"), 120), "2631299");
});

test("reading a version back: its day, and the dotted form for the stores", () => {
  assert.deepEqual(parseVersion("2631214"), { year: 2026, day: 312, nth: 14 });
  assert.equal(versionDay("2631214")?.toISOString(), "2026-11-08T00:00:00.000Z");
  assert.equal(dottedVersion("2631214"), "26.312.14");
  assert.equal(dottedVersion("2600101"), "26.1.1");
  assert.equal(parseVersion("26312"), null);
  assert.equal(parseVersion("2600014"), null, "there is no day 0");
});

test("a store's spelling reads back as the plain version", () => {
  assert.equal(plainVersion("26.312.14"), "2631214");
  assert.equal(plainVersion("26.1.1"), "2600101");
  assert.equal(plainVersion("2631214"), "2631214");
  assert.equal(plainVersion("1.0"), null);
  assert.equal(plainVersion("0.1.0"), null);
});
