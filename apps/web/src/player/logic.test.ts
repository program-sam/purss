import { test } from "node:test";
import assert from "node:assert/strict";
import { FINISHED_WITHIN_SECONDS, IN_PROGRESS_AFTER_SECONDS, SAVE_EVERY_MS, canPlaybackMove, canPlaybackStart, clock, fileSize, nextRate, playbackFinishPoint, resumePoint, seekKeyStep, shouldSave, sleepMinutesLeft } from "./logic.ts";

test("resuming starts a little before where you stopped, and from the start once finished", () => {
  assert.equal(resumePoint(null), 0);
  assert.equal(resumePoint({ positionSeconds: 3, durationSeconds: 100, updatedAt: "" }), 0);
  assert.equal(resumePoint({ positionSeconds: 60, durationSeconds: 600, updatedAt: "" }), 58);
  assert.equal(resumePoint({ positionSeconds: 600 - FINISHED_WITHIN_SECONDS + 1, durationSeconds: 600, updatedAt: "" }), 0);
  assert.equal(resumePoint({ positionSeconds: 60, durationSeconds: null, updatedAt: "" }), 58);
});

test("positions are saved on change, not on every tick", () => {
  assert.equal(shouldSave(null, 0.5, 0, false), false);
  assert.equal(shouldSave(null, 5, 0, false), true);
  assert.equal(shouldSave({ at: 0, position: 10 }, 11, SAVE_EVERY_MS * 2, true), false, "less than two seconds moved");
  assert.equal(shouldSave({ at: 0, position: 10 }, 40, 1000, false), false, "too soon while playing");
  assert.equal(shouldSave({ at: 0, position: 10 }, 40, 1000, true), true, "pause and close save straight away");
  assert.equal(shouldSave({ at: 0, position: 10 }, 40, SAVE_EVERY_MS, false), true);
});

test("the end of an item starts at 95% or two minutes from the end, whichever comes first, and never before halfway", () => {
  assert.equal(IN_PROGRESS_AFTER_SECONDS, 30);
  assert.equal(playbackFinishPoint(600), 480, "ten minutes: the last two minutes come first");
  assert.equal(playbackFinishPoint(1800), 1680);
  assert.equal(playbackFinishPoint(3600), 3420, "an hour: 95% comes first");
  assert.equal(playbackFinishPoint(7200), 6840);
  assert.equal(playbackFinishPoint(240), 120, "four minutes: exactly halfway");
  assert.equal(playbackFinishPoint(100), 50, "a clip shorter than the last two minutes is not finished at its start");
  for (const unknown of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(playbackFinishPoint(unknown), null, String(unknown));
});

test("which states the player may move", () => {
  for (const state of ["undecided", "toread"] as const) { assert.equal(canPlaybackStart(state), true, state); assert.equal(canPlaybackMove(state), true, state); }
  assert.equal(canPlaybackStart("inprogress"), false);
  assert.equal(canPlaybackMove("inprogress"), true, "it can still finish");
  for (const state of ["finished", "ignored"] as const) { assert.equal(canPlaybackStart(state), false, state); assert.equal(canPlaybackMove(state), false, state); }
});

test("labels", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(245), "4:05");
  assert.equal(clock(3729), "1:02:09");
  assert.equal(clock(null), "–:––");
  assert.equal(nextRate(1), 1.2);
  assert.equal(nextRate(2), 0.8);
  assert.equal(fileSize(45 * 1024 * 1024), "45 MB");
  assert.equal(fileSize(1.25 * 1024 ** 3), "1.3 GB");
  assert.equal(fileSize(null), "");
});

test("arrow keys move the position slider by a few seconds either way; other keys are left to the slider", () => {
  assert.equal(seekKeyStep("ArrowRight"), 5);
  assert.equal(seekKeyStep("ArrowUp"), 5);
  assert.equal(seekKeyStep("ArrowLeft"), -5);
  assert.equal(seekKeyStep("ArrowDown"), -5);
  for (const key of ["PageUp", "PageDown", "Home", "End", "a"]) assert.equal(seekKeyStep(key), 0);
});

test("the sleep timer's time left is whole minutes, rounded up", () => {
  assert.equal(sleepMinutesLeft(15 * 60_000), 15);
  assert.equal(sleepMinutesLeft(14 * 60_000 + 1), 15);
  assert.equal(sleepMinutesLeft(20_000), 1);
});
