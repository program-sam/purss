import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppBundleOffer } from "@purss/domain/app-bundle";
import { bundleVersion } from "@purss/domain/app-bundle";
import { AWAY_MS, BUILTIN, chooseTarget, createInterfaceUpdates, forgetQueued, removeDownloads, startQueued } from "./live-update.ts";
import type { BundleRef, Updater } from "./live-update.ts";

const ORIGIN = "https://self.example";
const offerOf = (native: number, built: number): AppBundleOffer => {
  const version = bundleVersion({ native, built });
  return { version, native, built, path: `/api/app/bundle/${version}.zip`, checksum: "a".repeat(64), size: 1000 };
};

test("chooseTarget: the offer only when it fits the native code, hasn't failed and the person agreed", () => {
  const offer = offerOf(2, 100);
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 2, failed: [], consent: "yes" }), { kind: "offer", offer });
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 2, failed: [], consent: null }), { kind: "ask", offer });
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 2, failed: [], consent: "no" }), { kind: "builtin" });
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 3, failed: [], consent: "yes" }), { kind: "builtin" }, "built for other native code");
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 1, failed: [], consent: "yes" }), { kind: "builtin" }, "built for other native code");
  assert.deepEqual(chooseTarget({ offer, nativeLevel: null, failed: [], consent: "yes" }), { kind: "builtin" }, "the app's own version unknown");
  assert.deepEqual(chooseTarget({ offer, nativeLevel: 2, failed: [offer.version], consent: "yes" }), { kind: "builtin" }, "failed to start before");
  assert.deepEqual(chooseTarget({ offer: null, nativeLevel: 2, failed: [], consent: "yes" }), { kind: "builtin" });
});

/** The plugin's behaviour as far as it matters: the running interface can't be deleted. */
class FakeUpdater implements Updater {
  running: BundleRef = { id: BUILTIN, version: bundleVersion({ native: 2, built: 50 }) };
  bundles: BundleRef[] = [];
  failure: string | null = null;
  calls: string[] = [];
  n = 0;
  builtinVersion = async () => bundleVersion({ native: 2, built: 50 });
  current = async () => this.running;
  download = async (o: { url: string; version: string; checksum: string }) => {
    this.calls.push(`download ${o.url}`);
    const b = { id: `b${++this.n}`, version: o.version };
    this.bundles.push(b);
    return b;
  };
  downloaded = async () => this.bundles;
  remove = async (id: string) => {
    if (id === this.running.id) throw new Error("can't delete the current bundle");
    this.calls.push(`remove ${id}`);
    this.bundles = this.bundles.filter((b) => b.id !== id);
  };
  apply = async (id: string) => {
    this.calls.push(`apply ${id}`);
    this.running = id === BUILTIN ? { id: BUILTIN, version: bundleVersion({ native: 2, built: 50 }) } : this.bundles.find((b) => b.id === id)!;
  };
  failed = async () => { const f = this.failure; this.failure = null; return f; };
}

function setup(o: { offer: AppBundleOffer | null | "down"; official?: boolean; consent?: Record<string, string>; playing?: boolean }) {
  const updater = new FakeUpdater();
  const kv = new Map<string, string>(o.consent ? [["purss:interface-updates", JSON.stringify(o.consent)]] : []);
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v), remove: (k: string) => void kv.delete(k) };
  let now = 1_000_000;
  let offer = o.offer;
  const asked: string[] = [];
  const updates = createInterfaceUpdates({
    origin: ORIGIN,
    official: o.official ?? false,
    updater,
    fetch: async (url, init) => {
      asked.push(url);
      assert.equal(init.credentials, "omit");
      if (offer === "down") throw new TypeError("offline");
      return offer ? new Response(JSON.stringify(offer)) : new Response(JSON.stringify({ error: { code: "no_app_bundle" } }), { status: 404 });
    },
    playing: () => o.playing ?? false,
    store,
    now: () => now,
  });
  /** The app starts again: a queued interface takes over. */
  const restart = () => startQueued(updater, store);
  return { updater, updates, kv, store, restart, asked, setOffer: (x: typeof offer) => { offer = x; }, advance: (ms: number) => { now += ms; } };
}

test("the official server's update is downloaded without a question and takes over at the next start", async () => {
  const offer = offerOf(2, 100);
  const s = setup({ offer, official: true });
  await s.updates.check();
  assert.deepEqual(s.asked, [`${ORIGIN}/api/app/bundle`]);
  assert.deepEqual(s.updater.calls, [`download ${ORIGIN}${offer.path}`], "nothing switches while the app runs");
  assert.equal(s.updates.state().asking, false);
  // Asking again changes nothing while it waits.
  await s.updates.check();
  assert.equal(s.updater.calls.length, 1);
  assert.equal(await s.restart(), true);
  assert.equal(s.updater.running.version, offer.version);
  assert.equal(await s.restart(), false, "once switched, a start is a plain start");
});

test("an interface that is switched to but rolled back isn't switched to again at every start", async () => {
  const s = setup({ offer: offerOf(2, 100), official: true });
  await s.updates.check();
  s.updater.apply = async (id) => { s.updater.calls.push(`apply ${id}`); }; // the plugin rolls back: the installed one stays
  assert.equal(await s.restart(), true);
  assert.equal(await s.restart(), false);
  assert.equal(s.updater.calls.filter((c) => c.startsWith("apply")).length, 1);
});

test("disconnecting forgets the queued interface, and the next start without a connection removes the downloads", async () => {
  const s = setup({ offer: offerOf(2, 100), official: true });
  await s.updates.check();
  forgetQueued(s.store);
  assert.equal(await s.restart(), false);
  await removeDownloads(s.updater);
  assert.deepEqual(s.updater.bundles, []);
});

test("another server is asked about once; no download before the answer, and the answer is remembered per server", async () => {
  const offer = offerOf(2, 100);
  const s = setup({ offer });
  await s.updates.check();
  assert.equal(s.updates.state().asking, true);
  assert.deepEqual(s.updater.calls, []);
  await s.updates.answer(true);
  assert.equal(s.updates.state().asking, false);
  assert.equal(s.updates.state().consent, "yes");
  assert.deepEqual(JSON.parse(s.kv.get("purss:interface-updates")!), { [ORIGIN]: "yes" });
  assert.deepEqual(s.updater.calls, [`download ${ORIGIN}${offer.path}`]);

  const refused = setup({ offer, consent: { [ORIGIN]: "no" } });
  await refused.updates.check();
  assert.equal(refused.updates.state().asking, false);
  assert.deepEqual(refused.updater.calls, []);
});

test("refusing after an update was installed brings back the installed interface at the next start", async () => {
  const offer = offerOf(2, 100);
  const s = setup({ offer, consent: { [ORIGIN]: "yes" } });
  await s.updates.check();
  await s.restart();
  assert.equal(s.updater.running.version, offer.version);
  await s.updates.answer(false);
  assert.equal(s.updater.running.version, offer.version, "not while the app runs");
  await s.restart();
  assert.equal(s.updater.running.id, BUILTIN);
});

test("refusing while the update is still downloading drops it once the download ends", async () => {
  const s = setup({ offer: offerOf(2, 100), consent: { [ORIGIN]: "yes" } });
  let finish!: () => void;
  const download = s.updater.download;
  s.updater.download = async (o) => { await new Promise<void>((r) => { finish = r; }); return download(o); };
  const first = s.updates.check();
  await new Promise((r) => setTimeout(r, 0));
  const refused = s.updates.answer(false);
  finish();
  await Promise.all([first, refused]);
  assert.equal(s.updates.state().consent, "no");
  assert.equal(await s.restart(), false);
  assert.deepEqual(s.updater.bundles, []);
});

test("refusing while an update waits drops it", async () => {
  const s = setup({ offer: offerOf(2, 100), consent: { [ORIGIN]: "yes" } });
  await s.updates.check();
  await s.updates.answer(false);
  assert.equal(await s.restart(), false);
  assert.deepEqual(s.updater.bundles, []);
});

test("a server without an update, or with one for other native code, brings back the installed interface", async () => {
  const s = setup({ offer: offerOf(2, 100), official: true });
  await s.updates.check();
  await s.restart();
  s.setOffer(null);
  s.advance(AWAY_MS);
  await s.updates.check();
  await s.restart();
  assert.equal(s.updater.running.id, BUILTIN);

  const other = setup({ offer: offerOf(3, 100), official: true });
  await other.updates.check();
  assert.deepEqual(other.updater.calls, []);
});

test("a newer build replaces the waiting one, and older downloads are removed", async () => {
  const s = setup({ offer: offerOf(2, 100), official: true });
  await s.updates.check();
  s.setOffer(offerOf(2, 200));
  await s.updates.check();
  assert.deepEqual(s.updater.bundles.map((b) => b.id), ["b2"]);
  await s.restart();
  assert.equal(s.updater.running.version, offerOf(2, 200).version);
});

test("the same build running already: nothing to download", async () => {
  const offer = offerOf(2, 100);
  const s = setup({ offer, official: true });
  await s.updates.check();
  await s.restart();
  s.updater.calls = [];
  await s.updates.check();
  assert.deepEqual(s.updater.calls, []);
});

test("a build that failed to start is never tried again", async () => {
  const offer = offerOf(2, 100);
  const s = setup({ offer, official: true });
  s.updater.failure = offer.version;
  await s.updates.check();
  assert.deepEqual(s.updater.calls, []);
  await s.updates.check();
  assert.deepEqual(s.updater.calls, [], "remembered after the plugin forgot it");
});

test("no answer from the server changes nothing", async () => {
  const s = setup({ offer: "down", official: true });
  await s.updates.check();
  assert.deepEqual(s.updater.calls, []);
  assert.equal(await s.restart(), false);
});

test("a waiting update takes over when the app is shown after an hour away, never while something plays", async () => {
  const s = setup({ offer: offerOf(2, 100), official: true });
  await s.updates.check();
  await s.updates.shown(AWAY_MS - 1);
  assert.ok(!s.updater.calls.includes("apply b1"));
  await s.updates.shown(AWAY_MS);
  assert.ok(s.updater.calls.includes("apply b1"));

  const playing = setup({ offer: offerOf(2, 100), official: true, playing: true });
  await playing.updates.check();
  await playing.updates.shown(AWAY_MS * 5);
  assert.ok(!playing.updater.calls.includes("apply b1"));
});

test("shown again: the server is asked again only every half hour", async () => {
  const s = setup({ offer: null, official: true });
  await s.updates.check();
  await s.updates.shown(0);
  assert.equal(s.asked.length, 1);
  s.advance(30 * 60_000);
  await s.updates.shown(0);
  assert.equal(s.asked.length, 2);
});
