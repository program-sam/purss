import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { insertItem } from "../services/items.ts";
import type { NewItem } from "../services/items.ts";
import { createCollection } from "../services/collections.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { publicRouter } from "./public.ts";

async function boot() {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted" });
  const owner = makeOwner(app, { admin: false });
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, owner, server, close: async () => { await server.close(); cleanup(); } };
}
const visitColumns = (b: Awaited<ReturnType<typeof boot>>) =>
  b.app.db.get<{ a: string | null; b: string | null; c: string | null }>("SELECT last_visit_at AS a, visit_started_at AS b, last_activity_at AS c FROM workspaces WHERE id = ?", b.owner.workspaceId)!;

test("reading Home changes nothing; the visit is recorded by a protected POST that moves both timestamps together", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  assert.deepEqual({ ...visitColumns(b) }, { a: null, b: null, c: null });

  const home = await call(b.app, b.server.base, "GET", "/api/home", s);
  assert.equal(home.status, 200);
  assert.deepEqual({ ...visitColumns(b) }, { a: null, b: null, c: null }, "GET /api/home is read-only");

  const first = await call(b.app, b.server.base, "POST", "/api/activity/visit", s, {});
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { lastVisitAt: null, started: true });
  const after = visitColumns(b);
  assert.ok(after.b && after.c && after.a === null);

  // Half an hour of quiet, then the next call (from whatever page): the visit that ended becomes the last one.
  b.app.db.run("UPDATE workspaces SET visit_started_at = ?, last_activity_at = ? WHERE id = ?", "2026-11-01T09:00:00.000Z", "2026-11-01T09:20:00.000Z", b.owner.workspaceId);
  const second = await call(b.app, b.server.base, "POST", "/api/activity/visit", s, {});
  assert.deepEqual(second.json, { lastVisitAt: "2026-11-01T09:00:00.000Z", started: true });
  const moved = visitColumns(b);
  assert.equal(moved.a, "2026-11-01T09:00:00.000Z");
  assert.equal(moved.b, moved.c, "the new visit's start and activity are the same instant");

  // Another call in the same visit changes nothing about which visit is "last".
  const third = await call(b.app, b.server.base, "POST", "/api/activity/visit", s, {});
  assert.deepEqual(third.json, { lastVisitAt: "2026-11-01T09:00:00.000Z", started: false });
  const home2 = await call(b.app, b.server.base, "GET", "/api/home", s);
  assert.equal((home2.json as { lastVisitAt: string }).lastVisitAt, "2026-11-01T09:00:00.000Z");
});

test("the visit call needs a signed-in session, the CSRF token and this site as its origin", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  assert.equal((await call(b.app, b.server.base, "POST", "/api/activity/visit", null, {})).status, 401);
  const noToken = await fetch(`${b.server.base}/api/activity/visit`, { method: "POST", headers: { cookie: s.cookie, origin: b.app.config.publicOrigin, "content-type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 403);
  const foreign = await call(b.app, b.server.base, "POST", "/api/activity/visit", s, {}, { headers: { origin: "https://elsewhere.example" } });
  assert.equal(foreign.status, 403);
  assert.deepEqual({ ...visitColumns(b) }, { a: null, b: null, c: null }, "none of those recorded a visit");
});

function addItem(b: Awaited<ReturnType<typeof boot>>, sourceId: string, title: string, over: Partial<NewItem> = {}): string {
  return b.app.db.tx(() => insertItem(b.app, {
    accountId: b.owner.accountId, workspaceId: b.owner.workspaceId, sourceId, kind: "article", title, url: `https://example.org/${title.replace(/\W+/g, "-")}`, author: null,
    summaryHtml: `<p>${title}.</p>`, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null, publishedAt: null, discoveredAt: nowIso(),
    enclosures: [], fresh: false, reason: "test", ...over,
  })).id;
}

test("lists take the type, length and source filters and Home's order; muted words are a preference that lists and Home honour", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const a = makeSource(b.app, b.owner, "A", "feed/1");
  const other = makeSource(b.app, b.owner, "B", "feed/2");
  const kept = addItem(b, a, "Football roundup");
  const plain = addItem(b, other, "Garden notes");
  const list = async (query: string) => (await call(b.app, b.server.base, "GET", `/api/items?${query}`, s)).json as { items: { id: string }[]; mutedHidden?: number };
  assert.equal((await list("scope=all&limit=10&type=articles")).items.length, 2);
  assert.equal((await list("scope=all&limit=10&type=videos")).items.length, 0);
  assert.equal((await list("scope=all&limit=10&length=short")).items.length, 0, "no length is known for either");
  assert.deepEqual((await list(`scope=all&limit=10&without=${a}`)).items.map((i) => i.id), [plain]);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/items?scope=all&type=books", s)).status, 400);
  assert.equal((await list("scope=home&limit=10&mix=home&filter=open")).items.length, 2);

  const saved = await call(b.app, b.server.base, "PATCH", "/api/preferences", s, { mutedWords: [{ text: "football", until: null }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.mutedWords, [{ text: "football", until: null }]);
  const muted = await list("scope=all&limit=10");
  assert.deepEqual(muted.items.map((i) => i.id), [plain]);
  assert.equal(muted.mutedHidden, 1);
  assert.deepEqual((await list("scope=all&limit=10&muted=show")).items.map((i) => i.id).sort(), [kept, plain].sort());
  assert.equal(((await call(b.app, b.server.base, "GET", "/api/home", s)).json as { mutedHidden: number }).mutedHidden, 1);
  assert.equal((await call(b.app, b.server.base, "PATCH", "/api/preferences", s, { mutedWords: [{ text: "x", until: "next week" }] })).status, 400);
  assert.deepEqual(((await call(b.app, b.server.base, "GET", "/api/bootstrap", s)).json as { preferences: { mutedWords: unknown[] } }).preferences.mutedWords, [{ text: "football", until: null }]);
});

test("a Home list narrowed by type, length, source or a failed copy still shows only what Home shows", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const a = makeSource(b.app, b.owner, "A", "feed/a");
  const other = makeSource(b.app, b.owner, "Other", "feed/other");
  const hidden = makeSource(b.app, b.owner, "Hidden", "feed/hidden");
  const shownBox = createCollection(b.app, b.owner, { name: "Shown", emoji: null, mode: "sources", sourceIds: [a, other], query: null, view: "list" });
  const hiddenBox = createCollection(b.app, b.owner, { name: "Hidden box", emoji: null, mode: "sources", sourceIds: [hidden], query: null, view: "list" });
  b.app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hiddenBox.id);
  const at = (hour: number) => `2026-05-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const item = (source: string, title: string, hour: number, over: Partial<NewItem> = {}) => addItem(b, source, title, { publishedAt: at(hour), discoveredAt: at(hour), ...over });
  const video = (source: string, title: string, hour: number, seconds: number) => item(source, title, hour, { kind: "video", durationSeconds: seconds });
  const clipA = video(a, "clip A", 9, 120), filmA = video(a, "film A", 8, 3600), textA = item(a, "text A", 7);
  const clipHidden = video(hidden, "clip hidden", 9, 100);
  const otherClip = video(other, "clip other", 6, 60), otherText = item(other, "text other", 12);
  const failing = item(a, "failing", 5);
  b.app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, completed_at) VALUES ('cap_f1', ?, ?, 'fulltext', 'failed', 'x', ?, ?)", b.owner.workspaceId, failing, at(5), at(5));
  const hiddenFailing = item(hidden, "failing hidden", 5);
  b.app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, completed_at) VALUES ('cap_f2', ?, ?, 'fulltext', 'failed', 'x', ?, ?)", b.owner.workspaceId, hiddenFailing, at(5), at(5));

  const get = async (query: string) => {
    const r = await call(b.app, b.server.base, "GET", `/api/items?mix=home&limit=50&${query}`, s);
    assert.equal(r.status, 200, r.text);
    return new Set((r.json.items as { id: string }[]).map((i) => i.id));
  };
  assert.deepEqual(await get("scope=home&type=videos"), new Set([clipA, filmA, otherClip]), "type: Home's sources only (not the hidden collection's)");
  assert.deepEqual(await get(`scope=collection:${shownBox.id}&type=videos`), new Set([clipA, filmA, otherClip]), "the same for a box");
  assert.deepEqual(await get("scope=home&type=articles"), new Set([textA, otherText, failing]));
  assert.deepEqual(await get("scope=home&length=short"), new Set([clipA, otherClip]), "length: the short videos; an article with no length is in neither list");
  assert.deepEqual(await get("scope=home&length=long"), new Set([filmA]));
  assert.deepEqual(await get(`scope=home&without=${a}`), new Set([otherClip, otherText]), "without: not that source, and still only Home's");
  assert.deepEqual(await get(`scope=home&source=${a}`), new Set([clipA, filmA, textA, failing]), "one source of Home's");
  assert.deepEqual(await get(`scope=home&source=${hidden}`), new Set(), "a source of a collection hidden on Home is not Home's, even asked for by name");
  assert.deepEqual(await get("scope=home&capture=failed"), new Set([failing]), "failed copies: Home's only");
  assert.deepEqual(await get("scope=home&type=articles&capture=failed&length=short"), new Set(), "and together: an article with no length is not short");
  assert.deepEqual(await get("scope=home&type=videos&filter=all"), new Set([clipA, filmA, otherClip]), "whatever the state filter");
  // The list view of the same request (not mix=home) shows them all: the narrowing is what Home does, not what lists do.
  const plain = await call(b.app, b.server.base, "GET", "/api/items?scope=home&limit=50&type=videos", s);
  assert.ok((plain.json.items as { id: string }[]).some((i) => i.id === clipHidden), "an ordinary list still has the hidden collection's video");
});

test("Home's one feed narrowed by type or length keeps Home's sources, and pages from a snapshot", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const vids = makeSource(b.app, b.owner, "Videos", "feed/vids");
  const plain = makeSource(b.app, b.owner, "Plain", "feed/plain");
  const hidden = makeSource(b.app, b.owner, "Hidden", "feed/hidden");
  createCollection(b.app, b.owner, { name: "Shown", emoji: null, mode: "sources", sourceIds: [vids, plain], query: null, view: "list" });
  const hiddenBox = createCollection(b.app, b.owner, { name: "Hidden box", emoji: null, mode: "sources", sourceIds: [hidden], query: null, view: "list" });
  b.app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hiddenBox.id);
  const at = (hour: number) => `2026-05-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const v1 = addItem(b, vids, "v1", { kind: "video", durationSeconds: 60, publishedAt: at(6), discoveredAt: at(6) });
  const v0 = addItem(b, vids, "v0", { kind: "video", durationSeconds: 60, publishedAt: at(2), discoveredAt: at(2) });
  addItem(b, vids, "text", { publishedAt: at(12), discoveredAt: at(12) });
  addItem(b, plain, "plain text", { publishedAt: at(20), discoveredAt: at(20) });
  addItem(b, hidden, "hidden video", { kind: "video", durationSeconds: 60, publishedAt: at(7), discoveredAt: at(7) });
  const get = async (query: string) => (await call(b.app, b.server.base, "GET", `/api/items?scope=home&mix=home&filter=open&${query}`, s)).json as { items: { id: string }[]; nextCursor: string | null };
  assert.deepEqual((await get("limit=50&type=videos")).items.map((i) => i.id), [v1, v0], "Home's sources, newest first");
  const first = await get("limit=1");
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor, "there is a next page");
  const stale = await call(b.app, b.server.base, "GET", `/api/items?scope=home&mix=home&limit=1&cursor=${Buffer.from(JSON.stringify(["2026-05-01T12:00:00.000Z", "itm_x"])).toString("base64url")}`, s);
  assert.equal(stale.status, 400, "a cursor without a snapshot is refused");
});

test("Home's lists are not searched or sorted: a request that asks for that is refused, not answered with the rules of another list", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const get = (query: string) => call(b.app, b.server.base, "GET", `/api/items?${query}`, s);
  assert.equal((await get("scope=home&mix=home&q=football")).status, 400, "with a search");
  assert.equal((await get("scope=home&mix=home&sort=oldest")).status, 400, "in another order");
  assert.equal((await get("scope=home&mix=home&sort=newest&limit=5")).status, 200, "Home's own order is what it is");
  assert.equal((await get("scope=home&mix=feed")).status, 400, "there is one kind of Home list");
  assert.equal((await get("scope=all&q=football&sort=oldest")).status, 200, "ordinary lists still search and sort");
});
