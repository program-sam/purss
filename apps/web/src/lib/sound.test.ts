import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOUND_SETTINGS, parseSoundSettings } from "./sound.ts";

test("sound settings default to off, with a quiet volume once switched on, and survive bad storage", () => {
  assert.deepEqual(parseSoundSettings(null), DEFAULT_SOUND_SETTINGS);
  assert.equal(DEFAULT_SOUND_SETTINGS.enabled, false);
  assert.ok(DEFAULT_SOUND_SETTINGS.volume < 0.6);
  assert.deepEqual(parseSoundSettings("{not json"), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(parseSoundSettings(JSON.stringify({ enabled: false, volume: 3, material: "mech" })), { enabled: false, volume: 1, material: "mech" });
  assert.deepEqual(parseSoundSettings(JSON.stringify({ volume: -1, material: "kazoo" })), { enabled: false, volume: 0, material: "default" });
});
