import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { MemoryOutboxStore, Outbox } from "../annotations/outbox.ts";
import { scopeOf } from "../outbox/entries.ts";
import { Outbox as ChangeOutbox } from "../outbox/outbox.ts";
import type { Sender } from "../outbox/outbox.ts";
import { MemoryStore } from "../outbox/store.ts";
import { clearLateWrites, countLateWrites, lateStore } from "./late-writes.ts";
import { unsentWrites, unsentTotal } from "./unsent-writes.ts";
import type { UnsentReason } from "./unsent-writes.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

const ACCOUNTS = ["acc_1", "acc_2"];
const INSTALLATION = "https://purss.test";
const offline = { status: 0, code: "offline", message: "Can't reach PURSS right now." };

/** PURSS cannot be reached: every change a test makes stays on the device. */
const unreachable: Sender = {
  workflow: () => Promise.reject(offline),
  keep: () => Promise.reject(offline),
  clearNew: () => Promise.reject(offline),
  workflowOf: () => Promise.reject(offline),
};

/** An outbox for changes to items, as one page of the app has it, over the device's `store`. */
function changeOutbox(store: MemoryStore) {
  return new ChangeOutbox({ store, sender: unreachable, installation: INSTALLATION, online: () => false, schedule: () => () => undefined });
}

/** A change to an item, waiting to be sent. */
const change = (itemId: string) => ({ kind: "workflow", itemId, from: "undecided", to: "toread", revision: 5 }) as const;

/**
 * Two accounts, each with an unsent highlight or note, a playback position, reading progress and a change to an item, on this
 * device's in-memory stores. The page has the second account signed in: the first account's change to an item is set aside on disk.
 */
async function device() {
  const noteStore = new MemoryOutboxStore();
  const notes = new Outbox(noteStore);
  const storage = memoryStorage();
  const changeStore = new MemoryStore();
  const changes = changeOutbox(changeStore);
  for (const accountId of ACCOUNTS) {
    await notes.record({ accountId, itemId: "itm_a", annotationId: `ann_${accountId}`, at: "2026-11-01T10:00:00.000Z", op: "delete" });
    lateStore<number>("progress", accountId, storage).put("itm_a", 0.5);
    lateStore<{ positionSeconds: number }>("playback", accountId, storage).put("itm_b", { positionSeconds: 42 });
    changes.setAccount(accountId);
    await changes.submit(change("itm_a"));
  }
  const writes = unsentWrites({ notes, late: { count: () => countLateWrites(storage), clear: () => clearLateWrites(storage) }, changes });
  /** What is on the device now, read the way a fresh start reads it. */
  const found = async () => {
    const restarted = new Outbox(noteStore);
    await restarted.load();
    return {
      notes: ACCOUNTS.map((a) => restarted.snapshot().filter((e) => e.accountId === a).length),
      progress: ACCOUNTS.map((a) => Object.keys(lateStore("progress", a, storage).all()).length),
      positions: ACCOUNTS.map((a) => Object.keys(lateStore("playback", a, storage).all()).length),
      changes: await Promise.all(ACCOUNTS.map(async (a) => (await changeStore.load(scopeOf(INSTALLATION, a))).length)),
    };
  };
  return { writes, notes, changes, changeStore, noteStore, storage, found };
}

const GONE = { notes: [0, 0], progress: [0, 0], positions: [0, 0], changes: [0, 0] };
const STAY = { notes: [1, 1], progress: [1, 1], positions: [1, 1], changes: [1, 1] };
/** Everything stays except the changes to items. */
const WRITING_STAYS = { ...STAY, changes: [0, 0] };

// Every account's, whichever one is signed in: a browser may be shared, and a phone that is let go keeps nothing of its accounts but
// the person's own unsent writing. Changes to items are not that: the apps forget them whenever they stop being connected, and
// signing out leaves them to its own question (outbox/sign-out.ts), so this rule leaves them.
const RULE: Record<UnsentReason, { left: typeof STAY; keptNotes: number; keptLate: number }> = {
  "signed-out": { left: { ...GONE, changes: [1, 1] }, keptNotes: 0, keptLate: 0 },
  disconnected: { left: GONE, keptNotes: 0, keptLate: 0 },
  unreachable: { left: GONE, keptNotes: 0, keptLate: 0 },
  lost: { left: WRITING_STAYS, keptNotes: 2, keptLate: 4 },
};

for (const [reason, rule] of Object.entries(RULE) as [UnsentReason, (typeof RULE)[UnsentReason]][]) {
  test(`${reason}: the rule for the highlights, notes, positions, progress and changes to items of every account`, async () => {
    const d = await device();
    assert.deepEqual(await d.found(), STAY, "the fixture starts with everything unsent");
    const forgotten = await d.writes.forget(reason);
    assert.deepEqual(await d.found(), rule.left);
    assert.equal(forgotten.keptNotes, rule.keptNotes);
    assert.equal(forgotten.keptLate, rule.keptLate);
    assert.equal(d.notes.snapshot().length, rule.keptNotes, "the page's own view of the notes agrees with the device");
    assert.equal(d.changes.pendingCount(), reason === "signed-out" ? 1 : 0, "and so does its view of the signed-in account's changes to items");
  });
}

test("a connection PURSS ended counts the highlights and notes the device holds, not only those this page has read, failed ones too", async () => {
  const store = new MemoryOutboxStore();
  await store.save({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_x", at: "2026-11-01T10:00:00.000Z", op: "delete", status: "waiting" });
  await store.save({ accountId: "acc_2", itemId: "itm_a", annotationId: "ann_y", at: "2026-11-01T10:00:00.000Z", op: "delete", status: "failed", error: "refused" });
  const writes = unsentWrites({ notes: new Outbox(store), late: { count: () => 0, clear: () => undefined }, changes: changeOutbox(new MemoryStore()) });
  assert.equal((await writes.forget("lost")).keptNotes, 2);
});

test("signing out deletes what another tab recorded after this page read the device", async () => {
  const store = new MemoryOutboxStore();
  const here = new Outbox(store);
  const otherTab = new Outbox(store);
  await here.load();
  await otherTab.record({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_late", at: "2026-11-01T10:00:00.000Z", op: "delete" });
  await unsentWrites({ notes: here, late: { count: () => 0, clear: () => undefined }, changes: changeOutbox(new MemoryStore()) }).forget("signed-out");
  assert.deepEqual(await store.all(), []);
});

test("signing out fails, instead of going ahead with notes still on the device, when what the device holds can't be read to delete it", async () => {
  const store = new MemoryOutboxStore();
  let reads = 0;
  const flaky = { all: () => (++reads > 1 ? Promise.reject(new Error("storage unreadable")) : store.all()), save: (e: Parameters<typeof store.save>[0]) => store.save(e), remove: (s: readonly number[]) => store.remove(s) };
  const here = new Outbox(flaky);
  await here.load();
  await new Outbox(store).record({ accountId: "acc_1", itemId: "itm_a", annotationId: "ann_late", at: "2026-11-01T10:00:00.000Z", op: "delete" });
  await assert.rejects(unsentWrites({ notes: here, late: { count: () => 0, clear: () => undefined }, changes: changeOutbox(new MemoryStore()) }).forget("signed-out"), /storage unreadable/);
  assert.equal((await store.all()).length, 1, "nothing was claimed deleted");
});

test("signing out deletes the positions and progress even when the highlights and notes could not be deleted, and says so", async () => {
  const storage = memoryStorage();
  lateStore<number>("progress", "acc_1", storage).put("itm_a", 0.5);
  const refusing = { clearAll: () => Promise.reject(new Error("storage refused")), count: () => Promise.resolve(0) };
  const writes = unsentWrites({ notes: refusing, late: { count: () => countLateWrites(storage), clear: () => clearLateWrites(storage) }, changes: changeOutbox(new MemoryStore()) });
  await assert.rejects(writes.forget("signed-out"), /storage refused/);
  assert.equal(storage.length, 0);
});

test("disconnecting removes the changes to items that another tab recorded, or another account left, after this page read the device", async () => {
  const d = await device();
  // Another tab of the app, signed in as a third account, has made a change this page has never read.
  const otherTab = changeOutbox(d.changeStore);
  otherTab.setAccount("acc_3");
  await otherTab.submit(change("itm_c"));
  assert.equal((await d.changeStore.load(scopeOf(INSTALLATION, "acc_3"))).length, 1);
  await d.writes.forget("disconnected");
  assert.equal(await d.changeStore.count(), 0, "nothing of any account is left on the device");
});

test("a failure to forget one queue does not stop the others, and is reported", async () => {
  const d = await device();
  const refusing = { clearAll: () => Promise.reject(new Error("storage refused")), countAll: () => Promise.resolve(0) };
  const writes = unsentWrites({ notes: d.notes, late: { count: () => countLateWrites(d.storage), clear: () => clearLateWrites(d.storage) }, changes: refusing });
  await assert.rejects(writes.forget("disconnected"), /storage refused/);
  assert.deepEqual(await d.found(), { ...GONE, changes: [1, 1] }, "the highlights, notes, positions and progress still went");
});

// What the person is warned about before disconnecting is what disconnecting removes: counted from the device, every account's.
test("the warning counts every account's highlights, notes, positions, progress and changes to items, and that is what disconnecting removes", async () => {
  const d = await device();
  assert.deepEqual(await d.writes.count(), { notes: 2, late: 4, changes: 2 });
  assert.equal(unsentTotal(await d.writes.count()), 8);
  await d.writes.forget("disconnected");
  assert.deepEqual(await d.writes.count(), { notes: 0, late: 0, changes: 0 }, "nothing it counted is left");
});

test("the warning counts what another tab recorded since this page read the device, and the changes to items another account left", async () => {
  const d = await device();
  await new Outbox(d.noteStore).record({ accountId: "acc_3", itemId: "itm_z", annotationId: "ann_z", at: "2026-11-01T10:00:00.000Z", op: "delete" });
  const otherTab = changeOutbox(d.changeStore);
  otherTab.setAccount("acc_3");
  await otherTab.submit(change("itm_c"));
  assert.deepEqual(await d.writes.count(), { notes: 3, late: 4, changes: 3 });
});

test("the warning for a device with nothing unsent counts nothing", async () => {
  const writes = unsentWrites({ notes: new Outbox(new MemoryOutboxStore()), late: { count: () => countLateWrites(memoryStorage()), clear: () => undefined }, changes: changeOutbox(new MemoryStore()) });
  assert.equal(unsentTotal(await writes.count()), 0);
});

test("the words of the warning count each kind the device holds, name only those, and agree with the question asked at Disconnect", () => {
  const t = app.downloads.deviceTab;
  const counts = { notes: 2, late: 3, changes: 4 };
  for (const text of [t.unsyncedWarning(counts), t.unsyncedLost(counts)]) for (const n of ["2", "3", "4"]) assert.ok(text.includes(n), `${n} in ${text}`);
  const onlyNotes = { notes: 1, late: 0, changes: 0 };
  const onlyLate = { notes: 0, late: 1, changes: 0 };
  const onlyChanges = { notes: 0, late: 0, changes: 1 };
  assert.equal(new Set([onlyNotes, onlyLate, onlyChanges].map((c) => t.unsyncedWarning(c))).size, 3, "each kind has words of its own");
  assert.ok(t.disconnectConfirm(t.unsyncedLost(counts)).includes(t.unsyncedLost(counts)), "the question carries the same count");
});
