import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { newId } from "@purss/domain";
import type { EventMessage } from "@purss/domain";
import { makeOwner, makeTestApp } from "../testing.ts";
import { call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "./index.ts";

async function boot() {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { admin: true });
  const lib = seedLibrary(app, owner);
  const server = await startTestServer(app, extraRouters.api());
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, s: TestSession | null = session, headers?: Record<string, string>) =>
    call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body, { headers });
  return { app, owner, lib, session, api, base: server.base, close: async () => { await server.close(); cleanup(); } };
}

/** The status of an upload the server may answer before it has read all of it (fetch reports that as a reset). */
function statusOfUpload(app: { config: { publicOrigin: string } }, url: string, s: TestSession, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(url, { method: "PUT", headers: { origin: app.config.publicOrigin, cookie: s.cookie, "x-purss-csrf": s.csrf, "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end(payload);
  });
}

const now = () => new Date().toISOString();
const highlight = (body: string | null = null) => ({ kind: "highlight", quote: { exact: "Corrected text.", prefix: "", suffix: "" }, position: { start: 0, end: 15 }, target: null, body, updatedAt: now() });

test("annotations over HTTP: idempotent PUT, list, DELETE, and a live update for the account's other pages", async (t) => {
  const b = await boot();
  t.after(b.close);
  const item = b.lib.itemIds[0];
  const id = newId("ann");
  const events: EventMessage[] = [];
  b.app.events.on(`account:${b.owner.accountId}`, (m: EventMessage) => events.push(m));

  const body = highlight("first thought");
  const put = await b.api("PUT", `/api/items/${item}/annotations/${id}`, body);
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.applied, true);
  assert.equal(put.json.annotation.id, id);
  const replay = await b.api("PUT", `/api/items/${item}/annotations/${id}`, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.applied, false, "sending the same change twice is harmless");
  const list = await b.api("GET", `/api/items/${item}/annotations`);
  assert.deepEqual(list.json.annotations.map((a: { id: string; body: string }) => [a.id, a.body]), [[id, "first thought"]]);
  assert.deepEqual(events, [{ type: "annotations", itemId: item }], "one event for the change, none for the replay");

  const del = await b.api("DELETE", `/api/items/${item}/annotations/${id}`, { updatedAt: now() });
  assert.deepEqual([del.status, del.json], [200, { annotation: null, applied: true }]);
  assert.equal((await b.api("DELETE", `/api/items/${item}/annotations/${id}`, { updatedAt: now() })).status, 200, "removing twice is fine");
  assert.deepEqual((await b.api("GET", `/api/items/${item}/annotations`)).json.annotations, []);
});

test("annotation routes need a session and the CSRF header, and refuse bad ids, bad bodies and oversized input", async (t) => {
  const b = await boot();
  t.after(b.close);
  const item = b.lib.itemIds[0];
  const path = `/api/items/${item}/annotations/${newId("ann")}`;
  assert.equal((await b.api("GET", `/api/items/${item}/annotations`, undefined, null)).status, 401);
  assert.equal((await b.api("PUT", path, highlight(), null)).status, 401);
  assert.equal((await b.api("PUT", path, highlight(), { ...b.session, csrf: "wrong" })).json.error.code, "csrf");
  assert.equal((await b.api("PUT", `/api/items/${item}/annotations/not-an-id`, highlight())).status, 400);
  assert.equal((await b.api("PUT", `/api/items/${item}/annotations/ann_ABCDEFGHJKMNPQRSTVWXYZ0123`, highlight())).status, 400, "ids are lower case");
  assert.equal((await b.api("PUT", path, { ...highlight(), updatedAt: "yesterday" })).status, 400);
  assert.equal((await b.api("PUT", path, { ...highlight(), quote: { exact: "   " } })).status, 400, "a highlight needs a passage");
  assert.equal((await b.api("PUT", path, { kind: "note", body: " \n ", updatedAt: now() })).status, 400, "a note needs words");
  assert.equal((await b.api("PUT", path, { ...highlight(), position: { start: 5, end: 5 } })).status, 400);
  assert.equal((await b.api("PUT", path, { kind: "note", body: "x".repeat(10_001), updatedAt: now() })).status, 400, "notes are bounded");
  assert.equal(await statusOfUpload(b.app, b.base + path, b.session, JSON.stringify({ kind: "note", body: "x".repeat(200_000), updatedAt: now() })), 413, "the request itself is bounded");
  assert.equal((await b.api("DELETE", path, {})).status, 400, "a removal says when it was made");
  assert.equal((await b.api("PUT", `/api/items/itm_missing/annotations/${newId("ann")}`, highlight())).status, 404);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM annotations")!.n, 0, "nothing was stored");
});

test("another account gets 404 for every annotation route on this PURSS's items", async (t) => {
  const b = await boot();
  t.after(b.close);
  const item = b.lib.itemIds[0];
  const id = newId("ann");
  assert.equal((await b.api("PUT", `/api/items/${item}/annotations/${id}`, highlight("mine"))).status, 200);
  const other = makeOwner(b.app, { admin: false });
  const s = signIn(b.app, other.accountId);
  assert.equal((await b.api("GET", `/api/items/${item}/annotations`, undefined, s)).status, 404);
  assert.equal((await b.api("PUT", `/api/items/${item}/annotations/${id}`, highlight("overwritten"), s)).status, 404);
  assert.equal((await b.api("PUT", `/api/items/${item}/annotations/${newId("ann")}`, highlight("added"), s)).status, 404);
  assert.equal((await b.api("DELETE", `/api/items/${item}/annotations/${id}`, { updatedAt: now() }, s)).status, 404);
  assert.deepEqual((await b.api("GET", `/api/items/${item}/annotations`)).json.annotations.map((a: { body: string }) => a.body), ["mine"]);
});
