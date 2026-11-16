import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_STATE } from "./backend.ts";
import type { BackendState } from "./backend.ts";
import { PlaybackTally } from "./tally.ts";

const at = (position: number, over: Partial<BackendState> = {}): BackendState => ({ ...IDLE_STATE, position, duration: 600, playing: true, ...over });

test("playing counts the clock while the playhead keeps up with it, at any speed", () => {
  const t = new PlaybackTally();
  for (let s = 0; s <= 10; s++) t.report(at(s), s * 1000, 1);
  assert.equal(t.played, 10);
  const fast = new PlaybackTally();
  for (let s = 0; s <= 10; s++) fast.report(at(s * 2), s * 1000, 2);
  assert.equal(fast.played, 10, "ten seconds of the clock at double speed, twenty of the recording");
  const sparse = new PlaybackTally();
  sparse.report(at(0), 0, 1);
  sparse.report(at(60), 60_000, 1);
  assert.equal(sparse.played, 60, "a report a minute later still counts when the playhead moved a minute");
});

test("a jump of the playhead adds nothing, forward or back, and the playing after it counts again", () => {
  const t = new PlaybackTally();
  t.report(at(0), 0, 1);
  t.report(at(1), 1000, 1);
  t.report(at(300), 1100, 1);
  t.report(at(10), 1200, 1);
  assert.equal(t.played, 1);
  t.report(at(11), 2200, 1);
  assert.equal(t.played, 2);
});

test("a pause, a stall and a page that was frozen add only what was played", () => {
  const t = new PlaybackTally();
  t.report(at(0), 0, 1);
  t.report(at(5), 5000, 1);
  t.report(at(5, { playing: false }), 5000, 1);
  t.report(at(5), 3_600_000, 1);
  assert.equal(t.played, 5, "an hour paused");
  t.report(at(5, { buffering: true }), 3_601_000, 1);
  t.report(at(5), 3_700_000, 1);
  assert.equal(t.played, 5, "waiting for data, then reported playing again with the playhead where it was");
  t.report(at(6), 3_701_000, 1);
  t.report(at(7), 3_760_000, 1);
  assert.equal(t.played, 7, "a minute gap with a one second move is one second played");
});

test("time in the end of the item counts apart, and only when it is played", () => {
  const t = new PlaybackTally();
  t.report(at(478), 0, 1);
  t.report(at(479), 1000, 1);
  t.report(at(480), 2000, 1);
  t.report(at(481), 3000, 1);
  assert.equal(t.playedInFinish, 1, "ten minutes: the end starts at 8:00; the second that crosses it counts from there");
  assert.equal(t.playedToTheEnd({ ended: false }), false);
  t.report(at(483), 5000, 1);
  assert.equal(t.playedInFinish, 3);
  assert.equal(t.playedToTheEnd({ ended: false }), true);

  const seeked = new PlaybackTally();
  seeked.report(at(100), 0, 1);
  seeked.report(at(599), 100, 1);
  seeked.report(at(600, { playing: false, ended: true }), 100, 1);
  assert.equal(seeked.playedInFinish, 0);
  assert.equal(seeked.playedToTheEnd({ ended: true }), false, "the end of the file reached by a seek, even one that lands a second from it");

  const ran = new PlaybackTally();
  ran.report(at(598), 0, 1);
  ran.report(at(599), 1000, 1);
  ran.report(at(600, { playing: false, ended: true }), 2000, 1);
  assert.equal(ran.playedToTheEnd({ ended: true }), true, "played into the end of the file");
});

test("with no known length there is no last stretch, but playing into the end of the file still finishes; a jump to the end doesn't", () => {
  const t = new PlaybackTally();
  for (let s = 0; s <= 100; s++) t.report(at(s, { duration: null }), s * 1000, 1);
  assert.equal(t.played, 100);
  assert.equal(t.playedInFinish, 0);
  assert.equal(t.playedToTheEnd({ ended: false }), false, "still playing: nothing says how far it is");
  t.report(at(101, { duration: null, playing: false, ended: true }), 101_000, 1);
  assert.equal(t.playedToTheEnd({ ended: true }), true, "it played into the end");
  const jump = new PlaybackTally();
  for (let s = 0; s <= 40; s++) jump.report(at(s, { duration: null }), s * 1000, 1);
  jump.report(at(3000, { duration: null, playing: false, ended: true }), 41_000, 1);
  assert.equal(jump.playedToTheEnd({ ended: true }), false, "a seek to the end played none of it");
});
