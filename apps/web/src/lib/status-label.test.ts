import test from "node:test";
import assert from "node:assert/strict";
import { statusButton } from "./status-label.ts";

test("the status button steps an item along the reading path, and names the state at its end", () => {
  assert.deepEqual(statusButton("new", "article"), { text: "Mark as to read", aria: "Mark as To read", keyed: false, next: "toread", menuAria: "State: Undecided. Change state" });
  assert.deepEqual(statusButton("toread", "article"), { text: "Mark as in progress", aria: "Mark as In progress", keyed: false, next: "inprogress", menuAria: "State: To read. Change state" });
  assert.equal(statusButton("inprogress").next, "finished");
  assert.equal(statusButton("inprogress").text, "Mark as finished");
  assert.equal(statusButton("new", "video").text, "Mark as to watch");
  assert.equal(statusButton("toread", "podcast").menuAria, "State: To listen. Change state");
  assert.deepEqual(statusButton("finished"), { text: "Finished", aria: "State: Finished. Change state", keyed: true, menuAria: "State: Finished. Change state" });
  assert.equal(statusButton("ignored").next, undefined);
});
