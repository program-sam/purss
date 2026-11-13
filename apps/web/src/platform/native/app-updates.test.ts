import assert from "node:assert/strict";
import { test } from "node:test";
import { ANDROID_APK, desktopDownloadUrl } from "@purss/domain";
import { CHECK_EVERY_MS, createAppUpdates, isNewer, manifestVersion, sourceOf, whereToGet } from "./app-updates.ts";
import type { AppSource } from "../types.ts";

test("sourceOf: where the app came from decides where its new versions come from", () => {
  assert.equal(sourceOf({ platform: "ios" }), "appstore");
  assert.equal(sourceOf({ platform: "android", flavor: "full", installer: "com.android.vending" }), "play");
  assert.equal(sourceOf({ platform: "android", flavor: "full", installer: null }), "github", "installed by hand or with adb");
  assert.equal(sourceOf({ platform: "android", flavor: "full", installer: "com.google.android.packageinstaller" }), "github");
  assert.equal(sourceOf({ platform: "android", flavor: "full", installer: "dev.imranr.obtainium" }), "github", "an APK updater installs the same release");
  assert.equal(sourceOf({ platform: "android", flavor: "foss", installer: null }), "fdroid", "the FOSS build never takes the GitHub APK (another signing key)");
  assert.equal(sourceOf({ platform: "android", flavor: "foss", installer: "com.android.vending" }), "fdroid");
  assert.equal(sourceOf({ platform: "android" }), null, "an app from before it could tell");
  assert.equal(sourceOf({ platform: "web" }), null);
});

test("whereToGet: the APK's fixed address; the stores only once listed", () => {
  assert.deepEqual(whereToGet("github"), { name: "GitHub", url: desktopDownloadUrl(ANDROID_APK) });
  assert.equal(whereToGet("fdroid").url, null, "the F-Droid client updates it");
  assert.equal(whereToGet(null).name, "");
});

test("manifestVersion and isNewer: dotted release versions against the installed plain one", () => {
  assert.equal(manifestVersion({ version: "26.315.32", platforms: {} }), "2631532");
  assert.equal(manifestVersion({ version: "26.5.3" }), "2600503");
  assert.equal(manifestVersion({ version: "1.2.3.4" }), null);
  assert.equal(manifestVersion({}), null);
  assert.equal(manifestVersion(null), null);
  assert.equal(manifestVersion("26.315.32"), null);
  assert.equal(isNewer("2631532", "2631524"), true);
  assert.equal(isNewer("2700101", "2636599"), true, "a new year");
  assert.equal(isNewer("2631524", "2631524"), false);
  assert.equal(isNewer("2631524", "2631532"), false, "the installed one is newer (built from main after the release)");
  assert.equal(isNewer("2631532", null), false, "a build without a version never asks for another");
  assert.equal(isNewer(null, "2631524"), false);
  assert.equal(isNewer("garbage", "2631524"), false);
});

function setup(o: { source: AppSource | null; installed: string | null; latest: string | null | "down" }) {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v), remove: (k: string) => void kv.delete(k) };
  let now = 10 * CHECK_EVERY_MS;
  const asked: number[] = [];
  const opts = { ...o };
  const make = () => createAppUpdates({
    source: async () => opts.source,
    installed: async () => opts.installed,
    latest: async () => { asked.push(now); if (opts.latest === "down") throw new Error("offline"); return opts.latest; },
    store,
    now: () => now,
  });
  return { make, opts, kv, asked, advance: (ms: number) => { now += ms; } };
}

test("an APK from the releases learns of a newer release, asking once a day, and announces it once", async () => {
  const s = setup({ source: "github", installed: "2631524", latest: "2631532" });
  const u = s.make();
  await u.check();
  assert.deepEqual(u.state(), { known: true, source: "github", installed: "2631524", newer: "2631532", toldNewer: false, toldNeeded: false });
  u.markTold("newer");
  assert.equal(u.state().toldNewer, true);
  await u.check();
  assert.equal(s.asked.length, 1, "not asked again within a day");

  // The app starts again: still told, still newer, nothing asked.
  const again = s.make();
  await again.check();
  assert.equal(again.state().newer, "2631532");
  assert.equal(again.state().toldNewer, true);
  assert.equal(s.asked.length, 1);

  // A day later, another release: announced again.
  s.opts.latest = "2632001";
  s.advance(CHECK_EVERY_MS);
  await again.check();
  assert.equal(s.asked.length, 2);
  assert.equal(again.state().newer, "2632001");
  assert.equal(again.state().toldNewer, false);

  // The person installed it: nothing newer.
  s.opts.installed = "2632001";
  await again.check();
  assert.equal(again.state().newer, null);
});

test("offline, the last answer still counts and the releases are asked at the next check", async () => {
  const s = setup({ source: "github", installed: "2631524", latest: "2631532" });
  await s.make().check();
  s.opts.latest = "down";
  s.advance(CHECK_EVERY_MS);
  const u = s.make();
  await u.check();
  assert.equal(u.state().newer, "2631532");
  await u.check();
  assert.equal(s.asked.length, 3, "a failed check is retried, not counted as checked");
});

test("a clock set back doesn't stop the checks for good", async () => {
  const s = setup({ source: "github", installed: "2631524", latest: "2631524" });
  await s.make().check();
  s.advance(-5 * CHECK_EVERY_MS);
  await s.make().check();
  assert.equal(s.asked.length, 2);
});

test("apps from a store, F-Droid or an unknown source never ask the releases", async () => {
  for (const source of ["play", "fdroid", "appstore", null] as const) {
    const s = setup({ source, installed: "2631524", latest: "2631532" });
    const u = s.make();
    await u.check();
    assert.equal(s.asked.length, 0, String(source));
    assert.equal(u.state().newer, null);
    assert.equal(u.state().source, source);
  }
});

test("the server's need for a newer app is announced once per installed version", async () => {
  const s = setup({ source: "play", installed: "2631524", latest: null });
  const u = s.make();
  await u.check();
  assert.equal(u.state().toldNeeded, false);
  u.markTold("needed");
  await s.make().check();
  const v = s.make();
  await v.check();
  assert.equal(v.state().toldNeeded, true);
  s.opts.installed = "2632001";
  await v.check();
  assert.equal(v.state().toldNeeded, false, "updated, and still too old: said again");
});

test("a build without a version is never told to update", async () => {
  const s = setup({ source: "github", installed: null, latest: "2631532" });
  const u = s.make();
  await u.check();
  assert.equal(u.state().newer, null);
  u.markTold("needed");
  assert.equal(u.state().toldNeeded, false);
});

test("where the app came from is known before the releases answer", async () => {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v), remove: (k: string) => void kv.delete(k) };
  let answer: (v: string | null) => void = () => {};
  const u = createAppUpdates({
    source: async () => "github",
    installed: async () => "2631524",
    latest: () => new Promise((resolve) => { answer = resolve; }),
    store,
    now: () => CHECK_EVERY_MS * 10,
  });
  assert.equal(u.state().known, false, "nothing is announced before the phone has said");
  const done = u.check();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual({ known: u.state().known, source: u.state().source, installed: u.state().installed }, { known: true, source: "github", installed: "2631524" });
  u.markTold("needed");
  assert.equal(u.state().toldNeeded, true, "the installed version is there to remember it by");
  answer("2631532");
  await done;
  assert.equal(u.state().newer, "2631532");
});
