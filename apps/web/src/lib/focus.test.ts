import test from "node:test";
import assert from "node:assert/strict";
import { focusLost, survivorIndex, typing } from "./focus.ts";

const body = {};
const html = {};
const doc = (activeElement: unknown) => ({ activeElement, body, documentElement: html });

test("focus is lost on the page body, on nothing, and on a control that was removed or disabled", () => {
  assert.equal(focusLost(doc(body)), true);
  assert.equal(focusLost(doc(html)), true);
  assert.equal(focusLost(doc(null)), true);
  assert.equal(focusLost(doc({ isConnected: false })), true);
  assert.equal(focusLost(doc({ isConnected: true, disabled: true })), true, "a button disabled while its work runs");
});

test("focus is not lost on a control that is still there and usable", () => {
  assert.equal(focusLost(doc({ isConnected: true })), false);
  assert.equal(focusLost(doc({ isConnected: true, disabled: false })), false);
});

test("the row after the one that leaves takes focus, else the row before it", () => {
  assert.equal(survivorIndex([false, true, false], 1), 2);
  assert.equal(survivorIndex([false, false, true], 2), 1, "the last row has none after it");
  assert.equal(survivorIndex([true], 0), null, "the only row: nothing is left to take focus");
});

test("rows that leave together are skipped, wherever they are", () => {
  assert.equal(survivorIndex([false, true, true, false], 1), 3);
  assert.equal(survivorIndex([false, true, true, true], 3), 0, "all the rows below go too");
  assert.equal(survivorIndex([true, true, true], 1), null, "every row goes: the list's heading takes focus");
});

test("a row that was not found asks for the first row that stays", () => {
  assert.equal(survivorIndex([true, false], -1), 1);
});

test("typing: a text field, a text area, a select or editable text is being typed in; buttons, choices and a disabled field are not", () => {
  const at = (el: Record<string, unknown> | null) => typing({ activeElement: el });
  assert.equal(at({ tagName: "INPUT", type: "text" }), true);
  assert.equal(at({ tagName: "input" }), true, "an input without a type is a text field");
  assert.equal(at({ tagName: "TEXTAREA" }), true);
  assert.equal(at({ tagName: "SELECT" }), true);
  assert.equal(at({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(at({ tagName: "INPUT", type: "submit" }), false);
  assert.equal(at({ tagName: "INPUT", type: "radio" }), false);
  assert.equal(at({ tagName: "BUTTON" }), false);
  assert.equal(at({ tagName: "INPUT", type: "text", disabled: true }), false);
  assert.equal(at(null), false);
});
