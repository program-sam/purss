import { test } from "node:test";
import assert from "node:assert/strict";
import { popKey } from "./popover-keys.ts";
import type { PopKeyInput } from "./popover-keys.ts";

const base: PopKeyInput = { key: "", shift: false, role: "menu", at: "control", index: 0, count: 3 };
const press = (over: Partial<PopKeyInput>) => popKey({ ...base, ...over });

test("Escape closes a menu and a panel, giving focus back", () => {
  assert.deepEqual(press({ key: "Escape" }), { do: "close" });
  assert.deepEqual(press({ key: "Escape", role: "dialog", at: "popup", index: -1 }), { do: "close" });
});

test("arrow keys step between the controls and wrap", () => {
  assert.deepEqual(press({ key: "ArrowDown", index: 0 }), { do: "focus", index: 1 });
  assert.deepEqual(press({ key: "ArrowDown", index: 2 }), { do: "focus", index: 0 });
  assert.deepEqual(press({ key: "ArrowUp", index: 0 }), { do: "focus", index: 2 });
  assert.deepEqual(press({ key: "ArrowUp", role: "dialog", index: 2 }), { do: "focus", index: 1 });
});

test("arrow keys from the popup itself or from its opener enter at the near end", () => {
  assert.deepEqual(press({ key: "ArrowDown", at: "popup", index: -1 }), { do: "focus", index: 0 });
  assert.deepEqual(press({ key: "ArrowUp", at: "outside", index: -1 }), { do: "focus", index: 2 });
  assert.deepEqual(press({ key: "ArrowDown", count: 0, index: -1 }), { do: "none" });
});

test("Home and End jump in a menu only", () => {
  assert.deepEqual(press({ key: "End", index: 0 }), { do: "focus", index: 2 });
  assert.deepEqual(press({ key: "Home", index: 2 }), { do: "focus", index: 0 });
  assert.deepEqual(press({ key: "Home", role: "dialog", index: 2 }), { do: "none" });
});

test("Tab leaves a menu from any item, either way", () => {
  assert.deepEqual(press({ key: "Tab", index: 1 }), { do: "leave" });
  assert.deepEqual(press({ key: "Tab", shift: true, index: 1 }), { do: "leave" });
});

test("Tab walks through a panel and leaves it past either end", () => {
  const panel = { role: "dialog" as const, key: "Tab" };
  assert.deepEqual(press({ ...panel, index: 0 }), { do: "none" });
  assert.deepEqual(press({ ...panel, index: 1 }), { do: "none" });
  assert.deepEqual(press({ ...panel, index: 2 }), { do: "leave" });
  assert.deepEqual(press({ ...panel, shift: true, index: 0 }), { do: "leave" });
  assert.deepEqual(press({ ...panel, shift: true, index: 2 }), { do: "none" });
  // Focus on the panel itself: Tab goes to the first control, Shift+Tab leaves.
  assert.deepEqual(press({ ...panel, at: "popup", index: -1 }), { do: "none" });
  assert.deepEqual(press({ ...panel, shift: true, at: "popup", index: -1 }), { do: "leave" });
  assert.deepEqual(press({ ...panel, at: "popup", index: -1, count: 0 }), { do: "leave" });
});

test("Tab from the opener of a panel goes into it; Shift+Tab goes back past the opener", () => {
  assert.deepEqual(press({ key: "Tab", role: "dialog", at: "outside", index: -1 }), { do: "focus", index: 0 });
  assert.deepEqual(press({ key: "Tab", role: "dialog", shift: true, at: "outside", index: -1 }), { do: "leave" });
});

test("other keys are left alone", () => {
  assert.deepEqual(press({ key: "a" }), { do: "none" });
  assert.deepEqual(press({ key: "Enter" }), { do: "none" });
});
