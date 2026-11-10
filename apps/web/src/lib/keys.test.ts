import { test } from "node:test";
import assert from "node:assert/strict";
import { actionForKey, isUndoKey, stepIndex } from "./keys.ts";

const k = (key: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...extra });
const free = { typing: false, layerOpen: false };

test("letters map to actions", () => {
  assert.equal(actionForKey(k("j"), free), "next");
  assert.equal(actionForKey(k("k"), free), "prev");
  assert.equal(actionForKey(k("o"), free), "open");
  assert.equal(actionForKey(k("Enter"), free), "open");
  assert.equal(actionForKey(k("e"), free), "finished");
  assert.equal(actionForKey(k("r"), free), "toread");
  assert.equal(actionForKey(k("i"), free), "ignore");
  assert.equal(actionForKey(k("x"), free), "select");
  assert.equal(actionForKey(k("/"), free), "search");
  assert.equal(actionForKey(k("?"), free), "help");
  assert.equal(actionForKey(k("p"), free), "player");
  assert.equal(actionForKey(k("p"), { typing: true, layerOpen: false }), null);
  assert.equal(actionForKey(k("p", { ctrlKey: true }), free), null);
});

test("plain arrow keys are never bound", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) assert.equal(actionForKey(k(key), free), null);
});

test("nothing fires while typing or in a popup; modifiers disable letters", () => {
  assert.equal(actionForKey(k("j"), { typing: true, layerOpen: false }), null);
  assert.equal(actionForKey(k("j"), { typing: false, layerOpen: true }), null);
  assert.equal(actionForKey(k("e", { ctrlKey: true }), free), null);
  assert.equal(actionForKey(k("e", { metaKey: true }), free), null);
  assert.equal(actionForKey(k("e", { altKey: true }), free), null);
});

test("Cmd/Ctrl+K opens the palette even while typing, but not on top of another popup", () => {
  assert.equal(actionForKey(k("k", { metaKey: true }), { typing: true, layerOpen: false }), "palette");
  assert.equal(actionForKey(k("K", { ctrlKey: true }), free), "palette");
  assert.equal(actionForKey(k("k", { metaKey: true }), { typing: false, layerOpen: true }), null);
});

test("j/k stepping stays inside the list", () => {
  assert.equal(stepIndex(-1, 5, 1), 0);
  assert.equal(stepIndex(4, 5, 1), 4);
  assert.equal(stepIndex(0, 5, -1), 0);
  assert.equal(stepIndex(2, 5, 1), 3);
  assert.equal(stepIndex(0, 0, 1), -1);
});

test("Ctrl+Z or Cmd+Z presses Undo, but never inside a text field and never as redo", () => {
  assert.equal(isUndoKey(k("z", { ctrlKey: true }), false), true);
  assert.equal(isUndoKey(k("Z", { metaKey: true }), false), true);
  assert.equal(isUndoKey(k("z", { ctrlKey: true }), true), false, "the browser's own undo while typing");
  assert.equal(isUndoKey({ ...k("z", { ctrlKey: true }), shiftKey: true }, false), false, "redo");
  assert.equal(isUndoKey(k("z", { ctrlKey: true, altKey: true }), false), false);
  assert.equal(isUndoKey(k("z"), false), false);
  assert.equal(isUndoKey(k("y", { ctrlKey: true }), false), false);
});
