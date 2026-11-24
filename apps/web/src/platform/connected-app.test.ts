import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { MemoryOutboxStore, Outbox } from "../annotations/outbox.ts";
import { unsentWrites } from "../lib/unsent-writes.ts";
import { startConnectedApp } from "./connected-app.ts";
import type { Attached, ConnectedShell, Page, ShellPlatform } from "./connected-app.ts";
import type { PlayerBackend } from "../player/backend.ts";
import { IDLE_STATE } from "../player/backend.ts";
import type { DeviceFiles, KeyValue } from "../downloads/manager.ts";
import type { Connection } from "./native/connect.ts";
import { AWAY_MS, BUILTIN } from "./native/live-update.ts";
import type { BundleRef, Updater } from "./native/live-update.ts";

const ORIGIN = "https://ws.example";
const SAVED: Connection = { origin: ORIGIN, token: "purss_dev_secret", passkeys: false };
/** Where live-update.ts keeps the interface to switch to at the next safe moment (kept across restarts). */
const QUEUE_KEY = "purss:interface-next";
const forgot = app.platform.forget;

class FakeBackend implements PlayerBackend {
  readonly supportsVideo = false;
  playing = false;
  load(): void {}
  async play(): Promise<void> {}
  pause(): void {}
  seek(): void {}
  setRate(): void {}
  view(): HTMLElement | null { return null; }
  state() { return { ...IDLE_STATE, playing: this.playing }; }
  subscribe(): () => void { return () => {}; }
  unload(): void {}
}

type Options = {
  saved?: Connection | null;
  /** The last start couldn't remove the connection. */
  stuck?: boolean;
  /** The notice the last start left. */
  notice?: string;
  /** PURSS can't be reached to revoke the device. */
  unreachable?: boolean;
  /** Secure storage refuses to forget the connection. */
  storageRefuses?: boolean;
  /** The installed interface can't be restored. */
  resetFails?: boolean;
  /** The background job found the token refused while the app was closed. */
  refusedWhileClosed?: boolean;
  /** Interfaces the updater holds besides the installed one. */
  downloaded?: BundleRef[];
  /** The interface running now. */
  running?: BundleRef;
  /** The interface the last run queued for this start. */
  queued?: string;
};

/** The shell and the page faked, with every effect logged in order. */
function build(options: Options = {}) {
  const log: string[] = [];
  const store = new Map<string, string>();
  if (options.queued) store.set(QUEUE_KEY, options.queued);
  const keyValue: KeyValue = {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  };
  let notice: string | null = options.notice ?? null;
  let stuck = options.stuck ?? false;
  let stuckLeft: boolean | null = null;
  let shown: ((awayMs: number) => void) | null = null;
  let appChecks = 0;
  const backends: FakeBackend[] = [];
  /** Three unsent highlights and notes on the device, in memory. */
  const notes = new Outbox(new MemoryOutboxStore());
  const seeded = Promise.all([1, 2, 3].map((n) => notes.record({ accountId: "acc_1", itemId: "itm_a", annotationId: `ann_${n}`, at: "2026-11-01T10:00:00.000Z", op: "delete" })));
  let stoppedWith: PlayerBackend | null | "never" = "never";
  let restarted!: () => void;
  const restart = new Promise<void>((resolve) => { restarted = resolve; });

  const updater: Updater = {
    builtinVersion: async () => "builtin",
    current: async () => options.running ?? { id: BUILTIN, version: "" },
    download: async () => { throw new Error("not offered"); },
    downloaded: async () => options.downloaded ?? [],
    remove: async (id) => { log.push(`remove ${id}`); },
    apply: async (id) => {
      log.push(`apply ${id}`);
      if (options.resetFails && id === BUILTIN) { restarted(); throw new Error("plugin refused"); }
      if (id === BUILTIN) restarted();
    },
    failed: async () => null,
  };

  const shellPlatform: ShellPlatform = {
    createPlayerBackend: () => { const b = new FakeBackend(); backends.push(b); return b; },
    passkeys: null,
    saveFile: async () => {},
    onShare: () => () => {},
    widget: null,
    push: null,
    onOpen: () => () => {},
    onConnectReturn: () => () => {},
    appVersion: async () => null,
    appUpdates: null,
    notifier: { kind: "browser", permission: () => "default", request: async () => "default", show: () => {} },
    badge: null,
    onIntake: () => () => {},
    desktop: null,
    webView: null,
    frames: false,
  };

  const shell: ConnectedShell = {
    device: "phone",
    interfaceStarted: () => { log.push("started"); },
    updater,
    storage: {
      read: async () => { log.push("read connection"); return options.saved === undefined ? SAVED : options.saved; },
      forget: async () => { log.push("forget connection"); if (options.storageRefuses) throw new Error("secure storage refuses"); },
    },
    openExternal: (url) => { log.push(`open ${url}`); },
    listen: () => { log.push("listen"); },
    attach: async (conn): Promise<Attached> => {
      log.push(`attach ${conn?.origin ?? "nobody"}`);
      return {
        platform: shellPlatform,
        connected: conn ? {
          conn,
          policy: `policy for ${conn.origin}`,
          downloads: { files: fakeFiles(log), connection: async () => "wifi" },
          appCheck: () => { appChecks++; },
          refusedWhileClosed: async () => options.refusedWhileClosed ?? false,
          forget: {
            stopAudio: async (player) => { log.push("stop audio"); stoppedWith = player; },
            stopBackground: async () => { log.push("stop background"); },
            forgetPush: async () => { log.push("forget push"); },
            finish: () => { log.push("finish"); },
          },
        } : null,
      };
    },
    firstScreen: (n) => `first screen: ${n}`,
  };

  const page: Page = {
    origin: "https://bundled.app",
    store: keyValue,
    sendLinksOut: () => { log.push("links out"); },
    limitTo: (policy) => { log.push(policy); },
    onShown: (listener) => { shown = listener; },
    notices: {
      leave: (n, s) => { log.push("leave notice"); notice = n; stuckLeft = s; },
      take: () => notice,
      takeStuck: () => { const s = stuck; stuck = false; return s; },
    },
    resetAddress: () => { log.push("reset address"); },
    replaceWithRoot: () => { log.push("replace with root"); },
    reload: () => { log.push("reload"); },
    revokeDevice: async () => { log.push("revoke device"); if (options.unreachable) throw new Error("timeout"); },
    data: {
      wipeCopies: async () => { log.push("wipe copies"); },
      unsent: unsentWrites({ notes, clearLate: () => { log.push("clear late writes"); } }),
      clearHints: () => { log.push("clear hints"); },
    },
  };

  return {
    shell,
    page,
    log,
    notes,
    seeded,
    store: keyValue,
    backends,
    appChecks: () => appChecks,
    shown: (awayMs: number) => { shown?.(awayMs); },
    leftNotice: () => ({ notice, stuck: stuckLeft }),
    stoppedWith: () => stoppedWith,
    /** Resolves once the app asked for the installed interface, the last step of forgetting the device. */
    restarted: restart,
  };
}

/** An app started through the interface callers use. */
async function setup(options: Options = {}) {
  const faked = build(options);
  await faked.seeded;
  const started = await startConnectedApp(faked.shell, faked.page);
  return {
    ...faked,
    ...started,
    /** The platform's connection, which a connected app has. */
    connection: () => { assert.ok(started.platform.connection, "connected"); return started.platform.connection; },
  };
}

function fakeFiles(log: string[]): DeviceFiles {
  return {
    download: async () => { throw new Error("no network"); },
    list: async () => [],
    writeText: async () => 0,
    readText: async () => null,
    readBytes: async () => null,
    remove: async () => { log.push("remove downloads"); },
    uri: async (name) => name,
  };
}

type Answers = Record<string, () => Response>;
let requests: string[] = [];
let answers: Answers = {};

beforeEach(() => {
  requests = [];
  // PURSS asked for an interface (500: not decided, so a check leaves the queued interface alone) and the event stream.
  answers = { "/api/app/bundle": () => new Response("", { status: 500 }) };
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    return answers[url.pathname]?.() ?? new Response("", { status: 404 });
  });
});
afterEach(() => { mock.restoreAll(); });

test("a saved connection starts the app connected: the shell is attached to it and PURSS's policy limits the page", async () => {
  const a = await setup();
  assert.deepEqual(a.log, ["started", "links out", "listen", "read connection", `attach ${ORIGIN}`, `policy for ${ORIGIN}`]);
  assert.equal(a.screen, null);
  assert.equal(a.platform.connection?.origin, ORIGIN);
  assert.equal(a.platform.connection?.device, "phone");
  assert.equal(a.platform.publicOrigin(), ORIGIN);
  assert.ok(a.platform.downloads && a.platform.interfaceUpdates, "downloads and interface updates are on while connected");
  assert.equal(a.platform.keepsOtherAccountsUnsent, true, "the apps keep other accounts' unsent changes");
  assert.equal(a.appChecks(), 1, "the app's own new versions are looked for at start");
  await new Promise((r) => setImmediate(r));
  assert.ok(requests.includes("/api/app/bundle"), "PURSS is asked for an interface");
});

test("an app that isn't connected shows the first screen with the last notice, and takes no part in PURSS", async () => {
  const none = await setup({ saved: null, notice: "You were disconnected", downloaded: [{ id: "old", version: "1" }, { id: BUILTIN, version: "" }] });
  assert.deepEqual(none.log.slice(0, 5), ["started", "links out", "listen", "read connection", "attach nobody"]);
  assert.ok(!none.log.some((l) => l.startsWith("policy")), "no connection, no policy");
  assert.equal(none.screen, "first screen: You were disconnected");
  assert.equal(none.platform.connection, null);
  assert.equal(none.platform.downloads, null);
  assert.equal(none.platform.interfaceUpdates, null);
  assert.equal(none.platform.publicOrigin(), "https://bundled.app");
  assert.equal(none.platform.keepsOtherAccountsUnsent, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(none.log.includes("remove old"), "a server's interface outlives no connection");
  const res = await none.platform.transport.fetch("/api/session", {});
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "device_signed_out");
  await assert.rejects(Promise.resolve(none.platform.transport.picture("/api/sources/src_1/icon")), new RegExp(app.words.connectTheAppFirst));
});

test("links to other sites go to the shell's browser, and only web addresses", async () => {
  const a = await setup();
  a.platform.openExternal("https://example.com/a");
  a.platform.openExternal("javascript:alert(1)");
  a.platform.openExternal("file:///etc/passwd");
  assert.deepEqual(a.log.filter((l) => l.startsWith("open ")), ["open https://example.com/a"]);
});

test("a connection that couldn't be removed last time is tried once more and never used", async () => {
  const a = await setup({ stuck: true, notice: "stuck" });
  assert.deepEqual(a.log.slice(0, 5), ["started", "links out", "listen", "forget connection", "attach nobody"]);
  assert.ok(!a.log.includes("read connection"), "the stuck token is not read, it would only be refused again");
  assert.equal(a.screen, "first screen: stuck");
});

test("a downloaded interface waiting for this start takes over before anything is shown", async () => {
  const faked = build({ running: { id: "current", version: "1" }, downloaded: [{ id: "next", version: "2" }], queued: "next" });
  const outcome = await Promise.race([
    startConnectedApp(faked.shell, faked.page).then(() => "started"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still starting"), 50)),
  ]);
  assert.equal(outcome, "still starting", "the page reloads into the downloaded interface, so start-up never finishes");
  assert.deepEqual(faked.log, ["started", "apply next"], "nothing of the shell starts before it");
});

test("disconnecting tells PURSS, removes everything the app kept, leaves the notice and starts again at the installed interface", async () => {
  const a = await setup({ downloaded: [{ id: "next", version: "2" }] });
  a.store.set(QUEUE_KEY, "next");
  const made = a.platform.createPlayerBackend();
  await a.connection().disconnect();
  await a.restarted;
  const log = a.log.slice(a.log.indexOf("revoke device"));
  assert.equal(log[0], "revoke device");
  for (const effect of ["stop audio", "forget connection", "stop background", "wipe copies", "clear late writes", "remove downloads", "forget push", "clear hints"]) {
    assert.ok(log.includes(effect), effect);
  }
  assert.deepEqual(log.slice(-4), ["leave notice", "finish", "reset address", `apply ${BUILTIN}`], "the notice is left before the app starts again");
  assert.deepEqual(a.leftNotice(), { notice: forgot.disconnected, stuck: false });
  assert.equal(a.store.get(QUEUE_KEY), null, "the next PURSS decides on its own interface");
  assert.equal(a.stoppedWith(), made, "the sound that stops is the backend the page made");
});

test("disconnecting while PURSS can't be reached still removes everything, and says so", async () => {
  const a = await setup({ unreachable: true });
  await a.connection().disconnect();
  await a.restarted;
  assert.ok(a.log.includes("clear late writes"));
  assert.equal(a.notes.snapshot().length, 0, "the unsent highlights and notes went too");
  assert.ok(a.log.includes("wipe copies"));
  assert.deepEqual(a.leftNotice(), { notice: forgot.unreachable, stuck: false });
});

test("a lost device keeps the unsent highlights and notes, and the notice says how many", async () => {
  const a = await setup();
  a.connection().lost();
  await a.restarted;
  assert.ok(!a.log.includes("clear late writes"), "unsent positions and progress stay");
  assert.equal(a.notes.snapshot().length, 3, "unsent writing is the person's own");
  for (const effect of ["wipe copies", "remove downloads", "forget connection", "stop background", "forget push"]) assert.ok(a.log.includes(effect), effect);
  assert.deepEqual(a.leftNotice(), { notice: forgot.lost(forgot.unsentKept(3)), stuck: false });
  assert.equal(a.stoppedWith(), null, "no sound was started by the page");
});

test("a connection that secure storage won't remove is marked so the next start doesn't use it", async () => {
  const a = await setup({ storageRefuses: true });
  a.connection().lost();
  await a.restarted;
  const left = a.leftNotice();
  assert.equal(left.stuck, true);
  assert.equal(left.notice, forgot.lost(forgot.unsentKept(3)) + forgot.stuck);
});

test("however many times the device is lost or disconnected, it is forgotten once", async () => {
  const a = await setup();
  a.connection().lost();
  a.connection().lost();
  await a.connection().disconnect();
  await a.restarted;
  assert.equal(a.log.filter((l) => l === "forget connection").length, 1);
  assert.equal(a.log.filter((l) => l === "leave notice").length, 1);
  assert.equal(a.leftNotice().notice, forgot.lost(forgot.unsentKept(3)), "the first reason stands");
});

test("PURSS refusing the device on the event stream loses it", async () => {
  answers["/api/events"] = () => Response.json({ error: { code: "device_signed_out", message: "gone" } }, { status: 401 });
  const a = await setup();
  const stop = a.platform.transport.events(() => {});
  await a.restarted;
  stop();
  assert.ok(requests.includes("/api/events"));
  assert.ok(!a.log.includes("clear late writes"), "lost, not disconnected");
  assert.equal(a.leftNotice().notice, forgot.lost(forgot.unsentKept(3)));
});

test("the background job finding the token refused while the app was closed loses the device at start", async () => {
  const a = await setup({ refusedWhileClosed: true });
  await a.restarted;
  assert.equal(a.leftNotice().notice, forgot.lost(forgot.unsentKept(3)));
  const quiet = await setup({ refusedWhileClosed: false });
  await new Promise((r) => setImmediate(r));
  assert.ok(!quiet.log.includes("leave notice"));
});

test("when the installed interface can't be restored the page loads the root afresh", async () => {
  const a = await setup({ resetFails: true });
  a.connection().lost();
  await a.restarted;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.log.slice(-3), ["reset address", `apply ${BUILTIN}`, "replace with root"]);
});

test("coming back to the app looks for new versions, and an hour away takes the queued interface unless something is playing", async () => {
  const a = await setup({ running: { id: "current", version: "1" }, downloaded: [{ id: "next", version: "2" }] });
  assert.equal(a.appChecks(), 1);
  const backend = a.platform.createPlayerBackend() as FakeBackend;
  a.store.set(QUEUE_KEY, "next");
  backend.playing = true;
  a.shown(AWAY_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.appChecks(), 2, "each return looks for a new version of the app");
  assert.ok(!a.log.includes("apply next"), "a reload would stop the player");
  backend.playing = false;
  a.shown(AWAY_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(!a.log.includes("apply next"), "not away long enough");
  a.shown(AWAY_MS);
  await new Promise((r) => setImmediate(r));
  assert.ok(a.log.includes("apply next"));
  assert.equal(a.appChecks(), 4);
});

test("the offline host is the app's own: always installed, and an update reloads the page", async () => {
  const a = await setup();
  assert.equal(a.platform.offline.installed(), true);
  assert.equal(await a.platform.offline.start(), true);
  a.platform.offline.applyUpdate();
  assert.ok(a.log.includes("reload"));
});
