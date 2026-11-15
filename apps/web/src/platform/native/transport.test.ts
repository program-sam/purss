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
    if (path === "/api/sources/src_1/icon") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } });
    if (path === "/api/sources/src_2/icon") return Response.json({ error: { code: "not_found" } }, { status: 404 });
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

test("a picture PURSS serves is fetched with the device token and shown from a copy of its own; anything that isn't a picture is not shown", async () => {
  const { t, seen } = setup();
  const icon = t.picture("/api/sources/src_1/icon?v=abc");
  assert.ok(icon instanceof Promise, "the page can't load PURSS's path itself");
  const url = await icon;
  assert.match(url, /^blob:/);
  assert.equal(seen[0]!.url, `${ORIGIN}/api/sources/src_1/icon?v=abc`);
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer purss_dev_secret");
  assert.equal(seen[0]!.credentials, "omit");
  assert.equal(t.picture("/api/sources/src_1/icon?v=abc"), url, "fetched once");
  assert.equal(seen.length, 1);
  URL.revokeObjectURL(url);
  await assert.rejects(Promise.resolve(t.picture("/api/sources/src_2/icon?v=abc")), "a missing icon leaves the initials");
  await assert.rejects(Promise.resolve(t.picture("/api/session")), "an answer that isn't a picture");
  assert.equal(t.picture("https://pub.example/art.jpg"), "https://pub.example/art.jpg", "a publisher's picture loads as it is");
  assert.ok(!seen.some((r) => r.url.startsWith("https://pub.example")), "and is never fetched with the token");
});

test("a picture stays on the device: after the app starts again it shows without a connection, and it goes with the account", async () => {
  const backend = new MemoryCopyBackend();
  const icon = "/api/sources/src_1/icon?v=abc";
  const start = (fetch: (r: Request) => Promise<Response>) => {
    const worker = new OfflineWorker({ caches: new StoredCaches(backend), fetch, now: () => 0, origin: ORIGIN, build: "app" });
    return { worker, t: createAppTransport({ origin: ORIGIN, token: "purss_dev_secret", worker, downloaded: null, fetch, onLost: () => undefined }) };
  };
  const online = start(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }));
  await online.worker.message({ type: "state", accountId: "acc_1", enabled: true });
  URL.revokeObjectURL(await online.t.picture(icon));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await backend.urls("purss-pictures:acc_1"), [`${ORIGIN}${icon}`]);

  const offline = start(async () => { throw new TypeError("Failed to fetch"); });
  await offline.worker.message({ type: "state", accountId: "acc_1", enabled: true });
  const shown = await offline.t.picture(icon);
  assert.match(shown, /^blob:/, "shown from the device without the network");
  URL.revokeObjectURL(shown);
  await offline.worker.message({ type: "state", accountId: null, enabled: true });
  assert.deepEqual((await backend.names()).filter((n) => n.startsWith("purss-pictures:")), [], "nobody signed in: no pictures stay");
});
