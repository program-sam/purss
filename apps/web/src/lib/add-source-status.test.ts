import assert from "node:assert/strict";
import { test } from "node:test";
import { addSourceStatus } from "./add-source-status.ts";

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
