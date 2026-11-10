import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeTestApp } from "../testing.ts";
import { getPreferences, preferencesPatchSchema, setPreferences } from "./preferences.ts";

test("time zone: unset for a new account until a browser reports one", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  assert.equal(getPreferences(app, p.workspaceId).timezone, null);
  // Saving another preference first must not pin the zone to a default.
  setPreferences(app, p.workspaceId, { density: "compact" });
  assert.equal(getPreferences(app, p.workspaceId).timezone, null);
  setPreferences(app, p.workspaceId, { timezone: "Europe/Brussels" });
  assert.equal(getPreferences(app, p.workspaceId).timezone, "Europe/Brussels");
});

test("time zone: an exported unset zone imports cleanly; unknown zones are refused", () => {
  assert.equal(preferencesPatchSchema.safeParse({ timezone: null, density: "compact" }).success, true);
  assert.equal(preferencesPatchSchema.safeParse({ timezone: "Mars/Olympus" }).success, false);
});
