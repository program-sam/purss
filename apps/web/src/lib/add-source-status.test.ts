import assert from "node:assert/strict";
import { test } from "node:test";
import { addSourceStatus, focusTargets } from "./add-source-status.ts";

const base = { phase: "paste" as const, searching: false, shows: 0, candidates: 0, failure: null, keeping: false };

test("Add source announces one short line for each step, never the form", () => {
  assert.equal(addSourceStatus({ ...base, phase: "paste" }), "");
  assert.equal(addSourceStatus({ ...base, phase: "single" }), "");
  assert.equal(addSourceStatus({ ...base, phase: "looking" }), "Looking…");
  assert.equal(addSourceStatus({ ...base, phase: "shows", searching: true }), "Searching for shows…");
  assert.equal(addSourceStatus({ ...base, phase: "shows", shows: 3 }), "3 shows found.");
  assert.equal(addSourceStatus({ ...base, phase: "shows", shows: 1 }), "1 show found.");
  assert.equal(addSourceStatus({ ...base, phase: "shows" }), "No shows found.");
  assert.equal(addSourceStatus({ ...base, phase: "found", candidates: 1 }), "Found 1 feed to follow.");
  assert.equal(addSourceStatus({ ...base, phase: "found", candidates: 4 }), "Found 4 feeds. Choose one to follow.");
  assert.equal(addSourceStatus({ ...base, phase: "found", keeping: true }), "Found a page you can keep.");
  assert.equal(addSourceStatus({ ...base, phase: "failed", failure: "That website took too long" }), "Couldn't follow that: That website took too long");
  assert.equal(addSourceStatus({ ...base, phase: "failed" }), "Couldn't follow that.");
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
