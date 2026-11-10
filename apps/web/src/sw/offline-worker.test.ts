import test from "node:test";
import assert from "node:assert/strict";
import { OfflineWorker } from "./offline-worker.ts";
import { MAX_COPIES, OFFLINE_HEADER, SAVED_HEADER } from "./protocol.ts";
import { FakeCache, json, makeEnv, waiter } from "./testing.ts";
import type { Env } from "./offline-worker.ts";
import { ORIGIN, req } from "./testing.ts";

const signedIn = (id: string) => json({ state: "signed_in", csrf: "c", account: { id }, installation: {} });
const signedOut = () => json({ state: "signed_out", csrf: null, account: null, installation: {} });
const on = (accountId: string | null = "acc_1", enabled = true) => ({ type: "state", accountId, enabled }) as const;

function setup(over: Partial<Env> = {}) {
  const t = makeEnv(over);
  const worker = new OfflineWorker(t.env);
  const w = waiter();
  const get = async (path: string, kind: "api" | "navigation" | "static" = "api", init?: RequestInit) => {
    const res = await worker.handle(kind, req(path, init), w.wait);
    await w.settle();
    return res;
  };
  return { ...t, worker, w, get };
}
const dataCache = (t: { caches: { stores: Map<string, FakeCache> } }, account = "acc_1") => t.caches.stores.get(`purss-api:${account}`);

test("install saves every listed file under the build's shell cache and fails as a whole when one is missing", async () => {
  const t = setup();
  for (const p of ["/app/index.html", "/app/assets/a.js", "/app/manifest.webmanifest"]) t.network.routes.set(p, () => new Response("x"));
  await t.worker.install(["/app/index.html", "/app/assets/a.js", "/app/manifest.webmanifest"]);
  assert.deepEqual([...t.caches.stores.get("purss-shell:b1")!.entries.keys()].sort(), [`${ORIGIN}/app/assets/a.js`, `${ORIGIN}/app/index.html`, `${ORIGIN}/app/manifest.webmanifest`]);
  await assert.rejects(t.worker.install(["/app/index.html", "/app/assets/missing.js"]), /missing\.js/);
});

test("activating drops older builds' shells and every foreign account's copies, and keeps the rest", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  for (const n of ["purss-shell:old", "purss-shell:b1", "purss-api:acc_1", "purss-api:acc_2"]) await t.caches.open(n);
  await t.worker.activate();
  const afterRestart = new OfflineWorker(t.env);
  await afterRestart.activate();
  assert.deepEqual(t.caches.names(), ["purss-api:acc_1", "purss-shell:b1", "purss-worker-state"]);
});

test("a restarted worker remembers the account and the setting, and forgets everything when it can't", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  await (await t.caches.open("purss-api:acc_1")).put(`${ORIGIN}/api/bootstrap`, json({ ok: 1 }));
  const restarted = new OfflineWorker(t.env);
  await restarted.activate();
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), ["purss-api:acc_1"]);
  (await t.caches.open("purss-worker-state")).entries.clear();
  const amnesiac = new OfflineWorker(t.env);
  await amnesiac.activate();
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("page loads: the network when it answers, the saved app page when it doesn't", async () => {
  const t = setup();
  t.network.routes.set("/app/index.html", () => new Response("<html>shell</html>", { headers: { "content-type": "text/html" } }));
  await t.worker.install(["/app/index.html"]);
  t.network.routes.set("/c/col_1", () => new Response("<html>live</html>"));
  assert.equal(await (await t.get("/c/col_1", "navigation")).text(), "<html>live</html>");
  t.network.offline = true;
  assert.equal(await (await t.get("/c/col_1", "navigation")).text(), "<html>shell</html>");
  t.network.offline = false;
  t.network.routes.set("/c/col_1", () => new Response("bad gateway", { status: 502 }));
  assert.equal(await (await t.get("/c/col_1", "navigation")).text(), "<html>shell</html>");
  t.network.routes.set("/c/col_1", () => new Promise((r) => setTimeout(() => r(new Response("slow")), 300)));
  assert.equal(await (await t.get("/c/col_1", "navigation")).text(), "<html>shell</html>");
});

test("a page load with no saved app page fails like a lost connection", async () => {
  const t = setup();
  t.network.offline = true;
  await assert.rejects(t.get("/", "navigation"), /Failed to fetch/);
});

test("built files come from the shell first and an unknown path's app page is never kept as a script", async () => {
  const t = setup();
  t.network.routes.set("/app/assets/a.js", () => new Response("code", { headers: { "content-type": "text/javascript" } }));
  await t.worker.install(["/app/assets/a.js"]);
  t.network.requests.length = 0;
  assert.equal(await (await t.get("/app/assets/a.js", "static")).text(), "code");
  assert.deepEqual(t.network.requests, []);
  t.network.routes.set("/app/assets/b.js", () => new Response("<html>app</html>", { headers: { "content-type": "text/html" } }));
  await t.get("/app/assets/b.js", "static");
  assert.equal(t.caches.stores.get("purss-shell:b1")!.entries.has(`${ORIGIN}/app/assets/b.js`), false);
  t.network.routes.set("/app/assets/c.css", () => new Response("css", { headers: { "content-type": "text/css" } }));
  await t.get("/app/assets/c.css", "static");
  assert.equal(t.caches.stores.get("purss-shell:b1")!.entries.has(`${ORIGIN}/app/assets/c.css`), true);
});

test("nothing is kept while offline reading is off", async () => {
  const t = setup();
  t.network.routes.set("/api/bootstrap", () => json({ sources: [] }));
  await t.worker.message(on("acc_1", false));
  assert.equal((await t.get("/api/bootstrap")).headers.get(OFFLINE_HEADER), null);
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("nothing but the session answer is kept before an account is known", async () => {
  const t = setup();
  t.network.routes.set("/api/bootstrap", () => json({ sources: [] }));
  t.network.routes.set("/api/session", () => signedIn("acc_1"));
  await t.worker.message(on(null, true));
  await t.get("/api/bootstrap");
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
  await t.get("/api/session");
  assert.deepEqual([...dataCache(t)!.entries.keys()], [`${ORIGIN}/api/session`]);
  await t.get("/api/bootstrap");
  assert.ok(dataCache(t)!.entries.has(`${ORIGIN}/api/bootstrap`));
});

test("good answers are kept for the account and served, marked with when they were saved, when the network is gone", async () => {
  const t = setup();
  t.network.routes.set("/api/items/itm_1", () => json({ id: "itm_1", contentHtml: "<p>Text</p>" }));
  await t.worker.message(on("acc_1"));
  const live = await t.get("/api/items/itm_1");
  assert.equal(live.headers.get(OFFLINE_HEADER), null);
  const savedAt = new Date(t.clock).toISOString();
  assert.equal(dataCache(t)!.entries.size, 1);

  t.tick(3_600_000);
  t.network.offline = true;
  const offline = await t.get("/api/items/itm_1");
  assert.equal(offline.headers.get(OFFLINE_HEADER), savedAt);
  assert.deepEqual(await offline.json(), { id: "itm_1", contentHtml: "<p>Text</p>" });
  assert.equal(offline.headers.get(SAVED_HEADER), savedAt);
  await assert.rejects(t.get("/api/items/never-saved"), /Failed to fetch/);
});

test("the saved session keeps who is signed in but not the page's change token", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/session", () => signedIn("acc_1"));
  const live = await (await t.get("/api/session")).json();
  assert.equal(live.csrf, "c", "the page gets the real token from the network");
  t.network.offline = true;
  const copy = await (await t.get("/api/session")).json();
  assert.equal(copy.csrf, null);
  assert.equal(copy.state, "signed_in");
  assert.equal(copy.account.id, "acc_1");
});

test("answers that aren't successful are never kept, and a server error falls back to the saved copy", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/items/a", () => json({ error: { code: "not_found" } }, { status: 404 }));
  t.network.routes.set("/api/items/b", () => json({ error: { code: "internal" } }, { status: 500 }));
  assert.equal((await t.get("/api/items/a")).status, 404);
  assert.equal((await t.get("/api/items/b")).status, 500);
  assert.equal(dataCache(t)?.entries.size ?? 0, 0);
  t.network.routes.set("/api/items/b", () => json({ id: "b" }));
  await t.get("/api/items/b");
  t.network.routes.set("/api/items/b", () => json({ error: { code: "internal" } }, { status: 500 }));
  const res = await t.get("/api/items/b");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get(OFFLINE_HEADER));
});

test("a slow network gets four seconds, then the saved copy answers and the late answer is kept for next time", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/items/a", () => json({ v: 1 }));
  await t.get("/api/items/a");
  t.tick(1000);
  t.network.routes.set("/api/items/a", () => new Promise((r) => setTimeout(() => r(json({ v: 2 })), 120)));
  const res = await t.get("/api/items/a");
  assert.deepEqual(await res.json(), { v: 1 });
  assert.ok(res.headers.get(OFFLINE_HEADER));
  t.network.offline = true;
  assert.deepEqual(await (await t.get("/api/items/a")).json(), { v: 2 });
});

test("a slow network with nothing saved is simply waited for", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/items/a", () => new Promise((r) => setTimeout(() => r(json({ v: 1 })), 120)));
  assert.deepEqual(await (await t.get("/api/items/a")).json(), { v: 1 });
  assert.equal(dataCache(t)!.entries.size, 1);
});

test("signing out, in the session answer or an expired-session error, wipes every account's copies", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/session", () => signedIn("acc_1"));
  t.network.routes.set("/api/bootstrap", () => json({ a: 1 }));
  await t.get("/api/session");
  await t.get("/api/bootstrap");
  assert.equal(dataCache(t)!.entries.size, 2);

  t.network.routes.set("/api/session", () => signedOut());
  assert.equal((await t.get("/api/session")).status, 200);
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
  t.network.routes.set("/api/session", () => signedIn("acc_1"));
  await t.get("/api/session");
  await t.get("/api/bootstrap");
  assert.equal(dataCache(t)!.entries.size, 2);

  t.network.routes.set("/api/bootstrap", () => json({ error: { code: "signed_out", message: "Please sign in again." } }, { status: 401 }));
  assert.equal((await t.get("/api/bootstrap")).status, 401);
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
  // …and nothing is kept again until a session answer names an account.
  t.network.routes.set("/api/bootstrap", () => json({ a: 2 }));
  await t.get("/api/bootstrap");
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("an unclaimed installation counts as signed out", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  await (await t.caches.open("purss-api:acc_1")).put(`${ORIGIN}/api/bootstrap`, json({}));
  t.network.routes.set("/api/session", () => json({ state: "unclaimed", csrf: null, account: null, installation: {} }));
  await t.get("/api/session");
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("another account signing in on this device never sees or keeps the first one's copies", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/bootstrap", () => json({ owner: 1 }));
  await t.get("/api/bootstrap");
  assert.ok(dataCache(t, "acc_1"));

  t.network.routes.set("/api/session", () => signedIn("acc_2"));
  await t.get("/api/session");
  assert.equal(dataCache(t, "acc_1"), undefined);
  assert.ok(dataCache(t, "acc_2")!.entries.has(`${ORIGIN}/api/session`));

  t.network.offline = true;
  await assert.rejects(t.get("/api/bootstrap"), /Failed to fetch/);
});

test("the page telling the worker who is signed in has the same effect", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  await (await t.caches.open("purss-api:acc_1")).put(`${ORIGIN}/api/bootstrap`, json({}));
  await t.worker.message(on("acc_2"));
  assert.equal(dataCache(t, "acc_1"), undefined);
  await (await t.caches.open("purss-api:acc_2")).put(`${ORIGIN}/api/bootstrap`, json({}));
  await t.worker.message(on(null));
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("turning offline reading off, and removing the copies, wipes them", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  t.network.routes.set("/api/bootstrap", () => json({ a: 1 }));
  await t.get("/api/bootstrap");
  await t.worker.message({ type: "wipe" });
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
  await t.get("/api/bootstrap");
  assert.equal(dataCache(t)!.entries.size, 1);
  await t.worker.message(on("acc_1", false));
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
  t.network.offline = true;
  await assert.rejects(t.get("/api/bootstrap"), /Failed to fetch/);
});

test("an answer that was on its way during a wipe is not kept afterwards", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  let release!: () => void;
  t.network.routes.set("/api/items/a", () => new Promise((r) => { release = () => r(json({ v: 1 })); }));
  const pending = t.get("/api/items/a");
  await new Promise((r) => setTimeout(r, 5));
  await t.worker.message({ type: "wipe" });
  release();
  assert.equal((await pending).status, 200);
  assert.deepEqual(t.caches.names().filter((n) => n.startsWith("purss-api")), []);
});

test("an answer for one account is not filed under another that signed in meanwhile", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  let release!: () => void;
  t.network.routes.set("/api/items/a", () => new Promise((r) => { release = () => r(json({ v: 1 })); }));
  const pending = t.get("/api/items/a");
  await new Promise((r) => setTimeout(r, 5));
  await t.worker.message(on("acc_2"));
  release();
  await pending;
  assert.equal(dataCache(t, "acc_2")?.entries.size ?? 0, 0);
  assert.equal(dataCache(t, "acc_1"), undefined);
});

test("the oldest copies are trimmed past the limit; the session and bootstrap stay", async () => {
  const t = setup();
  await t.worker.message(on("acc_1"));
  const cache = await t.caches.open("purss-api:acc_1");
  for (const p of ["/api/session", "/api/bootstrap"]) await cache.put(`${ORIGIN}${p}`, new Response("{}", { headers: { [SAVED_HEADER]: new Date(1).toISOString() } }));
  for (let i = 0; i < MAX_COPIES + 20; i++) await cache.put(`${ORIGIN}/api/items/old${i}`, new Response("{}", { headers: { [SAVED_HEADER]: new Date(1000 + i).toISOString() } }));
  t.network.routes.set("/api/items/fresh", () => json({ ok: 1 }));
  for (let i = 0; i < 25; i++) await t.get("/api/items/fresh");
  assert.equal(cache.entries.size, MAX_COPIES);
  assert.ok(cache.entries.has(`${ORIGIN}/api/session`) && cache.entries.has(`${ORIGIN}/api/bootstrap`));
  assert.ok(!cache.entries.has(`${ORIGIN}/api/items/old0`));
  assert.ok(cache.entries.has(`${ORIGIN}/api/items/old${MAX_COPIES + 19}`));
  assert.ok(cache.entries.has(`${ORIGIN}/api/items/fresh`));
});
