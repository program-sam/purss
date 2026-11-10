import { test } from "node:test";
import assert from "node:assert/strict";
import { inQuietHours } from "./quiet-hours.ts";

const at = (iso: string) => new Date(iso);

test("a same-day window", () => {
  assert.equal(inQuietHours(at("2026-11-03T13:00:00Z"), "12:00", "14:00", "UTC"), true);
  assert.equal(inQuietHours(at("2026-11-03T14:00:00Z"), "12:00", "14:00", "UTC"), false);
  assert.equal(inQuietHours(at("2026-11-03T11:59:00Z"), "12:00", "14:00", "UTC"), false);
});

test("a window that crosses midnight", () => {
  assert.equal(inQuietHours(at("2026-11-03T23:30:00Z"), "22:00", "07:00", "UTC"), true);
  assert.equal(inQuietHours(at("2026-11-03T03:00:00Z"), "22:00", "07:00", "UTC"), true);
  assert.equal(inQuietHours(at("2026-11-03T12:00:00Z"), "22:00", "07:00", "UTC"), false);
});

test("the window is read in the chosen time zone", () => {
  // 22:30 UTC is 07:30 the next morning in Tokyo, which is outside 22:00-07:00 there.
  assert.equal(inQuietHours(at("2026-11-03T22:30:00Z"), "22:00", "07:00", "Asia/Tokyo"), false);
  assert.equal(inQuietHours(at("2026-11-03T22:30:00Z"), "22:00", "07:00", "UTC"), true);
});

test("no window, equal ends and bad times mean never quiet", () => {
  assert.equal(inQuietHours(at("2026-11-03T12:00:00Z"), null, null, "UTC"), false);
  assert.equal(inQuietHours(at("2026-11-03T12:00:00Z"), "08:00", "08:00", "UTC"), false);
  assert.equal(inQuietHours(at("2026-11-03T12:00:00Z"), "25:00", "07:00", "UTC"), false);
});
