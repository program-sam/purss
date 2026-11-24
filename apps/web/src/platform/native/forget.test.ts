import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { MemoryOutboxStore, Outbox } from "../../annotations/outbox.ts";
import { unsentWrites } from "../../lib/unsent-writes.ts";
import { forgetDevice } from "./forget.ts";
import type { ForgetDeps } from "./forget.ts";

const copy = app.platform.forget;

/** This device's unsent highlights and notes, `count` of them, and `late` unsent positions and progress, in memory. */
async function unsentNotes(count: number, late = 0) {
  const notes = new Outbox(new MemoryOutboxStore());
  for (let i = 0; i < count; i++) await notes.record({ accountId: "acc_1", itemId: "itm_a", annotationId: `ann_${i}`, at: "2026-11-01T10:00:00.000Z", op: "delete" });
  let heldLate = late;
  const clears: string[] = [];
  const writes = unsentWrites({
    notes,
    late: { count: () => heldLate, clear: () => { heldLate = 0; clears.push("late"); } },
    changes: { countAll: async () => 0, clearAll: async () => { clears.push("changes"); } },
  });
  return { notes, writes, clears };
}

async function fakes(over: Partial<ForgetDeps> = {}, unsent = 3, late = 0) {
  const device = await unsentNotes(unsent, late);
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
  return { deps, done, notes: device.notes, clears: device.clears };
}

test("a lost connection keeps the unsent highlights and notes and says so", async () => {
  const t = await fakes();
  const out = await forgetDevice(t.deps, "lost");
  assert.deepEqual(t.clears, ["changes"], "only the changes to items go");
  assert.deepEqual([...new Set(t.done)].sort(), ["audio", "background", "copies", "downloads", "hints", "push", "token"]);
  assert.ok(t.done.indexOf("background") < t.done.indexOf("downloads"), "the background job is stopped before the downloads are removed, so a transfer can't move files back in");
  assert.ok(t.done.lastIndexOf("background") > t.done.indexOf("downloads"), "and again after, so nothing told it meanwhile outlives the wipe");
  assert.equal(out.stuck, false);
  assert.equal(out.notice, copy.lost(copy.unsentKept(3, 0)));
});

test("a lost connection says that unsent positions and progress stay too, with the highlights and notes or without them", async () => {
  const both = await fakes({}, 3, 2);
  assert.equal((await forgetDevice(both.deps, "lost")).notice, copy.lost(copy.unsentKept(3, 2)));
  const onlyLate = await fakes({}, 0, 2);
  assert.equal((await forgetDevice(onlyLate.deps, "lost")).notice, copy.lost(copy.unsentKept(0, 2)));
  const nothing = await fakes({}, 0, 0);
  assert.equal((await forgetDevice(nothing.deps, "lost")).notice, copy.lost(""), "nothing kept, nothing said");
  assert.notEqual(copy.unsentKept(0, 2), copy.unsentKept(2, 0), "positions and progress are named as such, not counted as highlights or notes");
  assert.ok(copy.unsentKept(3, 2).includes("3") && copy.unsentKept(3, 2).includes("2"), "each kind is counted");
});

test("disconnecting, which the person confirmed, removes the unsent highlights and notes and says nothing about them", async () => {
  for (const reason of ["disconnected", "unreachable"] as const) {
    const t = await fakes({}, 3, 2);
    const out = await forgetDevice(t.deps, reason);
    assert.equal(t.notes.snapshot().length, 0, reason);
    assert.deepEqual(t.clears, ["late", "changes"], `${reason}: the positions, progress and changes to items go too`);
    assert.equal(out.notice, reason === "disconnected" ? copy.disconnected : copy.unreachable, reason);
  }
});

test("when secure storage won't let go of the connection, the result says so instead of starting with it again", async () => {
  const t = await fakes({ forgetConnection: async () => { throw new Error("keystore"); } }, 1);
  const out = await forgetDevice(t.deps, "lost");
  assert.equal(out.stuck, true);
  assert.equal(out.notice, copy.lost(copy.unsentKept(1, 0)) + copy.stuck);
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
