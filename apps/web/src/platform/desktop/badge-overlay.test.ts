import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { badgeLabel, overlaySize, wantsOverlay } from "./badge-overlay.ts";

test("the overlay says the count up to 99, then 99+", () => {
  assert.equal(badgeLabel(1), "1");
  assert.equal(badgeLabel(99), "99");
  assert.equal(badgeLabel(100), "99+");
});

test("the overlay's pixels follow the screen's scale within what the app accepts (16 to 64)", () => {
  assert.equal(overlaySize(1), 16);
  assert.equal(overlaySize(1.25), 20);
  assert.equal(overlaySize(2), 32);
  assert.equal(overlaySize(8), 64);
  assert.equal(overlaySize(0), 16);
});

test("only Windows' web view draws the overlay", () => {
  assert.ok(wantsOverlay("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"));
  assert.ok(!wantsOverlay("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)"));
  assert.ok(!wantsOverlay("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"));
});
