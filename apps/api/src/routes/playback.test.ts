import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { applySyncBatch } from "../services/sync.ts";
import { extraRouters } from "./index.ts";

async function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Episode one: the long wave", enclosures: [{ url: "https://cdn.example.org/ep1.mp3", type: "audio/mpeg", length: 5000 }] })]));
  const itemId = app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  const server = await startTestServer(app, extraRouters.api());
  const session = signIn(app, p.accountId);
  return { app, itemId, session, base: server.base, close: async () => { await server.close(); cleanup(); } };
}

test("a playback position is saved over HTTP for the owner only, and the routes for server-held media files no longer exist", async (t) => {
  const s = await setup();
  t.after(s.close);
  const url = `/api/items/${s.itemId}/playback`;
  const other = signIn(s.app, makeOwner(s.app).accountId);
  assert.equal((await call(s.app, s.base, "PUT", url, other, { positionSeconds: 3 })).status, 404, "another account sees nothing");

  const saved = await call(s.app, s.base, "PUT", url, s.session, { positionSeconds: 12.5, durationSeconds: 60 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.positionSeconds, 12.5);
  assert.equal((await call(s.app, s.base, "PUT", url, s.session, { positionSeconds: -1 })).status, 400);
  const stale = await call(s.app, s.base, "PUT", url, s.session, { positionSeconds: 5, durationSeconds: 60, recordedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.positionSeconds, 12.5, "a position recorded before the stored one doesn't replace it");
  assert.equal((await call(s.app, s.base, "PUT", url, s.session, { positionSeconds: 5, recordedAt: "yesterday" })).status, 400);

  for (const [method, path] of [["PUT", `/api/items/${s.itemId}/media`], ["DELETE", `/api/items/${s.itemId}/media`], ["GET", `/api/items/${s.itemId}/media`],
    ["GET", `/api/items/${s.itemId}/media/link`], ["GET", `/api/media/${s.itemId}/1/sig`], ["GET", "/api/export/media"]] as const) {
    assert.equal((await call(s.app, s.base, method, path, s.session)).status, 404, `${method} ${path}`);
  }
});
