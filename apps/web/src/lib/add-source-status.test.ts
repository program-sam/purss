import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "@purss/copy/app";
import { addSourceStatus, focusTargets } from "./add-source-status.ts";
import { plural } from "./format.ts";

const t = app.lib.addSourceStatus;

const base = { phase: "paste" as const, searching: false, shows: 0, candidates: 0, failure: null, keeping: false };

test("Add source announces one short line for each step, never the form", () => {
  assert.equal(addSourceStatus({ ...base, phase: "paste" }), "");
  assert.equal(addSourceStatus({ ...base, phase: "single" }), "");
  assert.equal(addSourceStatus({ ...base, phase: "looking" }), app.words.looking);
  assert.equal(addSourceStatus({ ...base, phase: "shows", searching: true }), t.searching);
  assert.equal(addSourceStatus({ ...base, phase: "shows", shows: 3 }), t.showsFound(plural(3, app.lib.nouns.show)));
  assert.equal(addSourceStatus({ ...base, phase: "shows", shows: 1 }), t.showsFound(plural(1, app.lib.nouns.show)));
  assert.equal(addSourceStatus({ ...base, phase: "shows" }), t.noShows);
  assert.equal(addSourceStatus({ ...base, phase: "found", candidates: 1 }), t.oneFeed);
  assert.equal(addSourceStatus({ ...base, phase: "found", candidates: 4 }), t.feeds(4));
  assert.equal(addSourceStatus({ ...base, phase: "found", keeping: true }), t.keepable);
  assert.equal(addSourceStatus({ ...base, phase: "failed", failure: "That website took too long" }), t.failedWith("That website took too long"));
  assert.equal(addSourceStatus({ ...base, phase: "failed" }), t.failed);
});

test("each step of Add source says where focus goes when it takes away the control that had it", () => {
  const q = { searching: false, hasError: false };
  assert.deepEqual(focusTargets("looking", q), ["#as-looking"], "a show was chosen: the list is replaced by the look-up");
  assert.deepEqual(focusTargets("found", q), [".cands input:checked", ".cands input", "#fnd"], "the feed that was found, not the page body");
  assert.deepEqual(focusTargets("failed", q), ["#as-failed"]);
  assert.deepEqual(focusTargets("shows", { ...q, searching: true }), ["#as-searching", "#as-url"]);
  assert.deepEqual(focusTargets("shows", q), ["#as-shows .cand", "#as-url"]);
  assert.deepEqual(focusTargets("single", q), ["#kl-b", "#kl-t"]);
  assert.equal(focusTargets("paste", q)[0], "#as-url");
});

test("a message about what went wrong is where focus goes first", () => {
  for (const phase of ["paste", "shows", "found", "failed", "single"] as const) assert.equal(focusTargets(phase, { searching: false, hasError: true })[0], "#as-error", phase);
  assert.notEqual(focusTargets("looking", { searching: false, hasError: true })[0], "#as-error", "while it looks, the look-up itself holds focus");
});
