import { test } from "node:test";
import assert from "node:assert/strict";
import { stateChangeSchema } from "./api.ts";

const playback = { workflow: "inprogress", expectedRevision: 3, expectedWorkflowRevision: 2, playbackSessionId: "play-1", playbackStartedWorkflowRevision: 2 };

test("a change made by hand needs only the revision it was made against", () => {
  assert.equal(stateChangeSchema.safeParse({ workflow: "toread", expectedRevision: 3 }).success, true);
  assert.equal(stateChangeSchema.safeParse({ progress: 0.5, opened: true, expectedRevision: 0 }).success, true);
});

test("the player's own change carries its three playback fields together, moves only to In progress or Finished, and moves nothing else", () => {
  assert.equal(stateChangeSchema.safeParse(playback).success, true);
  assert.equal(stateChangeSchema.safeParse({ ...playback, workflow: "finished" }).success, true);
  for (const field of ["expectedWorkflowRevision", "playbackSessionId", "playbackStartedWorkflowRevision"] as const) {
    const { [field]: _left, ...rest } = playback;
    assert.equal(stateChangeSchema.safeParse(rest).success, false, `without ${field}`);
  }
  for (const workflow of ["undecided", "toread", "ignored"]) assert.equal(stateChangeSchema.safeParse({ ...playback, workflow }).success, false, workflow);
  assert.equal(stateChangeSchema.safeParse({ ...playback, workflow: undefined }).success, false, "no workflow");
  assert.equal(stateChangeSchema.safeParse({ ...playback, progress: 0.5 }).success, false, "reading progress is not the player's to set");
  assert.equal(stateChangeSchema.safeParse({ ...playback, opened: true }).success, false);
  assert.equal(stateChangeSchema.safeParse({ ...playback, fresh: false }).success, false);
  assert.equal(stateChangeSchema.safeParse({ ...playback, playbackSessionId: "" }).success, false);
  assert.equal(stateChangeSchema.safeParse({ ...playback, expectedWorkflowRevision: -1 }).success, false);
});
