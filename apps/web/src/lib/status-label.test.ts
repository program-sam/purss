import test from "node:test";
import assert from "node:assert/strict";
import { statusButton } from "./status-label.ts";

test("the status button invites a choice while nothing is set, and names the state otherwise", () => {
  assert.deepEqual(statusButton("new", "article"), { text: "Set status", aria: "Set status", keyed: false });
  assert.deepEqual(statusButton("toread", "article"), { text: "To read", aria: "State: To read. Change state", keyed: true });
  assert.equal(statusButton("toread", "video").text, "To watch");
  assert.equal(statusButton("toread", "podcast").text, "To listen");
  assert.equal(statusButton("finished").text, "Finished");
});
