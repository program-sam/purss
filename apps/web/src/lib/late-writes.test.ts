import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLateWrites, lateStore } from "./late-writes.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

test("another account signing in deletes the other accounts' positions and progress and nothing else on the device", () => {
  const storage = memoryStorage();
  for (const account of ["acc_1", "acc_2"]) {
    lateStore<number>("progress", account, storage).put("itm_a", 0.5);
    lateStore<number>("playback", account, storage).put("itm_b", 12);
  }
  storage.setItem("purss-display", "eink");
  clearLateWrites(storage, "acc_2");
  assert.deepEqual(Object.keys(lateStore("progress", "acc_1", storage).all()), []);
  assert.deepEqual(Object.keys(lateStore("playback", "acc_1", storage).all()), []);
  assert.deepEqual(lateStore<number>("progress", "acc_2", storage).all(), { itm_a: 0.5 });
  assert.deepEqual(lateStore<number>("playback", "acc_2", storage).all(), { itm_b: 12 });
  assert.equal(storage.getItem("purss-display"), "eink");
  clearLateWrites(storage);
  assert.equal(storage.length, 1, "without an account to keep, every account's goes");
});
