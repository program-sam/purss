import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { MemoryOutboxStore, Outbox } from "../../annotations/outbox.ts";
import { unsentWrites } from "../../lib/unsent-writes.ts";
import { forgetDevice } from "./forget.ts";
import type { ForgetDeps } from "./forget.ts";

const copy = app.platform.forget;

/** This device's unsent highlights and notes, `count` of them, in memory. */
async function unsentNotes(count: number) {
  const notes = new Outbox(new MemoryOutboxStore());
  for (let i = 0; i < count; i++) await notes.record({ accountId: "acc_1", itemId: "itm_a", annotationId: `ann_${i}`, at: "2026-11-01T10:00:00.000Z", op: "delete" });
  return { notes, writes: unsentWrites({ notes, clearLate: () => undefined }) };
}

async function fakes(over: Partial<ForgetDeps> = {}, unsent = 3) {
  const device = await unsentNotes(unsent);
  const done: string[] = [];
  const deps: ForgetDeps = {
    stopAudio: async () => { done.push("audio"); },
    forgetConnection: async () => { done.push("token"); },
    wipeCopies: async () => { done.push("copies"); },
    unsent: device.writes,
    removeDownloads: async () => { done.push("downloads"); },
    stopBackground: async () => { done.push("background"); },
    forgetPush: async () => { done.push("push"); },
    clearHints: () => { done.push("hints"); },
    ...over,
  };
  return { deps, done, notes: device.notes };
}

test("a lost connection keeps the unsent highlights and notes and says so", async () => {
  const t = await fakes();
  const out = await forgetDevice(t.deps, "lost");
  assert.deepEqual([...new Set(t.done)].sort(), ["audio", "background", "copies", "downloads", "hints", "push", "token"]);
  assert.ok(t.done.indexOf("background") < t.done.indexOf("downloads"), "the background job is stopped before the downloads are removed, so a transfer can't move files back in");
  assert.ok(t.done.lastIndexOf("background") > t.done.indexOf("downloads"), "and again after, so nothing told it meanwhile outlives the wipe");
  assert.equal(out.stuck, false);
  assert.equal(out.notice, copy.lost(copy.unsentKept(3)));
});

test("disconnecting, which the person confirmed, removes the unsent highlights and notes and says nothing about them", async () => {
  for (const reason of ["disconnected", "unreachable"] as const) {
    const t = await fakes();
    const out = await forgetDevice(t.deps, reason);
    assert.equal(t.notes.snapshot().length, 0, reason);
    assert.equal(out.notice, reason === "disconnected" ? copy.disconnected : copy.unreachable, reason);
  }
});

test("when secure storage won't let go of the connection, the result says so instead of starting with it again", async () => {
  const t = await fakes({ forgetConnection: async () => { throw new Error("keystore"); } }, 1);
  const out = await forgetDevice(t.deps, "lost");
  assert.equal(out.stuck, true);
  assert.equal(out.notice, copy.lost(copy.unsentKept(1)) + copy.stuck);
  assert.ok(t.done.includes("copies"), "the rest is still removed");
});

test("the background job is stopped even when removing the downloads failed", async () => {
  const t = await fakes({ removeDownloads: async () => { throw new Error("busy"); } });
  await forgetDevice(t.deps, "disconnected");
  assert.ok(t.done.includes("background"));
});

test("every way of ending the connection removes the downloads, the background job and widget data, and the phone's notifications", async () => {
  for (const reason of ["disconnected", "unreachable", "lost"] as const) {
    const t = await fakes({ forgetPush: async () => { throw new Error("relay down"); } });
    await forgetDevice(t.deps, reason);
    for (const step of ["downloads", "background"]) assert.ok(t.done.includes(step), `${reason}: ${step}`);
  }
  const t = await fakes();
  await forgetDevice(t.deps, "lost");
  assert.ok(t.done.includes("push"), "a refused token also unregisters the phone's notifications");
});
