import { test } from "node:test";
import assert from "node:assert/strict";
import { lateStore } from "../lib/late-writes.ts";
import { sendLateProgress, settleProgress } from "./late-progress.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

test("reading progress read offline is sent when the connection is back, only while it is ahead of the server's", async () => {
  const store = lateStore<number>("progress", "acc_1", memoryStorage());
  const server = new Map([["itm_a", { progress: 0.2, revision: 4 }], ["itm_b", { progress: 0.9, revision: 7 }]]);
  let online = false;
  const writes: [string, number, number][] = [];
  const deps = {
    store,
    read: async (id: string) => { if (!online) throw Object.assign(new Error("offline"), { status: 0, code: "offline" }); return server.get(id)!; },
    write: async (id: string, progress: number, rev: number) => { writes.push([id, progress, rev]); server.set(id, { progress, revision: rev + 1 }); },
    worthRetrying: (err: unknown) => (err as { code?: string }).code === "offline",
  };
  // Read offline: item a to 60 %, item b to 50 % (another device already read it to 90 %).
  store.put("itm_a", 0.6);
  store.put("itm_b", 0.5);
  await sendLateProgress(deps);
  assert.deepEqual(writes, [], "nothing goes while offline");
  assert.deepEqual(store.all(), { itm_a: 0.6, itm_b: 0.5 }, "and nothing is lost");
  online = true;
  await sendLateProgress(deps);
  assert.deepEqual(writes, [["itm_a", 0.6, 4]], "sent against the current revision; the server's larger progress stays");
  assert.equal(server.get("itm_b")!.progress, 0.9);
  assert.deepEqual(store.all(), {});
});

test("a write PURSS refuses for good is dropped; a conflict is read again next time; a later send settles what waits", async () => {
  const store = lateStore<number>("progress", "acc_1", memoryStorage());
  store.put("gone", 0.5);
  store.put("busy", 0.5);
  let conflict = true;
  await sendLateProgress({
    store,
    read: async (id) => { if (id === "gone") throw Object.assign(new Error("not found"), { status: 404, code: "not_found" }); return { progress: 0, revision: 1 }; },
    write: async () => { if (conflict) throw Object.assign(new Error("changed"), { status: 409, code: "conflict" }); },
    worthRetrying: () => false,
  });
  assert.deepEqual(store.all(), { busy: 0.5 });
  conflict = false;
  settleProgress(store, "busy", 0.4);
  assert.deepEqual(store.all(), { busy: 0.5 }, "a smaller progress sent later doesn't settle a larger one");
  settleProgress(store, "busy", 0.7);
  assert.deepEqual(store.all(), {});
});
