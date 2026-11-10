import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeFingerprint, readNativeLevel } from "./native-level.ts";

test("the native level was considered for the native code as it is", () => {
  const recorded = readNativeLevel();
  const now = nativeFingerprint();
  assert.equal(recorded.fingerprint, now,
    `The app's native side changed (android/, ios/, plugins, patches/ or capacitor.config.ts). In apps/mobile/native-level.json, set "fingerprint" to "${now}", `
    + "and raise \"level\" if the interface now depends on the change: live updates built at the new level then reach only apps built with it (plan/39).");
  assert.ok(Number.isSafeInteger(recorded.level) && recorded.level >= 1);
});
