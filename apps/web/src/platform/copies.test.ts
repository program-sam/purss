import test from "node:test";
import assert from "node:assert/strict";
import { OfflineWorker } from "../sw/offline-worker.ts";
import { OFFLINE_HEADER } from "../sw/protocol.ts";
import { fakeNetwork, json } from "../sw/testing.ts";
import { MemoryCopyBackend, StoredCaches } from "./copies.ts";

const ORIGIN = "https://workspace.example";

test("stored caches answer like Cache Storage: open, put, match, keys, delete, has", async () => {
  const caches = new StoredCaches(new MemoryCopyBackend());
  assert.equal(await caches.has("a"), false);
  const a = await caches.open("a");
  assert.equal(await caches.has("a"), true, "opening makes an empty cache");
  await a.put(`${ORIGIN}/api/items/1`, json({ id: 1 }, { status: 200, headers: { "x-k": "v" } }));
  await a.put(new Request(`${ORIGIN}/api/items/2`), json({ id: 2 }));
  const hit = await a.match(new Request(`${ORIGIN}/api/items/1`));
  assert.deepEqual(await hit?.json(), { id: 1 });
  assert.equal(hit?.headers.get("x-k"), "v");
  assert.deepEqual((await a.match(`${ORIGIN}/api/items/1`))?.status, 200, "an answer can be read more than once");
  assert.deepEqual((await a.keys()).map((r) => r.url).sort(), [`${ORIGIN}/api/items/1`, `${ORIGIN}/api/items/2`]);
  assert.equal(await a.delete(`${ORIGIN}/api/items/2`), true);
  assert.equal(await a.match(`${ORIGIN}/api/items/2`), undefined);
  assert.deepEqual(await caches.keys(), ["a"]);
  assert.equal(await caches.delete("a"), true);
  assert.equal(await caches.has("a"), false);
  assert.equal(await (await caches.open("a")).match(`${ORIGIN}/api/items/1`), undefined, "deleting a cache deletes what was in it");
});

test("the offline worker keeps and serves copies in the apps' store the same way as in Cache Storage", async () => {
  const backend = new MemoryCopyBackend();
  const network = fakeNetwork();
  const worker = new OfflineWorker({ caches: new StoredCaches(backend), fetch: network.fetch, now: () => Date.parse("2026-11-05T10:00:00Z"), origin: ORIGIN, build: "app", networkTimeoutMs: 40 });
  network.routes.set("/api/session", () => json({ state: "signed_in", csrf: null, account: { id: "acc_1" }, installation: {} }));
  network.routes.set("/api/items/itm_1", () => json({ id: "itm_1", title: "Tide tables" }));
  const pending: Promise<unknown>[] = [];
  const get = async (path: string) => { const r = await worker.handle("api", new Request(`${ORIGIN}${path}`), (p) => pending.push(p)); await Promise.all(pending); return r; };

  await worker.message({ type: "state", accountId: "acc_1", enabled: true });
  await get("/api/session");
  assert.equal((await get("/api/items/itm_1")).headers.get(OFFLINE_HEADER), null, "a live answer");
  network.offline = true;
  const offline = await get("/api/items/itm_1");
  assert.deepEqual(await offline.json(), { id: "itm_1", title: "Tide tables" });
  assert.equal(offline.headers.get(OFFLINE_HEADER), "2026-11-05T10:00:00.000Z", "marked as this device's copy");
  assert.ok(backend.stores.has("purss-api:acc_1"));

  await worker.message({ type: "state", accountId: "acc_1", enabled: false });
  assert.ok(!backend.stores.has("purss-api:acc_1"), "turning offline reading off removes the copies");
  await assert.rejects(get("/api/items/itm_1"));
});
