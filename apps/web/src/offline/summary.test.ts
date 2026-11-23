import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { plural } from "../lib/format.ts";
import { savedSummary } from "./summary.ts";

const t = app.offline.summary;
const now = Date.parse("2026-11-04T12:00:00.000Z");

test("the saved line says how many items, and when they were last saved", () => {
  assert.equal(savedSummary(0, null, false, now), t.nothing);
  assert.equal(savedSummary(0, null, true, now), t.saving);
  assert.equal(savedSummary(1, "2026-11-04T11:55:00.000Z", false, now, "en-GB"), t.updated(t.saved(plural(1, app.words.item)), "5 min ago"));
  assert.equal(savedSummary(48, "2026-11-04T11:59:40.000Z", false, now, "en-GB"), t.updated(t.saved(plural(48, app.words.item)), "now"));
  assert.equal(savedSummary(48, "2026-11-04T09:00:00.000Z", true, now), t.updating(t.saved(plural(48, app.words.item))));
  assert.equal(savedSummary(3, null, false, now), t.done(t.saved(plural(3, app.words.item))));
});
