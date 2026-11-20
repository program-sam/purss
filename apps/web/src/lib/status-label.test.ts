import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/copy/app";
import { statusButton } from "./status-label.ts";

const c = app.lib.constants;
const s = app.lib.statusLabel;

test("the status button steps an item along the reading path, and names the state at its end", () => {
  assert.deepEqual(statusButton("new", "article"), { text: s.mark(c.workflow.toread), aria: s.mark(c.workflow.toread), keyed: false, next: "toread", menuAria: s.menu(c.workflow.new) });
  assert.deepEqual(statusButton("toread", "article"), { text: s.mark(c.workflow.inprogress), aria: s.mark(c.workflow.inprogress), keyed: false, next: "inprogress", menuAria: s.menu(c.workflow.toread) });
  assert.equal(statusButton("inprogress").next, "finished");
  assert.equal(statusButton("inprogress").text, s.mark(c.workflow.finished));
  assert.equal(statusButton("new", "video").text, s.mark(app.words.toWatch));
  assert.equal(statusButton("toread", "podcast").menuAria, s.menu(app.words.toListen));
  assert.deepEqual(statusButton("finished"), { text: c.workflow.finished, aria: s.menu(c.workflow.finished), keyed: true, menuAria: s.menu(c.workflow.finished) });
  assert.equal(statusButton("ignored").next, undefined);
});
