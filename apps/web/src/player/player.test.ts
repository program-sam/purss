import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemMedia } from "@purss/domain";
import { app } from "@purss/translations/app";
import type { BackendState, PlaybackSource, PlayerBackend } from "./backend.ts";
import { IDLE_STATE } from "./backend.ts";
import { Player } from "./player.ts";
import type { PlayableItem, PlayerDeps } from "./player.ts";
import { bindMediaSession } from "./media-session.ts";
import type { MediaSessionLike } from "./media-session.ts";
import { noteManualWorkflowChange } from "../state/workflow-intent.ts";

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
const item = (over: Partial<PlayableItem> = {}): PlayableItem => ({ id: "itm_1", title: "Episode", sourceTitle: "Slow Radio", imageUrl: "https://img.example.org/c.jpg", media, playback: null, workflow: "undecided", workflowRevision: 0, ...over });
const tick = () => new Promise((r) => setImmediate(r));

function make(opts: { now?: () => number; playbackNow?: () => number; setPlaybackWorkflow?: PlayerDeps["setPlaybackWorkflow"] } = {}) {
  const backend = new FakeBackend();
  const saves: { itemId: string; position: number; keepalive: boolean }[] = [];
  let rate: number | null = 1.5;
  const player = new Player({
    backend,
    savePosition: async (itemId, position, _d, o) => { saves.push({ itemId, position, keepalive: o.keepalive }); },
    rateStore: { get: () => rate, set: (r) => { rate = r; } },
    now: opts.now,
    ...(opts.playbackNow ? { playbackNow: opts.playbackNow } : {}),
    ...(opts.setPlaybackWorkflow ? { setPlaybackWorkflow: opts.setPlaybackWorkflow } : {}),
  });
  return { backend, player, saves, rate: () => rate };
}

/**
 * Drives the player the way a backend does: `listen` plays for real seconds (the clock and the playhead both move, once a second as
 * the apps' backend reports); `seek` moves the playhead without time passing; `wait` lets time pass without playing.
 */
function session(opts: { workflow?: PlayableItem["workflow"]; duration?: number | null; refuse?: boolean; gate?: () => Promise<void> } = {}) {
  let time = 0;
  const calls: { from: string; to: string; expected: number; started: number; session: string }[] = [];
  const h = make({
    playbackNow: () => time,
    setPlaybackWorkflow: async (_id, from, to, playback) => {
      calls.push({ from, to, expected: playback.expectedWorkflowRevision, started: playback.startedWorkflowRevision, session: playback.sessionId });
      if (opts.gate) await opts.gate();
      return opts.refuse ? { applied: false, workflowRevision: playback.expectedWorkflowRevision } : { applied: true, workflowRevision: playback.expectedWorkflowRevision + 1 };
    },
  });
  const rate = () => h.player.getSnapshot().rate;
  const state = () => h.backend.state();
  const set = (patch: Partial<BackendState>) => h.backend.set({ ...state(), ...patch });
  const api = {
    ...h,
    /** What the player asked to have changed so far (a copy: an assertion on it must not narrow what it is). */
    sent: () => calls.slice(),
    async open() {
      await h.player.open(item({ workflow: opts.workflow ?? "toread", workflowRevision: 4 }));
      h.player.setRate(1);
      if (opts.duration !== undefined) set({ duration: opts.duration });
    },
    async listen(seconds: number) { for (let i = 0; i < seconds; i++) { time += 1000; set({ position: state().position + rate() }); await tick(); } },
    async seek(to: number) { h.backend.seek(to); await tick(); },
    async wait(seconds: number) { time += seconds * 1000; await tick(); },
    async pause() { h.player.pause(); await tick(); },
    async resume() { set({ ended: false }); await h.player.play(); await tick(); },
    /** The file runs out. */
    async end() { set({ playing: false, ended: true, position: state().duration ?? state().position }); await tick(); },
  };
  return api;
}

test("an item moves to In progress after 30 seconds of real playing, and not before", async () => {
  const s = session();
  await s.open();
  await s.listen(29);
  assert.deepEqual(s.sent(), []);
  await s.listen(1);
  assert.equal(s.sent().length, 1);
  assert.deepEqual({ from: s.sent()[0]!.from, to: s.sent()[0]!.to, expected: s.sent()[0]!.expected, started: s.sent()[0]!.started }, { from: "toread", to: "inprogress", expected: 4, started: 4 });
  await s.listen(60);
  assert.equal(s.sent().length, 1, "only once");
  await s.player.close();
});

test("the clock counts at the playing speed: 30 seconds of listening is 30 seconds, not 30 seconds of the recording", async () => {
  const s = session();
  await s.open();
  s.player.setRate(2);
  await s.listen(29);
  assert.deepEqual(s.sent(), [], "29 seconds at double speed is 58 seconds of the recording, and still not 30 seconds of listening");
  await s.listen(1);
  assert.equal(s.sent().length, 1);
  await s.player.close();
});

test("seeking is not listening, whichever way and however far", async () => {
  const s = session();
  await s.open();
  await s.listen(10);
  await s.seek(300); await s.seek(20); await s.seek(500); await s.seek(100);
  s.player.forward(); s.player.forward(); s.player.back();
  await tick();
  assert.deepEqual(s.sent(), [], "jumping about adds nothing to the ten seconds played");
  await s.listen(19);
  assert.deepEqual(s.sent(), [], "29 seconds in all");
  await s.listen(1);
  assert.equal(s.sent().length, 1, "30 seconds in all, wherever the playhead was");
  await s.player.close();
});

test("time paused, waiting for data or with the page frozen is not listening; pausing and resuming keeps what was played", async () => {
  const s = session();
  await s.open();
  await s.listen(20);
  await s.pause();
  await s.wait(3600);
  await s.resume();
  await s.listen(9);
  assert.deepEqual(s.sent(), [], "29 seconds played over an hour");
  s.backend.set({ ...s.backend.state(), buffering: true });
  await s.wait(120);
  s.backend.set({ ...s.backend.state(), buffering: false });
  await s.wait(120); // reported playing again, but the playhead stood still
  assert.deepEqual(s.sent(), [], "a stall adds nothing either");
  await s.listen(1);
  assert.equal(s.sent().length, 1);
  await s.player.close();
});

test("the last two minutes, or 95%, whichever comes first, finishes an item that is played there", async () => {
  const s = session({ workflow: "inprogress" });
  await s.open();
  await s.seek(470);
  await s.listen(5);
  assert.deepEqual(s.sent(), [], "ten minutes long: the last two minutes start at 8:00, and this is before it");
  await s.listen(10);
  assert.deepEqual(s.sent().map((c) => c.to), ["finished"]);
  assert.equal(s.sent()[0]!.from, "inprogress");
  await s.listen(30);
  assert.equal(s.sent().length, 1, "nothing more is sent once it is finished");
  await s.player.close();

  const long = session({ workflow: "inprogress", duration: 7200 });
  await long.open();
  await long.seek(6700);
  await long.listen(60);
  assert.deepEqual(long.sent(), [], "two hours long: 95% is 1:54:00 (6840 seconds), and this is before it");
  await long.seek(6838);
  await long.listen(2);
  assert.deepEqual(long.sent(), [], "arriving at 95%");
  await long.listen(3);
  assert.deepEqual(long.sent().map((c) => c.to), ["finished"]);
  await long.player.close();
});

test("a seek to the end does not finish an item; playing there does", async () => {
  const jumped = session({ workflow: "inprogress" });
  await jumped.open();
  await jumped.seek(590);
  await jumped.seek(599);
  await jumped.end();
  assert.deepEqual(jumped.sent(), [], "jumping to the end and reaching it with no listening is not finishing");
  await jumped.player.close();

  const scrubbed = session({ workflow: "inprogress" });
  await scrubbed.open();
  await scrubbed.seek(560);
  await scrubbed.pause();
  await scrubbed.seek(595);
  await scrubbed.resume();
  await scrubbed.listen(2);
  assert.deepEqual(scrubbed.sent(), [], "two seconds is a glance, not listening");
  await scrubbed.listen(1);
  assert.deepEqual(scrubbed.sent().map((c) => c.to), ["finished"]);
  await scrubbed.player.close();

  const rest = session({ workflow: "inprogress" });
  await rest.open();
  await rest.seek(598);
  await rest.listen(1);
  await rest.end();
  assert.deepEqual(rest.sent().map((c) => c.to), ["finished"], "playing into the end of the file finishes it, even from the last second or two");
  await rest.player.close();
});

test("an item that is New or To listen can be finished without ever being In progress, and a short item is not finished at its start", async () => {
  const s = session({ workflow: "undecided" });
  await s.open();
  await s.seek(540);
  await s.listen(4);
  assert.deepEqual(s.sent().map((c) => `${c.from}>${c.to}`), ["undecided>finished"], "played into the end after under 30 seconds: finished, in one step");
  await s.player.close();

  const clip = session({ workflow: "toread", duration: 90 });
  await clip.open();
  await clip.listen(30);
  assert.deepEqual(clip.sent().map((c) => `${c.from}>${c.to}`), ["toread>inprogress"], "ninety seconds is all of it within the last two minutes, but it is not finished 30 seconds in");
  await clip.listen(15);
  assert.deepEqual(clip.sent().map((c) => c.to), ["inprogress"], "halfway");
  await clip.listen(3);
  assert.deepEqual(clip.sent().map((c) => c.to), ["inprogress", "finished"], "and three seconds on");
  assert.deepEqual(clip.sent().map((c) => c.expected), [4, 5], "the second step is made against the first one's result");
  assert.equal(clip.sent()[0]!.session, clip.sent()[1]!.session);
  await clip.player.close();
});

test("with no known length it moves to In progress, and is Finished only by playing into the end of the file", async () => {
  const jumped = session({ duration: null });
  await jumped.open();
  await jumped.listen(30);
  assert.deepEqual(jumped.sent().map((c) => c.to), ["inprogress"]);
  await jumped.seek(100000);
  await jumped.end();
  assert.deepEqual(jumped.sent().map((c) => c.to), ["inprogress"], "a jump to the end is not finishing");
  await jumped.player.close();

  const played = session({ duration: null });
  await played.open();
  await played.listen(30);
  await played.seek(5000);
  await played.listen(60);
  await played.end(); // the file runs out where the last report left the playhead
  await played.end(); // and says so again
  assert.deepEqual(played.sent().map((c) => c.to), ["inprogress", "finished"]);
  await played.player.close();
});

test("the end reached while In progress is still being saved finishes the item once that answer comes, however often the end is reported", async () => {
  let open: (() => void) | null = null;
  let held = true;
  const s = session({ duration: null, gate: () => (held ? new Promise<void>((r) => { open = r; }) : Promise.resolve()) });
  await s.open();
  await s.listen(31); // In progress is sent and waits for its answer
  assert.deepEqual(s.sent().map((c) => c.to), ["inprogress"]);
  await s.listen(5);
  await s.end();
  await s.end();
  await s.end();
  held = false;
  open!();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(s.sent().map((c) => c.to), ["inprogress", "finished"]);
  await s.player.close();
});

test("Ignored and Finished items are left alone, and an item already In progress only ever finishes", async () => {
  for (const workflow of ["ignored", "finished"] as const) {
    const s = session({ workflow });
    await s.open();
    await s.listen(40);
    await s.seek(560);
    await s.listen(10);
    assert.deepEqual(s.sent(), [], workflow);
    await s.player.close();
  }
  const s = session({ workflow: "inprogress" });
  await s.open();
  await s.listen(120);
  assert.deepEqual(s.sent(), [], "listening to an item that is already In progress changes nothing");
  await s.player.close();
});

test("a state chosen by hand during playback ends the session, here or, through the server's refusal, on another device", async () => {
  const here = session();
  await here.open();
  await here.listen(20);
  noteManualWorkflowChange("itm_1");
  await here.listen(60);
  await here.seek(560);
  await here.listen(10);
  assert.deepEqual(here.sent(), [], "choosing a state by hand, even the one it has, is the person's call");
  await here.player.close();

  const s = session();
  await s.open();
  noteManualWorkflowChange("itm_2"); // another item's change is none of its business
  await s.listen(30);
  assert.equal(s.sent().length, 1);
  await s.player.close();

  const elsewhere = session({ refuse: true });
  await elsewhere.open();
  await elsewhere.listen(30);
  assert.equal(elsewhere.sent().length, 1, "refused: the workflow was changed elsewhere");
  await elsewhere.listen(60);
  await elsewhere.seek(560);
  await elsewhere.listen(10);
  assert.equal(elsewhere.sent().length, 1, "and playback does not try again");
  await elsewhere.player.close();
});

test("a session belongs to one item in the player: another item, or closing, starts again from nothing", async () => {
  const s = session();
  await s.open();
  await s.listen(25);
  await s.player.close();
  await s.player.open(item({ id: "itm_2", workflow: "toread", workflowRevision: 1 }));
  await s.listen(25);
  assert.deepEqual(s.sent(), [], "25 seconds of one and 25 of another is not 30 of either");
  await s.listen(5);
  assert.deepEqual(s.sent().map((c) => c.expected), [1]);
  await s.player.close();
});

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
  assert.equal(player.getSnapshot().error, app.player.errors.publisherFailed);
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

test("an episode without a picture of its own gives the media controls the show's art, and the apps' players only a publisher's https picture", async () => {
  const { backend, player } = make();
  const session: MediaSessionLike = { metadata: null, playbackState: "none", setActionHandler: () => undefined };
  class Meta { readonly init: unknown; constructor(init: unknown) { this.init = init; } }
  const unbind = bindMediaSession(player, session, Meta);
  const art = "/api/sources/src_1/icon?v=0123456789abcdef";
  await player.open(item({ imageUrl: art }));
  assert.deepEqual((session.metadata as Meta).init, { title: "Episode", artist: "Slow Radio", artwork: [{ src: art }] }, "the page's own address, read against the page");
  assert.equal(backend.loaded?.source.artwork, null, "a native player fetches the picture itself, with no session: it is given none");
  await player.close();
  await player.open(item({ id: "itm_2", imageUrl: "http://cdn.example/ep.jpg" }));
  assert.deepEqual((session.metadata as Meta).init, { title: "Episode", artist: "Slow Radio" }, "a picture the page may not show is none");
  unbind();
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
  assert.equal(player.getSnapshot().error, app.player.errors.deviceFailed);
  await player.open(item({ id: "itm_2" }));
  assert.equal(player.getSnapshot().now?.itemId, "itm_2", "not downloaded: it plays from the publisher");
  assert.equal(backend.loaded?.source.url, "https://cdn.example.org/a.mp3");
  assert.equal(player.getSnapshot().now?.from, "publisher");
});

test("a publisher's file is played only over a secure connection, as downloads are", async () => {
  const { backend, player } = make();
  await player.open(item({ media: { ...media, url: "http://cdn.example.org/a.mp3" } }));
  assert.equal(backend.loaded, null, "nothing loaded");
  assert.equal(player.getSnapshot().error, app.player.errors.notSecure);
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
