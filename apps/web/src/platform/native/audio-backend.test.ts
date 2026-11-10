import test from "node:test";
import assert from "node:assert/strict";
import type { BackendState, PlaybackSource, PlayerBackend } from "../../player/backend.ts";
import { IDLE_STATE } from "../../player/backend.ts";
import { AppPlayerBackend, NativeAudioBackend } from "./audio-backend.ts";
import type { AudioPlugin } from "./audio-backend.ts";

/** Stands in for @mediagrid/capacitor-native-audio: records calls and lets the test fire its events. */
function fakePlugin(opts: { duration?: number } = {}) {
  const calls: string[] = [];
  const cb: { ready?: () => void; end?: () => void; status?: (r: { status: "playing" | "paused" | "stopped" }) => void } = {};
  let time = 0;
  let exists = false;
  const ok = async () => undefined;
  const plugin = {
    create: async (p: { audioSource: string; friendlyTitle: string; artistName?: string; seekBackwardTime?: number; seekForwardTime?: number }) => {
      if (exists) throw new Error("exists");
      exists = true;
      calls.push(`create ${p.audioSource} "${p.friendlyTitle}" by ${p.artistName} ±${p.seekBackwardTime}/${p.seekForwardTime}`);
      return { success: true };
    },
    initialize: async () => { calls.push("initialize"); return { success: true }; },
    changeAudioSource: async (p: { source: string }) => { calls.push(`change ${p.source}`); },
    changeMetadata: async (p: { friendlyTitle?: string }) => { calls.push(`meta "${p.friendlyTitle}"`); },
    getDuration: async () => ({ duration: opts.duration ?? 600 }),
    getCurrentTime: async () => ({ currentTime: time }),
    play: async () => { calls.push("play"); },
    pause: async () => { calls.push("pause"); },
    seek: async (p: { timeInSeconds: number }) => { calls.push(`seek ${p.timeInSeconds}`); time = p.timeInSeconds; },
    setRate: async (p: { rate: number }) => { calls.push(`rate ${p.rate}`); },
    destroy: async () => { if (!exists) throw new Error("none"); exists = false; calls.push("destroy"); },
    onAudioReady: async (_: unknown, f: () => void) => { cb.ready = f; return { callbackId: "r" }; },
    onAudioEnd: async (_: unknown, f: () => void) => { cb.end = f; return { callbackId: "e" }; },
    onPlaybackStatusChange: async (_: unknown, f: (r: { status: "playing" | "paused" | "stopped" }) => void) => { cb.status = f; return { callbackId: "s" }; },
  };
  return { plugin: plugin as unknown as AudioPlugin, calls, cb, setTime: (t: number) => { time = t; } };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const src = (url: string, over: Partial<PlaybackSource> = {}): PlaybackSource => ({ url, kind: "audio", type: "audio/mpeg", title: "Episode", artist: "Slow Radio", ...over });

test("loading creates the system player with lock-screen details, then starts where it was left at the chosen speed", async () => {
  const f = fakePlugin();
  const b = new NativeAudioBackend(f.plugin);
  b.load(src("https://cdn.example/a.mp3"), { startAt: 118.6, rate: 1.5, autoplay: true });
  assert.equal(b.state().buffering, true);
  await settle();
  assert.deepEqual(f.calls, ['create https://cdn.example/a.mp3 "Episode" by Slow Radio ±15/30', "initialize"]);
  f.cb.ready!();
  await settle();
  assert.deepEqual(f.calls.slice(2), ["seek 119", "rate 1.5", "play"]);
  assert.equal(b.state().duration, 600);
  f.cb.ready!();
  await settle();
  assert.equal(f.calls.length, 5, "ready again after a seek doesn't start over");
});

test("play state follows the system's controls, the position is read while playing and when paused from the lock screen", async () => {
  const f = fakePlugin();
  const b = new NativeAudioBackend(f.plugin);
  const states: BackendState[] = [];
  b.subscribe(() => states.push(b.state()));
  b.load(src("file:///d/a.mp3"), { startAt: 0, rate: 1, autoplay: false });
  await settle();
  f.cb.ready!();
  await settle();
  assert.ok(!f.calls.includes("play"), "no autoplay");
  f.cb.status!({ status: "playing" });
  assert.equal(b.state().playing, true);
  f.setTime(42.5);
  f.cb.status!({ status: "paused" });
  await settle();
  assert.deepEqual([b.state().playing, b.state().position], [false, 42.5]);
  f.cb.end!();
  assert.deepEqual([b.state().ended, b.state().position], [true, 600]);
  await b.play();
  assert.deepEqual([b.state().ended, b.state().position, f.calls.at(-1)], [false, 0, "play"], "play after the end starts again");
});

test("another item reuses the player; unloading removes it; a player left from before a reload is removed first", async () => {
  const f = fakePlugin();
  const b = new NativeAudioBackend(f.plugin);
  b.load(src("https://x/1.mp3"), { startAt: 0, rate: 1, autoplay: true });
  await settle();
  f.cb.ready!();
  await settle();
  b.load(src("https://x/2.mp3", { title: "Next" }), { startAt: 30, rate: 2, autoplay: true });
  await settle();
  assert.deepEqual(f.calls.slice(-2), ['meta "Next"', "change https://x/2.mp3"]);
  f.cb.ready!();
  await settle();
  assert.deepEqual(f.calls.slice(-3), ["seek 30", "rate 2", "play"]);
  b.unload();
  assert.deepEqual(b.state(), IDLE_STATE);
  b.load(src("https://x/3.mp3"), { startAt: 0, rate: 1, autoplay: false });
  await settle();
  assert.deepEqual(f.calls.slice(-3), ["destroy", 'create https://x/3.mp3 "Episode" by Slow Radio ±15/30', "initialize"], "unloading finishes before the next player is made");

  const g = fakePlugin();
  await g.plugin.create({ audioId: "purss-player", audioSource: "old", friendlyTitle: "old", useForNotification: true });
  const fresh = new NativeAudioBackend(g.plugin);
  fresh.load(src("https://x/4.mp3"), { startAt: 0, rate: 1, autoplay: false });
  await settle();
  assert.deepEqual(g.calls.slice(1), ["destroy", 'create https://x/4.mp3 "Episode" by Slow Radio ±15/30', "initialize"]);
});

test("a file that can't be created, or never gets ready, has failed", async (t) => {
  const f = fakePlugin();
  f.plugin.create = async () => { throw new Error("bad source"); };
  const b = new NativeAudioBackend(f.plugin);
  b.load(src("https://x/bad.mp3"), { startAt: 0, rate: 1, autoplay: true });
  await settle();
  assert.equal(b.state().failed, true);

  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const g = fakePlugin();
  const c = new NativeAudioBackend(g.plugin);
  c.load(src("https://x/slow.mp3"), { startAt: 0, rate: 1, autoplay: true });
  t.mock.timers.tick(31_000);
  assert.equal(c.state().failed, true);
});

class Recorder implements PlayerBackend {
  readonly supportsVideo = true;
  loaded: string | null = null;
  unloaded = 0;
  #l = new Set<() => void>();
  load(s: PlaybackSource) { this.loaded = s.url; for (const l of this.#l) l(); }
  async play() {}
  pause() {}
  seek() {}
  setRate() {}
  view() { return null; }
  state() { return { ...IDLE_STATE, position: this.loaded ? 1 : 0 }; }
  subscribe(fn: () => void) { this.#l.add(fn); return () => this.#l.delete(fn); }
  unload() { this.unloaded++; this.loaded = null; }
}

test("the apps play audio natively and video in the page", () => {
  const audio = new Recorder();
  const video = new Recorder();
  const b = new AppPlayerBackend(audio, video);
  let heard = 0;
  b.subscribe(() => heard++);
  b.load(src("https://x/a.mp3"), { startAt: 0, rate: 1, autoplay: true });
  assert.deepEqual([audio.loaded, video.loaded, heard], ["https://x/a.mp3", null, 1]);
  b.load(src("https://x/v.mp4", { kind: "video" }), { startAt: 0, rate: 1, autoplay: true });
  assert.deepEqual([audio.unloaded, video.loaded, heard], [1, "https://x/v.mp4", 2], "switching stops the other one");
  b.unload();
  assert.equal(video.unloaded, 1);
});

test("with the system player: a position reached offline and paused from the lock screen is kept, then sent when the connection is back", async () => {
  const { Player } = await import("../../player/player.ts");
  const { lateStore, worthRetrying } = await import("../../lib/late-writes.ts");
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  const f = fakePlugin({ duration: 300 });
  let online = true;
  const sent: { position: number; recordedAt?: string }[] = [];
  const player = new Player({
    backend: new NativeAudioBackend(f.plugin), worthRetrying,
    deviceCopy: async () => "file:///d/a.mp3",
    now: () => Date.parse("2026-11-06T10:05:00.000Z"),
    savePosition: async (_id, position, _d, o) => {
      if (!online) throw Object.assign(new Error("offline"), { status: 0, code: "offline" });
      sent.push({ position, ...(o.recordedAt ? { recordedAt: o.recordedAt } : {}) });
    },
  });
  player.setPendingStore(lateStore("playback", "acc_1", storage));
  const media = { url: "https://cdn.example.org/a.mp3", kind: "audio" as const, type: "audio/mpeg", length: null };
  await player.open({ id: "itm_1", title: "Episode", sourceTitle: "Slow Radio", imageUrl: null, media, playback: { positionSeconds: 221, durationSeconds: 300, updatedAt: "2026-11-06T10:00:00.000Z" } });
  await settle();
  f.cb.ready!();
  await settle();
  f.cb.status!({ status: "playing" });
  online = false;
  f.setTime(241.4);
  f.cb.status!({ status: "paused" }); // from the lock screen
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(player.positionFor("itm_1", { positionSeconds: 221, durationSeconds: 300, updatedAt: "2026-11-06T10:00:00.000Z" })?.positionSeconds, 241.4, "kept on the device");
  online = true;
  await player.sendPending();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.position, 241.4);
  assert.ok(sent[0]!.recordedAt, "sent with when it was recorded");
  assert.equal(player.hasPending(), false);
  await player.close();
});
