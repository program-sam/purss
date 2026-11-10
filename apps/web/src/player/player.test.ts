import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemMedia } from "@purss/domain";
import type { BackendState, PlaybackSource, PlayerBackend } from "./backend.ts";
import { IDLE_STATE } from "./backend.ts";
import { Player } from "./player.ts";
import type { PlayableItem } from "./player.ts";
import { bindMediaSession } from "./media-session.ts";
import type { MediaSessionLike } from "./media-session.ts";

/** A backend that plays nothing, for driving the controller as a native backend would. */
class FakeBackend implements PlayerBackend {
  readonly supportsVideo = false;
  loaded: { source: PlaybackSource; startAt: number; rate: number } | null = null;
  rate = 1;
  #s: BackendState = IDLE_STATE;
  #l = new Set<() => void>();
  load(source: PlaybackSource, o: { startAt: number; rate: number; autoplay: boolean }) { this.loaded = { source, startAt: o.startAt, rate: o.rate }; this.set({ ...IDLE_STATE, position: o.startAt, duration: 600, playing: o.autoplay }); }
  async play() { this.set({ ...this.#s, playing: true }); }
  pause() { this.set({ ...this.#s, playing: false }); }
  seek(t: number) { this.set({ ...this.#s, position: Math.max(0, t) }); }
  setRate(r: number) { this.rate = r; }
  view() { return null; }
  state() { return this.#s; }
  subscribe(fn: () => void) { this.#l.add(fn); return () => this.#l.delete(fn); }
  unload() { this.loaded = null; this.set(IDLE_STATE); }
  set(s: BackendState) { this.#s = s; for (const l of this.#l) l(); }
}

const media: ItemMedia = { url: "https://cdn.example.org/a.mp3", kind: "audio", type: "audio/mpeg", length: null };
const item = (over: Partial<PlayableItem> = {}): PlayableItem => ({ id: "itm_1", title: "Episode", sourceTitle: "Slow Radio", imageUrl: "https://img.example.org/c.jpg", media, playback: null, ...over });
const tick = () => new Promise((r) => setImmediate(r));

function make(opts: { now?: () => number } = {}) {
  const backend = new FakeBackend();
  const saves: { itemId: string; position: number; keepalive: boolean }[] = [];
  let rate: number | null = 1.5;
  const player = new Player({
    backend,
    savePosition: async (itemId, position, _d, o) => { saves.push({ itemId, position, keepalive: o.keepalive }); },
    rateStore: { get: () => rate, set: (r) => { rate = r; } },
    now: opts.now,
  });
  return { backend, player, saves, rate: () => rate };
}

test("opening an item plays the publisher's file from where it was left, at the device's speed", async () => {
  const { backend, player } = make();
  await player.open(item({ playback: { positionSeconds: 120, durationSeconds: 600, updatedAt: "" } }));
  assert.equal(backend.loaded?.source.url, "https://cdn.example.org/a.mp3", "straight from the publisher; PURSS serves no media");
  assert.equal(backend.loaded?.startAt, 118);
  assert.equal(backend.loaded?.rate, 1.5);
  assert.equal(player.getSnapshot().now?.from, "publisher");
  assert.equal(player.getSnapshot().state.playing, true);
});

test("the position is saved on pause, now and then while playing, on close, and kept alive when the page goes", async () => {
  let clock = 0;
  const { backend, player, saves } = make({ now: () => clock });
  await player.open(item());
  backend.seek(40); await tick();
  assert.equal(saves.length, 1, "a jump is saved while playing");
  backend.seek(45); await tick();
  assert.equal(saves.length, 1, "not again so soon");
  clock += 16_000;
  backend.seek(60); await tick();
  assert.equal(saves.at(-1)?.position, 60);
  backend.seek(90);
  player.pause(); await tick();
  assert.equal(saves.at(-1)?.position, 90, "pausing saves straight away");
  backend.seek(200);
  await player.flush({ keepalive: true });
  assert.deepEqual(saves.at(-1), { itemId: "itm_1", position: 200, keepalive: true });
  backend.seek(250);
  await player.close();
  assert.equal(saves.at(-1)?.position, 250);
  assert.equal(player.getSnapshot().now, null);
  assert.equal(backend.loaded, null);
});

test("speed, skipping and failures", async () => {
  const { backend, player, rate } = make();
  await player.open(item());
  player.setRate(2);
  assert.equal(backend.rate, 2);
  assert.equal(rate(), 2, "remembered for this device");
  backend.seek(100);
  player.back();
  assert.equal(backend.state().position, 85);
  player.forward();
  assert.equal(backend.state().position, 115);
  backend.set({ ...backend.state(), failed: true });
  assert.match(player.getSnapshot().error!, /publisher's file couldn't be played/);
});

test("the operating system's media controls follow the player and drive it", async () => {
  const { backend, player } = make();
  const handlers = new Map<string, ((d: { seekTime?: number; seekOffset?: number }) => void) | null>();
  const session: MediaSessionLike & { position?: unknown } = {
    metadata: null, playbackState: "none",
    setActionHandler: (a, h) => { handlers.set(a, h); },
    setPositionState: (s) => { session.position = s; },
  };
  class Meta { readonly init: unknown; constructor(init: unknown) { this.init = init; } }
  const unbind = bindMediaSession(player, session, Meta);
  await player.open(item());
  assert.deepEqual((session.metadata as Meta).init, { title: "Episode", artist: "Slow Radio", artwork: [{ src: "https://img.example.org/c.jpg" }] });
  assert.equal(session.playbackState, "playing");
  handlers.get("pause")!({});
  assert.equal(backend.state().playing, false);
  assert.equal(session.playbackState, "paused");
  handlers.get("seekto")!({ seekTime: 300 });
  assert.equal(backend.state().position, 300);
  assert.deepEqual(session.position, { duration: 600, playbackRate: 1.5, position: 300 });
  // A headset's double press is "next track", a triple press "previous track": they skip within the episode.
  handlers.get("nexttrack")!({});
  assert.equal(backend.state().position, 330);
  handlers.get("previoustrack")!({});
  assert.equal(backend.state().position, 315);
  unbind();
  assert.equal(handlers.get("nexttrack"), null);
  assert.equal(handlers.get("play"), null);
  assert.equal(session.metadata, null);
});

test("a copy downloaded to the device plays first, with no connection needed", async () => {
  const backend = new FakeBackend();
  const player = new Player({
    backend,
    savePosition: async () => { throw new Error("offline"); },
    deviceCopy: async (id) => (id === "itm_1" ? "file:///app/downloads/acc/itm_1/media.mp3" : null),
  });
  await player.open(item({ playback: { positionSeconds: 300, durationSeconds: 600, updatedAt: "" } }));
  assert.equal(backend.loaded?.source.url, "file:///app/downloads/acc/itm_1/media.mp3");
  assert.equal(backend.loaded?.startAt, 298);
  assert.deepEqual([backend.loaded?.source.title, backend.loaded?.source.artist, backend.loaded?.source.artwork], ["Episode", "Slow Radio", "https://img.example.org/c.jpg"], "what the lock screen shows");
  assert.equal(player.getSnapshot().now?.from, "device");
  backend.set({ ...backend.state(), failed: true });
  assert.match(player.getSnapshot().error!, /download on this device couldn't be played/);
  await player.open(item({ id: "itm_2" }));
  assert.equal(player.getSnapshot().now?.itemId, "itm_2", "not downloaded: it plays from the publisher");
  assert.equal(backend.loaded?.source.url, "https://cdn.example.org/a.mp3");
  assert.equal(player.getSnapshot().now?.from, "publisher");
});

test("a publisher's file is played only over a secure connection, as downloads are", async () => {
  const { backend, player } = make();
  await player.open(item({ media: { ...media, url: "http://cdn.example.org/a.mp3" } }));
  assert.equal(backend.loaded, null, "nothing loaded");
  assert.match(player.getSnapshot().error!, /secure connection/);
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/** The server's side of PUT /playback, with its rule: a position recorded before the stored one doesn't replace it. */
function fakeServer(start: { position: number; at: string }) {
  let stored = { positionSeconds: start.position, durationSeconds: 300 as number | null, updatedAt: start.at };
  let online = true;
  const requests: { position: number; recordedAt?: string }[] = [];
  return {
    get stored() { return stored; },
    set online(v: boolean) { online = v; },
    requests,
    save: async (_itemId: string, position: number, duration: number | null, o: { recordedAt?: string }, serverNow: string) => {
      if (!online) throw Object.assign(new Error("Can't reach PURSS right now."), { status: 0, code: "offline" });
      requests.push({ position, ...(o.recordedAt ? { recordedAt: o.recordedAt } : {}) });
      const at = o.recordedAt && o.recordedAt < serverNow ? o.recordedAt : serverNow;
      if (at >= stored.updatedAt) stored = { positionSeconds: position, durationSeconds: duration, updatedAt: at };
    },
  };
}

test("a position played offline wins over the older one on the server, and is sent once the connection is back", async () => {
  // 10:00: played online to 3:41. Then the connection drops and playback goes on past 4:01.
  let clock = Date.parse("2026-11-06T10:00:00.000Z");
  const server = fakeServer({ position: 221, at: "2026-11-06T10:00:00.000Z" });
  const backend = new FakeBackend();
  const storage = memoryStorage();
  const { lateStore, worthRetrying } = await import("../lib/late-writes.ts");
  const make = () => new Player({
    backend, now: () => clock, worthRetrying,
    savePosition: (id, p, d, o) => server.save(id, p, d, o, new Date(clock).toISOString()),
  });
  let player = make();
  player.setPendingStore(lateStore("playback", "acc_1", storage));
  const episode = item({ playback: { ...server.stored } });
  await player.open(episode);
  assert.equal(backend.loaded?.startAt, 219);
  server.online = false;
  for (let t = 222; t <= 242; t++) { clock += 1000; backend.seek(t); await tick(); }
  player.pause(); await tick();
  assert.equal(server.stored.positionSeconds, 221, "nothing reached the server while offline");
  assert.ok(player.hasPending(), "the position is kept on the device");

  // Offline, the app is closed and opened again: it resumes from the device's newer position, not the server's 3:41.
  await player.close();
  player = make();
  player.setPendingStore(lateStore("playback", "acc_1", storage));
  assert.equal(player.positionFor(episode.id, episode.playback)?.positionSeconds, 242, "Listen from shows the device's position");
  await player.open(episode, { autoplay: false });
  assert.equal(backend.loaded?.startAt, 240, "resumes near 4:02, two seconds back for context");

  // 10:30: the connection is back; nothing is played. The waiting position is sent with when it was recorded.
  clock = Date.parse("2026-11-06T10:30:00.000Z");
  server.online = true;
  await player.sendPending();
  assert.equal(server.stored.positionSeconds, 242, "the offline position reached the server");
  assert.equal(server.stored.updatedAt, "2026-11-06T10:00:21.000Z", "kept with the time it was recorded on the device");
  assert.ok(server.requests.at(-1)?.recordedAt, "sent late, so it says when it was recorded");
  assert.equal(player.hasPending(), false);

  // Opening it again with the refreshed server position starts there: never back at 3:39.
  await player.close();
  await player.open(item({ playback: { ...server.stored } }));
  assert.equal(backend.loaded?.startAt, 240);
});

test("a position recorded offline doesn't overwrite one recorded later on another device", async () => {
  let clock = Date.parse("2026-11-06T10:00:00.000Z");
  const server = fakeServer({ position: 100, at: "2026-11-06T09:00:00.000Z" });
  const backend = new FakeBackend();
  const { lateStore, worthRetrying } = await import("../lib/late-writes.ts");
  const player = new Player({ backend, now: () => clock, worthRetrying, savePosition: (id, p, d, o) => server.save(id, p, d, o, new Date(clock).toISOString()) });
  player.setPendingStore(lateStore("playback", "acc_1", memoryStorage()));
  await player.open(item({ playback: { ...server.stored } }));
  server.online = false;
  backend.seek(150); await tick();
  player.pause(); await tick();
  // 10:10: the person listens on another device, which saves 0:30 online.
  clock = Date.parse("2026-11-06T10:10:00.000Z");
  server.online = true;
  await server.save("itm_1", 30, 300, {}, "2026-11-06T10:10:00.000Z");
  await player.sendPending();
  assert.equal(server.stored.positionSeconds, 30, "the later position stays");
  assert.equal(player.hasPending(), false, "the stale one is settled, not sent again and again");
  assert.equal(player.positionFor("itm_1", { ...server.stored })?.positionSeconds, 30);
});

test("a save PURSS refuses for good isn't kept; one that couldn't reach it is", async () => {
  const backend = new FakeBackend();
  const storage = memoryStorage();
  const { lateStore, worthRetrying } = await import("../lib/late-writes.ts");
  let failure: unknown = Object.assign(new Error("gone"), { status: 404, code: "not_found" });
  const player = new Player({ backend, worthRetrying, savePosition: async () => { throw failure; } });
  player.setPendingStore(lateStore("playback", "acc_1", storage));
  await player.open(item());
  backend.seek(50); await tick();
  player.pause(); await tick();
  assert.equal(player.hasPending(), false);
  failure = Object.assign(new Error("busy"), { status: 503, code: "unavailable" });
  await player.play();
  backend.seek(80); await tick();
  player.pause(); await tick();
  assert.equal(player.hasPending(), true);
});

test("the sleep timer pauses when its time is up, even if the timer itself runs late, and ends with the player", async () => {
  let clock = 1_000_000;
  const { backend, player } = make({ now: () => clock });
  await player.open(item());
  player.setSleepTimer(15);
  assert.equal(player.getSnapshot().sleepAt, 1_000_000 + 15 * 60_000);
  clock += 14 * 60_000;
  backend.seek(100);
  assert.equal(backend.state().playing, true, "still playing before the time is up");
  // In the background the timeout may not fire on time; the next position report from the backend pauses instead.
  clock += 61_000;
  backend.seek(160);
  assert.equal(backend.state().playing, false, "paused once the time is up");
  assert.equal(player.getSnapshot().sleepAt, null, "and the timer is off");
  await player.play();
  clock += 60 * 60_000;
  backend.seek(200);
  assert.equal(backend.state().playing, true, "pressing play again plays on with no timer");

  // Time up while the next episode is still loading: it must not start once it is ready.
  let paused = 0;
  const pause = backend.pause.bind(backend);
  backend.pause = () => { paused++; pause(); };
  player.setSleepTimer(5);
  backend.set({ ...backend.state(), playing: false, buffering: true });
  clock += 5 * 60_000;
  backend.set({ ...backend.state(), buffering: true });
  assert.equal(paused >= 1, true, "the backend is told to pause even though nothing plays yet");
  backend.pause = pause;

  player.setSleepTimer(30);
  player.setSleepTimer(null);
  assert.equal(player.getSnapshot().sleepAt, null, "turned off");
  player.setSleepTimer(5);
  await player.close();
  assert.equal(player.getSnapshot().sleepAt, null, "closing the player ends the timer");
});
