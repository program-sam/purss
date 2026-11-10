import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopFingerprint, readDesktopLevel } from "./native-level.ts";

test("the desktop level was considered for the Rust side as it is", () => {
  const recorded = readDesktopLevel();
  const now = desktopFingerprint();
  assert.equal(recorded.fingerprint, now,
    `The desktop app's native side changed (src-tauri/ or its packages). In apps/desktop/native-level.json, set "fingerprint" to "${now}", `
    + "and raise \"level\" if the interface now depends on the change: live updates built at the new level then reach only desktop apps built with it (plan/42).");
  assert.ok(Number.isSafeInteger(recorded.level) && recorded.level >= 1);
});
