import assert from "node:assert/strict";
import { test } from "node:test";
import { goUpOneLevel } from "./back-button.ts";

function press(closed: boolean, canGoBack: boolean) {
  const calls: string[] = [];
  const result = goUpOneLevel({
    escape: () => { calls.push("escape"); return closed; },
    canGoBack,
    previousPage: () => calls.push("previous page"),
    leave: () => calls.push("leave"),
  });
  return { result, calls };
}

test("back closes what is open before it changes page", () => {
  assert.deepEqual(press(true, true), { result: "closed", calls: ["escape"] });
  assert.deepEqual(press(true, false), { result: "closed", calls: ["escape"] });
});

test("with nothing open, back goes to the previous page", () => {
  assert.deepEqual(press(false, true), { result: "page", calls: ["escape", "previous page"] });
});

test("on the first page with nothing open, the app goes to the background", () => {
  assert.deepEqual(press(false, false), { result: "left", calls: ["escape", "leave"] });
});
