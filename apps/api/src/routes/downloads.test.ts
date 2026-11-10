import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { deviceMayUse } from "../connect/clients.ts";
import { applySyncBatch } from "../services/sync.ts";
import { listItems } from "../services/items.ts";
import { downloadsRouter } from "./downloads.ts";

const MB = 1024 * 1024;

async function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
  const ep = (n: number, url: string, length: number | null, publishedAt: string) =>
    entry("feed/1", { title: `Episode ${n}`, publishedAt, enclosures: [{ url, type: "audio/mpeg", length }] });
  applySyncBatch(app, p.engineUserId, batch([
    ep(1, "https://cdn.example.org/ep1.mp3", 40 * MB, "2026-11-01T00:00:00Z"),
    ep(2, "https://cdn.example.org/ep2.mp3", 30 * MB, "2026-11-02T00:00:00Z"),
    ep(3, "http://plain.example.org/ep3.mp3", 10 * MB, "2026-11-03T00:00:00Z"),
    ep(4, "https://cdn.example.org/ep4.m4a", null, "2026-11-04T00:00:00Z"),
  ]));
  const ids = Object.fromEntries(app.db.all<{ id: string; title: string }>("SELECT id, title FROM items").map((r) => [r.title.slice(-1), r.id]));
  app.db.run("UPDATE item_state SET workflow = 'toread' WHERE item_id <> ?", ids["4"]!);
  const server = await startTestServer(app, [downloadsRouter()]);
  const session = signIn(app, p.accountId);
  return { app, ids, session, base: server.base, close: async () => { await server.close(); cleanup(); } };
}

test("the plan: To read episodes by the shared rules, newest first, within the room left, never a plain-http file or one the device has", async (t) => {
  const s = await setup();
  t.after(s.close);
  const plan = (body: unknown) => call(s.app, s.base, "POST", "/api/downloads/plan", s.session, body);
  const req = { autoToRead: true, limitBytes: 100 * MB, usedBytes: 0, have: [] as string[] };
  const all = await plan(req);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.items.map((i: { id: string }) => i.id), [s.ids["2"], s.ids["1"]], "episode 3 is plain http, episode 4 isn't To read");
  assert.deepEqual(all.json.items[0], {
    id: s.ids["2"], expectedBytes: 30 * MB,
    media: { kind: "audio", url: "https://cdn.example.org/ep2.mp3", type: "audio/mpeg", declaredBytes: 30 * MB, file: "media.mp3" },
  });
  assert.deepEqual((await plan({ ...req, have: [s.ids["2"]] })).json.items.map((i: { id: string }) => i.id), [s.ids["1"]]);
  assert.deepEqual((await plan({ ...req, usedBytes: 50 * MB })).json.items.map((i: { id: string }) => i.id), [s.ids["2"]], "the 40 MB one no longer fits");
  assert.deepEqual((await plan({ ...req, autoToRead: false })).json.items, []);
  assert.equal((await plan({ ...req, limitBytes: -1 })).status, 400);
  assert.equal((await call(s.app, s.base, "POST", "/api/downloads/plan", null, req)).status, 401);
});

test("the phone app's token reaches the plan; the browser extension's doesn't", () => {
  assert.equal(deviceMayUse("mobile", "POST", "/api/downloads/plan"), true);
  assert.equal(deviceMayUse("extension", "POST", "/api/downloads/plan"), false);
});

test("the widget's To read list leaves out items of private sources, as notifications do", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Open feed", "feed/open");
  makeSource(app, p, "Members' feed", "feed/private", { isPrivate: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/open", { title: "Public piece" }), entry("feed/private", { title: "Members-only piece" })]));
  app.db.run("UPDATE item_state SET workflow = 'toread'");
  const list = (extra: { exceptPrivate?: "1" }) => listItems(app, p, { scope: "toread", filter: "active", sort: "newest", limit: 5, ...extra });
  assert.deepEqual(list({}).items.map((i) => i.title).sort(), ["Members-only piece", "Public piece"]);
  const widget = list({ exceptPrivate: "1" });
  assert.deepEqual(widget.items.map((i) => i.title), ["Public piece"]);
  assert.equal(widget.total, 1, "and the count matches what it shows");
});
