import test from "node:test";
import assert from "node:assert/strict";
import { OfflineWorker } from "../../sw/offline-worker.ts";
import { NO_COPY_HEADER, OFFLINE_HEADER } from "../../sw/protocol.ts";
import { MemoryCopyBackend, StoredCaches } from "../copies.ts";
import { createAppTransport } from "./transport.ts";

const ORIGIN = "https://ws.example";

function setup(opts: { downloaded?: (path: string) => Promise<Response | null> } = {}) {
  const seen: Request[] = [];
  let offline = false;
  const fetch = async (r: Request) => {
    seen.push(r);
    if (offline) throw new TypeError("Failed to fetch");
    const path = new URL(r.url).pathname;
    if (path === "/api/session") return Response.json({ state: "signed_in", csrf: null, account: { id: "acc_1" }, installation: {} });
    if (path === "/api/gone") return Response.json({ error: { code: "device_signed_out" } }, { status: 401 });
    return Response.json({ path });
  };
  const worker = new OfflineWorker({ caches: new StoredCaches(new MemoryCopyBackend()), fetch, now: () => 0, origin: ORIGIN, build: "app", networkTimeoutMs: 40 });
  let lost = 0;
  const t = createAppTransport({ origin: ORIGIN, token: "purss_dev_secret", worker, downloaded: opts.downloaded ?? null, fetch, onLost: () => { lost++; } });
  return { t, seen, worker, goOffline: () => { offline = true; }, lost: () => lost };
}

test("every request goes to the connected PURSS with the device token, never cookies or the change token", async () => {
  const { t, seen } = setup();
  const res = await t.fetch("/api/baskets", { method: "POST", headers: { "x-purss-csrf": "c", "content-type": "application/json", [NO_COPY_HEADER]: "1" }, body: "{}" });
  assert.deepEqual(await res.json(), { path: "/api/baskets" });
  const r = seen[0]!;
  assert.equal(r.url, `${ORIGIN}/api/baskets`);
  assert.equal(r.headers.get("authorization"), "Bearer purss_dev_secret");
  assert.equal(r.headers.get("x-purss-csrf"), null);
  assert.equal(r.headers.get(NO_COPY_HEADER), null, "only headers PURSS's CORS rules allow");
  assert.equal(r.credentials, "omit");
});

test("reads are kept for offline use like the web's worker does, and a downloaded item answers when nothing else can", async () => {
  const downloaded = async (path: string) => (path === "/api/items/itm_9" ? new Response('{"id":"itm_9"}', { headers: { [OFFLINE_HEADER]: "2026-11-01T00:00:00Z" } }) : null);
  const { t, worker, goOffline } = setup({ downloaded });
  await worker.message({ type: "state", accountId: "acc_1", enabled: true });
  await t.fetch("/api/session", {});
  await t.fetch("/api/items/itm_1", {});
  await new Promise((r) => setTimeout(r, 5));
  goOffline();
  const copy = await t.fetch("/api/items/itm_1", {});
  assert.deepEqual(await copy.json(), { path: "/api/items/itm_1" });
  assert.ok(copy.headers.get(OFFLINE_HEADER));
  const dl = await t.fetch("/api/items/itm_9", {});
  assert.deepEqual(await dl.json(), { id: "itm_9" });
  await assert.rejects(t.fetch("/api/items/itm_2", {}), TypeError, "nothing kept: the usual offline failure");
  await assert.rejects(t.fetch("/api/items/itm_9", { method: "PUT", body: "{}" }), TypeError, "changes never come from a copy");
});

test("the event stream carries the token, and a disconnected device is told", async () => {
  const seen: Request[] = [];
  let lost = 0;
  const fetch = async (r: Request) => { seen.push(r); return Response.json({ error: { code: "device_signed_out", message: "x" } }, { status: 401 }); };
  const worker = { handle: async () => new Response("") };
  const t = createAppTransport({ origin: ORIGIN, token: "purss_dev_secret", worker, downloaded: null, fetch, onLost: () => { lost++; } });
  const stop = t.events(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(seen.length, 1, "no reconnecting after a refusal");
  assert.equal(seen[0]!.url, `${ORIGIN}/api/events`);
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer purss_dev_secret");
  assert.equal(lost, 1);
});

test("the device token never goes anywhere but the connected PURSS", async () => {
  const { t, seen } = setup();
  for (const elsewhere of ["https://other.example/api/items", "http://ws.example/api/items", "https://ws.example.evil.example/api/items", "https://ws.example:8443/api/items"]) {
    await assert.rejects(t.fetch(elsewhere, {}), TypeError, elsewhere);
  }
  assert.equal(seen.length, 0);
  await t.fetch(`${ORIGIN}/api/items`, {});
  await t.fetch("//other.example/api/items", {});
  assert.deepEqual(seen.map((r) => new URL(r.url).origin), [ORIGIN, ORIGIN], "a path, even one starting with //, stays on PURSS");
});
