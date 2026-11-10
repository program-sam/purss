import test from "node:test";
import assert from "node:assert/strict";
import { forgetDevice } from "./forget.ts";
import type { ForgetDeps } from "./forget.ts";

function fakes(over: Partial<ForgetDeps> = {}) {
  const done: string[] = [];
  const deps: ForgetDeps = {
    stopAudio: async () => { done.push("audio"); },
    forgetConnection: async () => { done.push("token"); },
    wipeCopies: async () => { done.push("copies"); },
    clearOutbox: async () => { done.push("outbox"); },
    removeDownloads: async () => { done.push("downloads"); },
    stopBackground: async () => { done.push("background"); },
    forgetPush: async () => { done.push("push"); },
    clearHints: () => { done.push("hints"); },
    unsent: async () => 3,
    ...over,
  };
  return { deps, done };
}

test("a lost connection keeps the unsent highlights and notes and says so", async () => {
  const t = fakes();
  const out = await forgetDevice(t.deps, "lost");
  assert.deepEqual([...new Set(t.done)].sort(), ["audio", "background", "copies", "downloads", "hints", "push", "token"]);
  assert.ok(t.done.indexOf("background") < t.done.indexOf("downloads"), "the background job is stopped before the downloads are removed, so a transfer can't move files back in");
  assert.ok(t.done.lastIndexOf("background") > t.done.indexOf("downloads"), "and again after, so nothing told it meanwhile outlives the wipe");
  assert.equal(out.stuck, false);
  assert.match(out.notice, /Your 3 unsent highlights and notes stay on this device and are sent when you connect again with the same account/);
});

test("disconnecting, which the person confirmed, removes the outbox too", async () => {
  for (const reason of ["disconnected", "unreachable"] as const) {
    const t = fakes();
    const out = await forgetDevice(t.deps, reason);
    assert.ok(t.done.includes("outbox"), reason);
    assert.doesNotMatch(out.notice, /unsent/);
  }
});

test("when secure storage won't let go of the connection, the result says so instead of starting with it again", async () => {
  const t = fakes({ forgetConnection: async () => { throw new Error("keystore"); }, unsent: async () => 1 });
  const out = await forgetDevice(t.deps, "lost");
  assert.equal(out.stuck, true);
  assert.match(out.notice, /old connection couldn't be removed/);
  assert.match(out.notice, /Your unsent highlight or note stays/);
  assert.ok(t.done.includes("copies"), "the rest is still removed");
});

test("the background job is stopped even when removing the downloads failed", async () => {
  const t = fakes({ removeDownloads: async () => { throw new Error("busy"); } });
  await forgetDevice(t.deps, "disconnected");
  assert.ok(t.done.includes("background"));
});

test("every way of ending the connection removes the downloads, the background job and widget data, and the phone's notifications", async () => {
  for (const reason of ["disconnected", "unreachable", "lost"] as const) {
    const t = fakes({ forgetPush: async () => { throw new Error("relay down"); } });
    await forgetDevice(t.deps, reason);
    for (const step of ["downloads", "background"]) assert.ok(t.done.includes(step), `${reason}: ${step}`);
  }
  const t = fakes();
  await forgetDevice(t.deps, "lost");
  assert.ok(t.done.includes("push"), "a refused token also unregisters the phone's notifications");
});
