import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryOutboxStore, Outbox } from "../annotations/outbox.ts";
import { clearLateWrites, lateStore } from "./late-writes.ts";
import { unsentWrites } from "./unsent-writes.ts";
import type { UnsentReason } from "./unsent-writes.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

const ACCOUNTS = ["acc_1", "acc_2"];

/** Two accounts, each with an unsent highlight or note, a playback position and reading progress, on this device's in-memory stores. */
async function device() {
  const noteStore = new MemoryOutboxStore();
  const notes = new Outbox(noteStore);
  const storage = memoryStorage();
  for (const accountId of ACCOUNTS) {
    await notes.record({ accountId, itemId: "itm_a", annotationId: `ann_${accountId}`, at: "2026-11-01T10:00:00.000Z", op: "delete" });
    lateStore<number>("progress", accountId, storage).put("itm_a", 0.5);
    lateStore<{ positionSeconds: number }>("playback", accountId, storage).put("itm_b", { positionSeconds: 42 });
  }
  const writes = unsentWrites({ notes, clearLate: () => clearLateWrites(storage) });
  /** What is on the device now, read the way a fresh start reads it. */
  const found = async () => {
    const restarted = new Outbox(noteStore);
    await restarted.load();
    return {
      notes: ACCOUNTS.map((a) => restarted.snapshot().filter((e) => e.accountId === a).length),
      progress: ACCOUNTS.map((a) => Object.keys(lateStore("progress", a, storage).all()).length),
      positions: ACCOUNTS.map((a) => Object.keys(lateStore("playback", a, storage).all()).length),
    };
  };
  return { writes, notes, storage, found };
}

const GONE = { notes: [0, 0], progress: [0, 0], positions: [0, 0] };
const STAY = { notes: [1, 1], progress: [1, 1], positions: [1, 1] };

// Every account's, whichever one is signed in: a browser may be shared, and a phone that is let go keeps nothing of its accounts but
// the person's own unsent writing. The item-change queue is not part of this (see unsent-writes.ts).
const RULE: Record<UnsentReason, { left: typeof GONE; keptNotes: number }> = {
  "signed-out": { left: GONE, keptNotes: 0 },
  disconnected: { left: GONE, keptNotes: 0 },
  unreachable: { left: GONE, keptNotes: 0 },
  lost: { left: STAY, keptNotes: 2 },
};

for (const [reason, rule] of Object.entries(RULE) as [UnsentReason, (typeof RULE)[UnsentReason]][]) {
  test(`${reason}: highlights, notes, positions and progress of every account ${rule.left === STAY ? "stay" : "are deleted"}`, async () => {
    const d = await device();
    assert.deepEqual(await d.found(), STAY, "the fixture starts with everything unsent");
    const forgotten = await d.writes.forget(reason);
    assert.deepEqual(await d.found(), rule.left);
    assert.equal(forgotten.keptNotes, rule.keptNotes);
    assert.equal(d.notes.snapshot().length, rule.keptNotes, "the page's own view agrees with the device");
  });
}

test("a connection PURSS ended counts the highlights and notes the device holds, not only those this page has read, failed ones too", async () => {
  const store = new MemoryOutboxStore();
  await store.save({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_x", at: "2026-11-01T10:00:00.000Z", op: "delete", status: "waiting" });
  await store.save({ accountId: "acc_2", itemId: "itm_a", annotationId: "ann_y", at: "2026-11-01T10:00:00.000Z", op: "delete", status: "failed", error: "refused" });
  const writes = unsentWrites({ notes: new Outbox(store), clearLate: () => undefined });
  assert.equal((await writes.forget("lost")).keptNotes, 2);
});

test("signing out deletes what another tab recorded after this page read the device", async () => {
  const store = new MemoryOutboxStore();
  const here = new Outbox(store);
  const otherTab = new Outbox(store);
  await here.load();
  await otherTab.record({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_late", at: "2026-11-01T10:00:00.000Z", op: "delete" });
  await unsentWrites({ notes: here, clearLate: () => undefined }).forget("signed-out");
  assert.deepEqual(await store.all(), []);
});

test("signing out fails, instead of going ahead with notes still on the device, when what the device holds can't be read to delete it", async () => {
  const store = new MemoryOutboxStore();
  let reads = 0;
  const flaky = { all: () => (++reads > 1 ? Promise.reject(new Error("storage unreadable")) : store.all()), save: (e: Parameters<typeof store.save>[0]) => store.save(e), remove: (s: readonly number[]) => store.remove(s) };
  const here = new Outbox(flaky);
  await here.load();
  await new Outbox(store).record({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_late", at: "2026-11-01T10:00:00.000Z", op: "delete" });
  await assert.rejects(unsentWrites({ notes: here, clearLate: () => undefined }).forget("signed-out"), /storage unreadable/);
  assert.equal((await store.all()).length, 1, "nothing was claimed deleted");
});

test("signing out deletes the positions and progress even when the highlights and notes could not be deleted, and says so", async () => {
  const storage = memoryStorage();
  lateStore<number>("progress", "acc_1", storage).put("itm_a", 0.5);
  const refusing = { clearAll: () => Promise.reject(new Error("storage refused")), load: () => Promise.resolve(), snapshot: () => [] };
  const writes = unsentWrites({ notes: refusing, clearLate: () => clearLateWrites(storage) });
  await assert.rejects(writes.forget("signed-out"), /storage refused/);
  assert.equal(storage.length, 0);
});
