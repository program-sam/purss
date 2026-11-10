import test from "node:test";
import assert from "node:assert/strict";
import { usageWeek } from "./ai-filters.ts";

test("usage is counted per ISO week, Monday to Sunday in UTC, with the year of the week's Thursday", () => {
  assert.equal(usageWeek(new Date("2026-11-09T00:00:00Z")), "2026-W46", "a Monday starts the week");
  assert.equal(usageWeek(new Date("2026-11-15T23:59:59Z")), "2026-W46", "Sunday night still belongs to it");
  assert.equal(usageWeek(new Date("2026-11-16T00:00:00Z")), "2026-W47");
  assert.equal(usageWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53", "early January can belong to the old year's last week");
  assert.equal(usageWeek(new Date("2024-12-30T08:00:00Z")), "2025-W01", "late December can belong to the new year's first week");
  assert.equal(usageWeek(new Date("2026-01-01T00:00:00Z")), "2026-W01");
});
