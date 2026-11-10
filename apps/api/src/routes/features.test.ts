import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, PRIVATE_FEED_URL, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { parseArchive } from "../services/archive-format.ts";
import { applySyncBatch } from "../services/sync.ts";
import { createBasket } from "../services/collections.ts";
import { keepItem } from "../services/state.ts";
import { usedBytes } from "../services/storage.ts";

async function boot(env: Record<string, string> = {}, opts: { allocationBytes?: number | null } = {}) {
  const { app, cleanup } = makeTestApp(env);
  const owner = makeOwner(app, { admin: true, allocationBytes: opts.allocationBytes ?? null });
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, extra: { contentType?: string } = {}, s: TestSession | null = session) =>
    call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body, extra);
  return { app, owner, server, session, api, close: async () => { await server.close(); cleanup(); } };
}

test("export over HTTP streams a verifiable download with no secrets, and is audited", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const out = await b.api("GET", "/api/export");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type")!, /^application\/json/);
  assert.match(out.headers.get("content-disposition")!, /^attachment; filename="purss-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(out.headers.get("cache-control"), "no-store");
  const doc = parseArchive(JSON.parse(out.text));
  assert.equal(doc.items.length, 4);
  for (const leak of [PRIVATE_FEED_URL, "SUPERSECRETTOKEN123", "test-token", b.session.csrf, b.session.cookie.split("=")[1]!]) assert.ok(!out.text.includes(leak), `no ${leak.slice(0, 12)}…`);
  assert.equal(b.app.db.get("SELECT outcome FROM audit_events WHERE action = 'export'")!.outcome, "success");
  // The owner of one PURSS gets nothing of another's.
  const other = makeOwner(b.app, { admin: false });
  const otherDoc = JSON.parse((await b.api("GET", "/api/export", undefined, {}, signIn(b.app, other.accountId))).text);
  assert.deepEqual([otherDoc.items.length, otherDoc.sources.length, otherDoc.baskets.length], [0, 0, 0]);
});

test("import over HTTP: preview, apply, and a rejected over-limit apply", async (t) => {
  const a = await boot();
  const b = await boot();
  const small = await boot({}, { allocationBytes: 300 });
  t.after(async () => { await a.close(); await b.close(); await small.close(); });
  seedLibrary(a.app, a.owner);
  const archive = (await a.api("GET", "/api/export")).text;

  // Nothing, garbage and the wrong kind of JSON are all plain 400s.
  assert.equal((await b.api("POST", "/api/import/preview")).status, 400);
  const garbage = await b.api("POST", "/api/import/preview", "{ not json", { contentType: "text/plain" });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.json.error.code, "not_archive");
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" })).json.error.code, "not_archive");

  // The archive can be sent as JSON or as plain text.
  const preview = await b.api("POST", "/api/import/preview", archive, { contentType: "text/plain" });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.fits, true);
  assert.equal(preview.json.counts.items, 4);
  assert.ok(Array.isArray(preview.json.conflicts) && preview.json.omitted.length > 0);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0);
  const applied = await b.api("POST", "/api/import", { token: preview.json.token });
  assert.equal(applied.status, 200);
  assert.equal(applied.json.created.items, 4);
  assert.equal(applied.json.following, 1);
  assert.equal(applied.json.reconnectRequired, 1);
  assert.equal((await b.api("POST", "/api/import", { token: preview.json.token })).json.error.code, "expired", "a token is used once");

  // Too big for the account: refused with the storage message, nothing written, the file stays staged.
  const tooBig = await small.api("POST", "/api/import/preview", archive, { contentType: "application/json" });
  assert.equal(tooBig.json.fits, false);
  const refused = await small.api("POST", "/api/import", { token: tooBig.json.token });
  assert.equal(refused.status, 507);
  assert.equal(refused.json.error.code, "quota_full");
  assert.equal(small.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0);
  assert.equal(small.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_stages")!.n, 1);
  assert.equal(usedBytes(small.app, small.owner.accountId), 0);
});

test("OPML over HTTP: download lists public sources only; upload is previewed, never sent to the engine", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const out = await b.api("GET", "/api/opml");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type")!, /^text\/x-opml/);
  assert.equal(out.headers.get("x-purss-left-out"), "1");
  assert.ok(out.text.includes('xmlUrl="https://example.org/feed/1.xml"') && !out.text.includes("Secret Garden") && !out.text.includes("SUPERSECRET"));

  const preview = await b.api("POST", "/api/opml/preview", out.text, { contentType: "text/x-opml" });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.feeds.map((f: any) => [f.title, f.alreadyFollowing]), [["Sediment Letters", true]]);
  const asJson = await b.api("POST", "/api/opml/preview", { opml: '<opml><body><outline text="New" xmlUrl="https://new.example/rss"/></body></opml>' });
  assert.deepEqual(asJson.json.feeds.map((f: any) => [f.feedUrl, f.alreadyFollowing]), [["https://new.example/rss", false]]);
  assert.equal((await b.api("POST", "/api/opml/preview", "<html/>", { contentType: "text/xml" })).json.error.code, "not_opml");
  assert.equal((await b.api("POST", "/api/opml/preview")).status, 400);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 0);
});

test("reminders over HTTP: today's anniversary, hide, and the plain DTO shape", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Sediment Letters", "feed/1");
  applySyncBatch(b.app, b.owner.engineUserId, batch([entry("feed/1", { title: "Four years ago today" })]));
  const id = b.app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  const basket = createBasket(b.app, b.owner, { name: "Keepers", captureMode: "metadata" }).id;
  keepItem(b.app, b.owner, id, basket);
  const now = new Date();
  b.app.db.run("UPDATE basket_items SET kept_at = ?", new Date(Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), now.getUTCDate(), 12)).toISOString());

  const list = await b.api("GET", "/api/reminders");
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ["basketName", "captureLabel", "id", "itemId", "keptAt", "sourceTitle", "title"]);
  assert.equal(list.json[0].title, "Four years ago today");
  assert.equal((await b.api("POST", `/api/reminders/${list.json[0].id}`, { action: "explode" })).status, 400);
  assert.equal((await b.api("POST", "/api/reminders/rem_nope", { action: "hide" })).status, 404);
  assert.equal((await b.api("POST", `/api/reminders/${list.json[0].id}`, { action: "hide" })).status, 200);
  assert.deepEqual((await b.api("GET", "/api/reminders")).json, []);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")!.n, 1);
});

test("reconciliation routes: literal path is not read as an id, and unknown entries are 404", async (t) => {
  const b = await boot();
  t.after(b.close);
  assert.deepEqual((await b.api("GET", "/api/reconcile")).json, { entries: [], total: 0, suggestedMatches: 0 });
  assert.deepEqual((await b.api("POST", "/api/reconcile/accept-suggested", {})).json, { matched: 0, skipped: 0, remaining: 0 });
  assert.equal((await b.api("POST", "/api/reconcile/rec_nope", { action: "dismiss" })).status, 404);
  assert.equal((await b.api("POST", "/api/reconcile/rec_nope", { action: "merge" })).status, 400);
});
