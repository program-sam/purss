import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../db/database.ts";
import { OTHER_BOX_ID, newId } from "@purss/domain";
import type { Preferences, SyncEntry } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { insertItem, listItems } from "./items.ts";
import type { NewItem } from "./items.ts";
import { applyUndo, bulk, changeState, clearFreshAll, keepItem } from "./state.ts";
import { createBasket, createCollection } from "./collections.ts";
import { followSource, onSubscribed, patchSource, unfollowSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { getPreferences, preferencesPatchSchema, setPreferences } from "./preferences.ts";
import { digestFor, lastScheduled, listNotifications, notifyArrivals, pruneNotifications, runDigest, runProblemCheck, unreadCount } from "./notifications.ts";
import { homeOverview, touchVisit } from "./home.ts";
import { expireFreshMarkers, resumePausedSources, runReturningPass } from "./returning.ts";
import { activityFor } from "./activity.ts";

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

type Owner = Principal & { engineUserId: string };

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  return { app, p, cleanup };
}

let serial = 0;
function addItem(app: App, p: Owner, sourceId: string | null, over: Partial<NewItem> = {}): string {
  serial++;
  return app.db.tx(() => insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId, kind: "article", title: `Item ${serial}`, url: `https://example.org/r/${serial}`, author: null,
    summaryHtml: `<p>About ${serial}</p>`, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: null, discoveredAt: nowIso(), enclosures: [], fresh: true, reason: "test", ...over,
  })).id;
}

const fresh = (app: App, id: string) => app.db.get<{ fresh: number }>("SELECT fresh FROM item_state WHERE item_id = ?", id)!.fresh === 1;
const revision = (app: App, id: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", id)!.revision;
const notes = (app: App) => app.db.all<{ title: string; body: string | null; source_id: string | null; kind: string; read_at: string | null }>("SELECT title, body, source_id, kind, read_at FROM notifications ORDER BY created_at, id");

// ---------- F22 back catalogue ----------

const settled = (app: App, id: string) => app.db.get<{ s: string | null }>("SELECT backlog_settled_at AS s FROM sources WHERE id = ?", id)!.s;
/** A sync walk that ends, as the worker reports it: a last batch that says it is done (empty or not). */
const walk = (app: App, p: Owner, entries: SyncEntry[] = []) => applySyncBatch(app, p.engineUserId, batch(entries));

test("a source's back catalogue is not New and tells no one; what comes after is", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Old podcast", "feed/1", { settled: false });
  const old = entry("feed/1", { publishedAt: ago(30 * DAY) });
  const undated = entry("feed/1", { publishedAt: null });
  const newer = entry("feed/1", { publishedAt: ahead(60_000) });
  const r = walk(app, p, [old, undated, newer]);
  assert.equal(r.accepted, 3);
  const byUrl = (e: SyncEntry) => app.db.get<{ id: string }>("SELECT id FROM items WHERE url = ?", e.url!)!.id;
  assert.equal(fresh(app, byUrl(old)), false, "published before the follow");
  assert.equal(fresh(app, byUrl(undated)), false, "undated entries on the first sync were already there");
  assert.equal(fresh(app, byUrl(newer)), true, "published after the follow");
  assert.deepEqual(notes(app).map((n) => n.title), ["New from Old podcast"], "one notification, for the one New item");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 1);
  assert.equal(settled(app, src), null, "this walk began before anything said the source was ready: the next one settles it");

  walk(app, p);
  assert.ok(settled(app, src), "a walk that began after the source was ready has enumerated it");
  // After that, even an entry dated before the follow is New: it was not there the first time.
  const late = entry("feed/1", { publishedAt: ago(40 * DAY) });
  walk(app, p, [late]);
  assert.equal(fresh(app, byUrl(late)), true);
});

test("one new item's notification opens that item; once more arrive it opens their source", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Tidal Notes", "feed/1");
  addItem(app, p, src, { discoveredAt: ago(DAY) });
  const first = addItem(app, p, src, { discoveredAt: ago(2 * DAY) }); // stored last, though crawled earlier: it is what arrived
  notifyArrivals(app, p.workspaceId, [[src, 1]]);
  const link = () => app.db.get<{ item_id: string | null; source_id: string | null; changed_at: string | null }>("SELECT item_id, source_id, changed_at FROM notifications")!;
  assert.deepEqual({ ...link(), changed_at: null }, { item_id: first, source_id: src, changed_at: null });
  addItem(app, p, src);
  notifyArrivals(app, p.workspaceId, [[src, 1]]);
  assert.equal(link().item_id, null, "two new: the source");
  assert.ok(link().changed_at, "and the grown notification is marked as changed, for phones");
});

test("a first sync that takes several batches stays back catalogue until a later walk has finished", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Long archive", "feed/1", { settled: false });
  const first = entry("feed/1", { publishedAt: ago(100 * DAY) });
  const second = entry("feed/1", { publishedAt: null });
  applySyncBatch(app, p.engineUserId, { ...batch([first]), done: false });
  applySyncBatch(app, p.engineUserId, batch([second]));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 0);
  assert.equal(notes(app).length, 0, "following an archive never says '2 new'");
  assert.equal(settled(app, src), null);
  applySyncBatch(app, p.engineUserId, { ...batch([entry("feed/1", { publishedAt: null })]), done: false });
  assert.equal(settled(app, src), null, "a walk that is not finished settles nothing");
  walk(app, p);
  assert.ok(settled(app, src));
});

test("a feed that starts empty is settled too: its first genuinely new undated entry is New", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Slow start", "feed/1", { settled: false });
  walk(app, p);
  walk(app, p);
  assert.ok(settled(app, src), "nothing to enumerate is still an enumeration");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0);
  walk(app, p, [entry("feed/1", { publishedAt: null })]);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 1);
  assert.deepEqual(notes(app).map((n) => n.title), ["New from Slow start"]);
});

test("a walk that ended before a source was ready does not settle it, and the boundary is kept in the database", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const early = makeSource(app, p, "Early", "feed/1", { settled: false });
  const late = makeSource(app, p, "Late", "feed/2", { settled: false });
  walk(app, p); // creates the checkpoint
  // The previous walk ended at midnight. "Early" was ready before that; "Late" only a second after.
  app.db.run("UPDATE sync_checkpoints SET last_walk_done_at = '2026-01-01T00:00:00.000Z' WHERE engine_user_id = ?", p.engineUserId);
  app.db.run("UPDATE sources SET subscribed_at = '2025-12-31T00:00:00.000Z' WHERE id = ?", early);
  app.db.run("UPDATE sources SET subscribed_at = '2026-01-01T00:00:01.000Z' WHERE id = ?", late);
  walk(app, p, [entry("feed/2", { publishedAt: null })]);
  assert.ok(settled(app, early));
  assert.equal(settled(app, late), null, "the walk that just ended began before the engine had finished subscribing to it");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 0, "what it brought is still its back catalogue");
  const boundary = app.db.get<{ at: string }>("SELECT last_walk_done_at AS at FROM sync_checkpoints WHERE engine_user_id = ?", p.engineUserId)!.at;
  assert.ok(boundary > "2026-01-01T00:00:01.000Z", "the boundary moved to where this walk ended");
  walk(app, p);
  assert.ok(settled(app, late), "the next walk began after it was ready");
});

test("following a source again starts a new episode: the old confirmation does not let an earlier walk settle it", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Back again", "feed/1");
  walk(app, p);
  unfollowSource(app, p, src);
  holdCandidate("dsc_again", p.workspaceId, { feedUrl: "https://example.org/feed/1.xml", siteUrl: null, title: "Back again", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null });
  followSource(app, p, { token: "dsc_again", collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false, fullText: false });
  const row = app.db.get<{ id: string; s: string | null; b: string | null; f: number }>("SELECT id, subscribed_at AS s, backlog_settled_at AS b, followed AS f FROM sources WHERE id = ?", src)!;
  assert.deepEqual({ ...row }, { id: src, s: null, b: null, f: 1 }, "the same source, followed from now, not yet confirmed by the engine");

  // The last walk ended a few seconds ago; the engine confirms the new subscription after that.
  app.db.run("UPDATE sync_checkpoints SET last_walk_done_at = ? WHERE engine_user_id = ?", ago(5000), p.engineUserId);
  onSubscribed(app, src, "feed/1");
  const confirmed = app.db.get<{ s: string }>("SELECT subscribed_at AS s FROM sources WHERE id = ?", src)!.s;
  walk(app, p, [entry("feed/1", { publishedAt: null })]);
  walk(app, p, [entry("feed/1", { publishedAt: null })]);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 0, "the walk that began before the confirmation brought back catalogue, and so did the next one that settled it");
  assert.ok(settled(app, src));
  onSubscribed(app, src, "feed/1");
  assert.equal(app.db.get<{ s: string }>("SELECT subscribed_at AS s FROM sources WHERE id = ?", src)!.s, confirmed, "confirming again in the same episode changes nothing");
  walk(app, p, [entry("feed/1", { publishedAt: null })]);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE fresh = 1")!.n, 1, "after that, New");
});

test("the engine confirming a subscription records when, once", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const id = newId("src");
  app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, health, created_at) VALUES (?, ?, ?, 'feed', 'Fresh follow', 'RSS feed', 'pending', ?)", id, p.accountId, p.workspaceId, nowIso());
  assert.equal(app.db.get<{ s: string | null }>("SELECT subscribed_at AS s FROM sources WHERE id = ?", id)!.s, null);
  onSubscribed(app, id, "feed/77");
  const first = app.db.get<{ s: string | null }>("SELECT subscribed_at AS s FROM sources WHERE id = ?", id)!.s;
  assert.ok(first);
  onSubscribed(app, id, "feed/77");
  assert.equal(app.db.get<{ s: string | null }>("SELECT subscribed_at AS s FROM sources WHERE id = ?", id)!.s, first);
});

// ---------- F65 the same link twice ----------

test("the same source delivering the same link and headline again is one item; a shared link with other headlines is not", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Reissuer", "feed/1");
  const a = entry("feed/1", { url: "https://example.org/p/1?utm_source=feed", title: "Same headline" });
  const b = entry("feed/1", { url: "https://www.example.org/p/1/", title: " same   headline ", originalGuid: "other-guid" });
  const r = applySyncBatch(app, p.engineUserId, batch([a, b]));
  assert.equal(r.accepted, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM external_ids")!.n, 2, "both engine entries map to the one item");

  // A podcast that links every episode to its home page keeps its episodes apart.
  const home = "https://example.org/";
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { url: home, title: "Episode 1" }), entry("feed/1", { url: home, title: "Episode 2" })]));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 3);

  // Another source's item with the same link is its own item.
  makeSource(app, p, "Other", "feed/2");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/2", { url: "https://example.org/p/1", title: "Same headline" })]));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 4);
});

// ---------- F20 seen items ----------

test("opening an item or changing its state clears its New marker, and Undo brings it back", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  const [a, b, c] = [addItem(app, p, src), addItem(app, p, src), addItem(app, p, src)] as [string, string, string];

  const opened = changeState(app, p, a, { opened: true, expectedRevision: revision(app, a) });
  assert.equal(opened.item.fresh, false, "the response carries the updated item");
  assert.equal(opened.item.opened, true);
  assert.equal(opened.item.workflow, "new", "opening changes nothing else");
  applyUndo(app, p, opened.undoToken);
  assert.equal(fresh(app, a), true);

  const finished = changeState(app, p, b, { workflow: "finished", expectedRevision: revision(app, b) });
  assert.equal(finished.item.fresh, false);
  applyUndo(app, p, finished.undoToken);
  assert.deepEqual([fresh(app, b), app.db.get<{ w: string }>("SELECT workflow AS w FROM item_state WHERE item_id = ?", b)!.w], [true, "new"]);

  const out = bulk(app, p, [b, c], { type: "workflow", workflow: "ignored" });
  assert.equal(out.changed, 2);
  assert.deepEqual([fresh(app, b), fresh(app, c)], [false, false]);
  applyUndo(app, p, out.undoToken);
  assert.deepEqual([fresh(app, b), fresh(app, c)], [true, true]);

  // To read is doing something with it too.
  changeState(app, p, c, { workflow: "toread", expectedRevision: revision(app, c) });
  assert.equal(fresh(app, c), false);
});

// ---------- F21 expiry and clear all ----------

test("New markers expire after the chosen number of days, and only the marker changes", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  const stale = addItem(app, p, src, { discoveredAt: ago(40 * DAY) });
  const recent = addItem(app, p, src, { discoveredAt: ago(10 * DAY) });
  const staleToRead = addItem(app, p, src, { discoveredAt: ago(50 * DAY) });
  changeState(app, p, staleToRead, { workflow: "toread", expectedRevision: revision(app, staleToRead) });
  app.db.run("UPDATE item_state SET fresh = 1 WHERE item_id = ?", staleToRead); // still New, as an item set before markers followed state
  const rev = revision(app, stale);

  assert.equal(getPreferences(app, p.workspaceId).freshDays, 30, "30 days unless chosen");
  setPreferences(app, p.workspaceId, { freshDays: 0 });
  assert.equal(expireFreshMarkers(app, p.workspaceId), 0, "never expires");
  assert.equal(fresh(app, stale), true);

  setPreferences(app, p.workspaceId, { freshDays: 30 });
  assert.equal(expireFreshMarkers(app, p.workspaceId), 2);
  assert.deepEqual([fresh(app, stale), fresh(app, recent), fresh(app, staleToRead)], [false, true, false]);
  assert.equal(app.db.get<{ w: string }>("SELECT workflow AS w FROM item_state WHERE item_id = ?", staleToRead)!.w, "toread", "workflow untouched");
  assert.equal(revision(app, stale), rev, "no conflict for a tab that still shows it");

  setPreferences(app, p.workspaceId, { freshDays: 7 });
  assert.equal(expireFreshMarkers(app, p.workspaceId), 1);
  assert.equal(fresh(app, recent), false);
});

test("what arrived since the previous visit began keeps its marker, so a long absence still finds it", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  const whileAway = addItem(app, p, src, { discoveredAt: ago(40 * DAY) });
  const before = addItem(app, p, src, { discoveredAt: ago(80 * DAY) });
  app.db.run("UPDATE workspaces SET last_visit_at = ? WHERE id = ?", ago(60 * DAY), p.workspaceId);
  assert.equal(expireFreshMarkers(app, p.workspaceId), 1);
  assert.deepEqual([fresh(app, whileAway), fresh(app, before)], [true, false]);
  // The next visit moves the line forward, and those expire too.
  app.db.run("UPDATE workspaces SET last_visit_at = ? WHERE id = ?", ago(1 * DAY), p.workspaceId);
  assert.equal(expireFreshMarkers(app, p.workspaceId), 1);
  assert.equal(fresh(app, whileAway), false);
});

test("expiry works in batches and stays inside one PURSS", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  const src = makeSource(app, p, "S", "feed/1");
  const theirs = makeSource(app, other, "Theirs", "feed/9");
  for (let i = 0; i < 2300; i++) addItem(app, p, src, { discoveredAt: ago(60 * DAY) });
  const otherItem = addItem(app, other, theirs, { discoveredAt: ago(60 * DAY) });
  assert.equal(expireFreshMarkers(app, p.workspaceId), 2300);
  assert.equal(fresh(app, otherItem), true, "another account's markers are not touched");
});

test("Start fresh clears every New marker past the page size in one go, with one Undo", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  const other = makeOwner(app, { admin: false });
  const theirs = makeSource(app, other, "Theirs", "feed/9");
  const theirItem = addItem(app, other, theirs);
  const ids: string[] = [];
  for (let i = 0; i < 1250; i++) ids.push(addItem(app, p, src));
  const kept = addItem(app, p, src);
  changeState(app, p, kept, { workflow: "inprogress", progress: 0.4, expectedRevision: revision(app, kept) });
  app.db.run("UPDATE item_state SET fresh = 1 WHERE item_id = ?", kept); // New again, so Start fresh has it to clear
  const out = clearFreshAll(app, p, "all");
  assert.equal(out.changed, 1251);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND fresh = 1", p.workspaceId)!.n, 0);
  assert.equal(fresh(app, theirItem), true);
  assert.equal(app.db.get<{ w: string; pr: number }>("SELECT workflow AS w, progress AS pr FROM item_state WHERE item_id = ?", kept)!.w, "inprogress", "only freshness changes");
  assert.deepEqual(clearFreshAll(app, p, "all"), { changed: 0, undoToken: null });
  applyUndo(app, p, out.undoToken!);
  assert.equal(listItems(app, p, { scope: "all", filter: "fresh", limit: 1 }).total, 1251, "every marker is back, including the one on the item in progress");
  assert.equal(ids.length, 1250);
});

// ---------- visits and Home ----------

test("a visit starts after 30 minutes of quiet, and 'last visit' holds still within a visit", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 9, 0) + min * 60_000);
  assert.deepEqual(touchVisit(app, p.workspaceId, at(0)), { lastVisitAt: null, started: true }, "a first visit has no earlier one");
  assert.deepEqual(touchVisit(app, p.workspaceId, at(10)), { lastVisitAt: null, started: false });
  assert.deepEqual(touchVisit(app, p.workspaceId, at(35)), { lastVisitAt: null, started: false }, "25 minutes after the last activity: still the same visit");
  assert.deepEqual(touchVisit(app, p.workspaceId, at(66)), { lastVisitAt: at(0).toISOString(), started: true }, "31 minutes of quiet: a new visit; the last one began at 9:00");
  assert.deepEqual(touchVisit(app, p.workspaceId, at(80)), { lastVisitAt: at(0).toISOString(), started: false });
  assert.deepEqual(touchVisit(app, p.workspaceId, at(60 * 24 * 3)), { lastVisitAt: at(66).toISOString(), started: true }, "three days later: the visit that began at 10:06");
  const row = app.db.get<{ a: string; b: string; c: string }>("SELECT last_visit_at AS a, visit_started_at AS b, last_activity_at AS c FROM workspaces WHERE id = ?", p.workspaceId)!;
  assert.deepEqual({ ...row }, { a: at(66).toISOString(), b: at(60 * 24 * 3).toISOString(), c: at(60 * 24 * 3).toISOString() }, "previous and current move together");
});

test("migration 019 starts existing workspaces from their last session, settles sources that have items, and turns 'off' into a frequency", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, "old.db"));
  t.after(() => db.close());
  const folder = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const files = readdirSync(folder).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files.filter((f) => f < "019")) db.exec(readFileSync(path.join(folder, f), "utf8"));
  const at = "2026-09-01T10:00:00.000Z";
  db.run("INSERT INTO accounts (id, created_at) VALUES ('acc_a', ?), ('acc_b', ?)", at, at);
  db.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('ws_a', 'acc_a', ?), ('ws_b', 'acc_b', ?)", at, at);
  db.run("INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method) VALUES ('s1', 'acc_a', 'c', ?, ?, ?, ?, 'passkey'), ('s2', 'acc_a', 'c', ?, ?, ?, ?, 'passkey')",
    at, at, "2026-09-02T08:00:00.000Z", at, at, at, "2026-09-05T20:00:00.000Z", at);
  db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, engine_stream_id, created_at) VALUES ('src_full', 'acc_a', 'ws_a', 'feed', 'Has items', 'RSS', 'feed/1', ?), ('src_new', 'acc_a', 'ws_a', 'feed', 'No items', 'RSS', NULL, ?)", at, at);
  db.run("INSERT INTO engine_users (id, account_id, workspace_id, username, created_at) VALUES ('eng_a', 'acc_a', 'ws_a', 'u_a', ?)", at);
  db.run("INSERT INTO sync_checkpoints (engine_user_id, last_success_at) VALUES ('eng_a', '2026-09-04T00:00:00.000Z')");
  db.run("INSERT INTO items (id, account_id, workspace_id, source_id, kind, title, discovered_at, created_at, updated_at) VALUES ('itm_1', 'acc_a', 'ws_a', 'src_full', 'article', 'T', ?, ?, ?)", at, at, at);
  db.run("INSERT INTO preferences (workspace_id, value, updated_at) VALUES ('ws_a', ?, ?), ('ws_b', ?, ?)", JSON.stringify({ notifications: { mode: "off", previews: true } }), at, JSON.stringify({ notifications: { mode: "browser" } }), at);
  db.exec(readFileSync(path.join(folder, "019_returning_users.sql"), "utf8"));

  const a = db.get<{ last_visit_at: string; visit_started_at: string; last_activity_at: string }>("SELECT last_visit_at, visit_started_at, last_activity_at FROM workspaces WHERE id = 'ws_a'")!;
  assert.deepEqual({ ...a }, { last_visit_at: "2026-09-05T20:00:00.000Z", visit_started_at: "2026-09-05T20:00:00.000Z", last_activity_at: "2026-09-05T20:00:00.000Z" });
  assert.equal(db.get<{ v: string | null }>("SELECT last_visit_at AS v FROM workspaces WHERE id = 'ws_b'")!.v, null);
  assert.equal(db.get<{ s: string | null }>("SELECT backlog_settled_at AS s FROM sources WHERE id = 'src_full'")!.s, at);
  assert.equal(db.get<{ s: string | null }>("SELECT backlog_settled_at AS s FROM sources WHERE id = 'src_new'")!.s, null);
  assert.equal(db.get<{ s: string | null }>("SELECT subscribed_at AS s FROM sources WHERE id = 'src_full'")!.s, at, "a source the engine already follows was ready when it was created");
  assert.equal(db.get<{ s: string | null }>("SELECT subscribed_at AS s FROM sources WHERE id = 'src_new'")!.s, null);
  assert.equal(db.get<{ w: string | null }>("SELECT last_walk_done_at AS w FROM sync_checkpoints WHERE engine_user_id = 'eng_a'")!.w, "2026-09-04T00:00:00.000Z");
  const pref = (ws: string) => JSON.parse(db.get<{ value: string }>("SELECT value FROM preferences WHERE workspace_id = ?", ws)!.value) as { notifications: Record<string, unknown> };
  assert.deepEqual({ ...pref("ws_a").notifications }, { mode: "inapp", previews: true, frequency: "off" });
  assert.deepEqual({ ...pref("ws_b").notifications }, { mode: "browser" });
});

test("Home's overview: what is New since the last visit, what to pick up, what was kept — and only this PURSS's", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const essays = makeSource(app, p, "Essays", "feed/1");
  const news = makeSource(app, p, "News", "feed/2");
  const loose = makeSource(app, p, "Loose", "feed/3");
  const quiet = makeSource(app, p, "Hidden", "feed/4");
  const col = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", sourceIds: [essays, news], query: null, view: "list" });
  const hidden = createCollection(app, p, { name: "Hidden", emoji: null, mode: "sources", sourceIds: [quiet], query: null, view: "list" });
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hidden.id);
  const stranger = makeOwner(app, { admin: false });
  addItem(app, stranger, makeSource(app, stranger, "Theirs", "feed/9"), { discoveredAt: ago(1000) });

  app.db.run("UPDATE workspaces SET last_visit_at = ? WHERE id = ?", ago(3 * DAY), p.workspaceId);
  addItem(app, p, essays, { discoveredAt: ago(1 * DAY) });
  addItem(app, p, essays, { discoveredAt: ago(2 * DAY) });
  addItem(app, p, news, { discoveredAt: ago(1 * DAY) });
  addItem(app, p, loose, { discoveredAt: ago(1 * DAY) });
  addItem(app, p, quiet, { discoveredAt: ago(1 * DAY) });
  addItem(app, p, essays, { discoveredAt: ago(5 * DAY) });
  addItem(app, p, essays, { discoveredAt: ago(1 * DAY), fresh: false });

  const o = homeOverview(app, p);
  assert.equal(o.lastVisitAt, app.db.get<{ v: string }>("SELECT last_visit_at AS v FROM workspaces WHERE id = ?", p.workspaceId)!.v);
  assert.equal(o.since!.total, 4, "essays 2 + news 1 + loose 1; hidden sources and older or seen items are left out");
  assert.deepEqual(o.since!.boxes.map((b) => [b.id, b.count]), [[col.id, 3], ["other", 1]]);

  // To read, Recently kept.
  const [a, b, c, d] = [addItem(app, p, essays, { discoveredAt: ago(9 * DAY), publishedAt: ago(9 * DAY) }), addItem(app, p, essays, { publishedAt: ago(8 * DAY) }),
    addItem(app, p, news, { publishedAt: ago(7 * DAY) }), addItem(app, p, news, { publishedAt: ago(6 * DAY) })] as [string, string, string, string];
  const work = (id: string, workflow: "toread" | "inprogress") => changeState(app, p, id, { workflow, expectedRevision: revision(app, id) });
  work(a, "toread"); work(b, "toread"); work(c, "inprogress");
  assert.deepEqual(homeOverview(app, p).toRead.items.map((i) => i.id), [a, b], "To read, oldest first; in progress and opened items are not listed");
  assert.equal(homeOverview(app, p).toRead.total, 2);
  changeState(app, p, d, { opened: true, expectedRevision: revision(app, d) });
  assert.deepEqual(homeOverview(app, p).toRead.items.map((i) => i.id), [a, b]);

  // Podcast episodes put aside are To listen, not To read.
  const e = addItem(app, p, news, { publishedAt: ago(10 * DAY) });
  app.db.run("UPDATE items SET kind = 'podcast' WHERE id = ?", e);
  work(e, "toread");
  const split = homeOverview(app, p);
  assert.deepEqual(split.toRead.items.map((i) => i.id), [a, b]);
  assert.equal(split.toRead.total, 2);
  assert.deepEqual(split.toListen.items.map((i) => i.id), [e]);
  assert.equal(split.toListen.total, 1);

  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  keepItem(app, p, d, basket.id);
  assert.deepEqual(homeOverview(app, p).recentlyKept.map((i) => i.id), [d]);
  assert.equal(homeOverview(app, p).fresh, app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND fresh = 1", p.workspaceId)!.n);
});

test("Home is empty for a new PURSS: nothing to say", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const o = homeOverview(app, p);
  assert.deepEqual(o, { lastVisitAt: null, since: null, toRead: { items: [], total: 0, totalAtMost: false }, toListen: { items: [], total: 0, totalAtMost: false }, recentlyKept: [], fresh: 0, unread: 0, mutedHidden: 0, mutedHiddenAtLeast: false });
});

// ---------- Home's lists ----------

/** Every page of a Home list, one request after another, with something allowed to change between requests. */
function pages(app: App, p: Owner, query: { scope: string; filter?: "open" | "fresh"; limit: number }, between: (page: number) => void = () => {}): string[] {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 400; n++) {
    const page = listItems(app, p, { filter: "open", ...query, cursor, mix: "home" });
    out.push(...page.items.map((i) => i.id));
    between(n);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}
const noRepeats = (ids: string[]) => assert.equal(new Set(ids).size, ids.length, "no item twice");
const feedItem = (app: App, p: Owner, src: string, minutesAgo: number) => addItem(app, p, src, { publishedAt: ago(minutesAgo * 60_000), discoveredAt: ago(minutesAgo * 60_000) });
const setWorkflow = (app: App, p: Owner, id: string, workflow: "toread" | "finished" | "ignored" | "inprogress") => changeState(app, p, id, { workflow, expectedRevision: revision(app, id) });

test("Home lists New items first, then To read, newest first within each; nothing finished, ignored or in progress", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const quiet = makeSource(app, p, "Quiet", "feed/1");
  const busy = makeSource(app, p, "Busy", "feed/2");
  const col = createCollection(app, p, { name: "News", emoji: null, mode: "sources", sourceIds: [quiet, busy], query: null, view: "list" });
  // Yesterday's item from a quiet source, put aside, and today's from a busy one, some already dealt with.
  const old = feedItem(app, p, quiet, 60 * 24);
  setWorkflow(app, p, old, "toread");
  const today = [1, 2, 3, 4, 5, 6].map((h) => feedItem(app, p, busy, h * 60));
  setWorkflow(app, p, today[0]!, "ignored");
  setWorkflow(app, p, today[1]!, "finished");
  setWorkflow(app, p, today[2]!, "toread");
  setWorkflow(app, p, today[3]!, "inprogress");
  const expected = [today[4], today[5], today[2], old];
  // Pages that end inside a run and at the end of the New run both carry on where they stopped.
  for (const scope of [`collection:${col.id}`, "home"]) for (const limit of [1, 2, 3, 10]) {
    assert.deepEqual(pages(app, p, { scope, limit }), expected, `${scope}, ${limit} a page: New newest first, then To read newest first`);
  }
  // The New-only layout keeps its own filter, in the same order.
  app.db.run("UPDATE item_state SET fresh = CASE WHEN item_id IN (?, ?) THEN 1 ELSE 0 END", today[5]!, old);
  assert.deepEqual(pages(app, p, { scope: "home", filter: "fresh", limit: 10 }), [today[5], old]);
  assert.throws(() => listItems(app, p, { scope: "home", cursor: "garbage", mix: "home" }), /expired/);
});

test("paging a Home list visits every item once; what arrives meanwhile waits for a refresh", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const a = makeSource(app, p, "A", "feed/1");
  const b = makeSource(app, p, "B", "feed/2");
  for (let i = 0; i < 40; i++) feedItem(app, p, a, 1 + i * 3);
  for (let i = 0; i < 25; i++) feedItem(app, p, b, 2 + i * 5);
  const arrivals: string[] = [];
  const got = pages(app, p, { scope: "home", limit: 7 }, (n) => { if (n === 0) arrivals.push(feedItem(app, p, a, 0), feedItem(app, p, b, 9999)); });
  noRepeats(got);
  assert.equal(got.length, 65);
  assert.ok(arrivals.every((id) => !got.includes(id)), "an arrival, even a backdated one, waits for a refresh");
  assert.equal(pages(app, p, { scope: "home", limit: 7 }).length, 67);
});

test("Home lists only the sources that have a box on Home", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const shown = makeSource(app, p, "Shown", "feed/1");
  const hidden = makeSource(app, p, "Hidden", "feed/2");
  const both = makeSource(app, p, "Both", "feed/3");
  const loose = makeSource(app, p, "Loose", "feed/4");
  createCollection(app, p, { name: "Shown box", emoji: null, mode: "sources", sourceIds: [shown, both], query: null, view: "list" });
  const b = createCollection(app, p, { name: "Hidden box", emoji: null, mode: "sources", sourceIds: [hidden, both], query: null, view: "list" });
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", b.id);
  for (const [src, n] of [[shown, 3], [hidden, 3], [both, 2], [loose, 2]] as const) for (let i = 0; i < n; i++) feedItem(app, p, src, 10 + i);
  const titles = () => new Set(pages(app, p, { scope: "home", limit: 4 }).map((id) => app.db.get<{ t: string }>("SELECT s.title AS t FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?", id)!.t));
  assert.deepEqual(titles(), new Set(["Shown", "Both", "Loose"]), "a source only in a hidden box is not on Home");
  setPreferences(app, p.workspaceId, { homeOther: false });
  assert.deepEqual(titles(), new Set(["Shown", "Both"]), "Other sources is hidden from Home too");
  app.db.run("UPDATE collections SET show_on_home = 1 WHERE id = ?", b.id);
  assert.ok(titles().has("Hidden"), "and shown again");
});

test("Home lists of scopes that are not a set of sources keep Home's filter and order", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const a = makeSource(app, p, "A", "feed/1");
  const ids = [feedItem(app, p, a, 5), feedItem(app, p, a, 4), feedItem(app, p, a, 3)];
  for (const id of ids.slice(0, 2)) setWorkflow(app, p, id, "toread");
  assert.deepEqual(listItems(app, p, { scope: "toread", filter: "open", limit: 10, mix: "home" }).items.map((i) => i.id), [ids[1], ids[0]]);
  const saved = createCollection(app, p, { name: "Filter", emoji: null, mode: "query", sourceIds: [], query: { all: [{ field: "source", value: [a] }] }, view: "list" });
  assert.deepEqual(listItems(app, p, { scope: `collection:${saved.id}`, filter: "open", limit: 10, mix: "home" }).items.map((i) => i.id), [ids[2], ids[1], ids[0]]);
  assert.throws(() => listItems(app, p, { scope: "collection:col_missing", limit: 10, mix: "home" }), /doesn't exist/);
});

// ---------- F34 pause for a while ----------

test("pausing for a week or a month ends by itself; pausing until resumed does not", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const weekly = makeSource(app, p, "Weekly", "feed/1");
  const monthly = makeSource(app, p, "Monthly", "feed/2");
  const forever = makeSource(app, p, "Forever", "feed/3");
  const w = patchSource(app, p, weekly, { pauseFor: "week" });
  patchSource(app, p, monthly, { pauseFor: "month" });
  const f = patchSource(app, p, forever, { paused: true });
  assert.equal(w.paused, true);
  assert.ok(Math.abs(Date.parse(w.pausedUntil!) - (Date.now() + 7 * DAY)) < 5000);
  assert.match(w.healthText!, /Paused until/);
  assert.equal(f.pausedUntil, null);

  assert.equal(resumePausedSources(app, new Date(Date.now() + 3 * DAY)), 0);
  assert.equal(resumePausedSources(app, new Date(Date.now() + 8 * DAY)), 1);
  assert.equal(app.db.get<{ paused: number }>("SELECT paused FROM sources WHERE id = ?", weekly)!.paused, 0);
  assert.equal(app.db.get<{ paused: number }>("SELECT paused FROM sources WHERE id = ?", monthly)!.paused, 1);
  assert.equal(resumePausedSources(app, new Date(Date.now() + 40 * DAY)), 1);
  assert.equal(app.db.get<{ paused: number }>("SELECT paused FROM sources WHERE id = ?", forever)!.paused, 1, "until resumed means until resumed");
  const back = patchSource(app, p, forever, { paused: false });
  assert.deepEqual([back.paused, back.pausedUntil], [false, null]);
});

test("a paused source collects nothing new", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Paused", "feed/1");
  patchSource(app, p, src, { pauseFor: "week" });
  const r = applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  assert.deepEqual([r.accepted, r.skippedPaused], [0, 1]);
});

// ---------- F23 notifications ----------

test("arrivals of one source within the hour share one notification that grows", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Chatty", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  assert.deepEqual(notes(app).map((n) => n.title), ["New from Chatty"]);
  app.db.run("UPDATE notifications SET read_at = ?", nowIso());
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
  assert.deepEqual(notes(app).map((n) => [n.title, n.read_at]), [["3 new from Chatty", null]], "one notification, unread again");
  // An hour later it starts a new one.
  app.db.run("UPDATE notifications SET created_at = ?", ago(61 * 60_000));
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  assert.equal(notes(app).length, 2);
});

test("with a daily digest, arrivals wait and one digest counts what is still New, by collection", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const essays = makeSource(app, p, "Essays", "feed/1");
  const news = makeSource(app, p, "News", "feed/2");
  const lone = makeSource(app, p, "Lone", "feed/3");
  const muted = makeSource(app, p, "Muted", "feed/4");
  const shelved = makeSource(app, p, "Shelved", "feed/5");
  app.db.run("UPDATE sources SET notify = 'muted' WHERE id = ?", muted);
  const col = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", sourceIds: [essays, news, muted], query: null, view: "list" });
  const hid = createCollection(app, p, { name: "Shelf", emoji: null, mode: "sources", sourceIds: [shelved], query: null, view: "list" });
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hid.id);
  setPreferences(app, p.workspaceId, { timezone: "UTC", notifications: { frequency: "daily", digestTime: "08:00", previews: false } });
  app.db.run("UPDATE notification_state SET window_end = '2026-11-03T08:00:00.000Z'");

  const mk = (src: string, at: string, over: Partial<NewItem> = {}) => addItem(app, p, src, { discoveredAt: at, ...over });
  mk(essays, "2026-11-04T10:00:00.000Z", { title: "Essay one" });
  mk(essays, "2026-11-04T11:00:00.000Z", { title: "Essay two" });
  mk(news, "2026-11-04T12:00:00.000Z");
  mk(lone, "2026-11-04T12:00:00.000Z");
  mk(muted, "2026-11-04T12:00:00.000Z");
  mk(shelved, "2026-11-04T12:00:00.000Z");
  mk(essays, "2026-11-04T13:00:00.000Z", { fresh: false });
  mk(essays, "2026-11-02T13:00:00.000Z");
  notifyArrivals(app, p.workspaceId, [[essays, 2]]);
  assert.equal(notes(app).length, 0, "digest mode: nothing at once");

  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-04T07:00:00.000Z")), false, "before 08:00 nothing is due");
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-05T08:05:00.000Z")), true);
  const [digest] = notes(app);
  assert.equal(digest!.title, "Your daily digest: 4 new in 2 collections");
  assert.equal(digest!.body, "Reading: 3 new\nOther sources: 1 new", "no titles while previews are off; hidden and muted left out");
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-05T09:00:00.000Z")), false, "one per day");
  assert.equal(notes(app).length, 1);

  // Chosen collections only.
  setPreferences(app, p.workspaceId, { notifications: { include: { newItems: [hid.id] } } });
  const d = digestFor(app, p.workspaceId, { from: "2026-11-03T08:00:00.000Z", to: "2026-11-05T09:00:00.000Z" });
  assert.deepEqual(d.boxes.map((b) => [b.name, b.count]), [["Shelf", 1]], "a hidden collection counts when chosen");
  void col;
});

test("a digest never shows the titles of a private source, with titles on or off, here or in any other channel", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const open = makeSource(app, p, "Open", "feed/1");
  const secret = makeSource(app, p, "Secret", "feed/2", { isPrivate: true });
  const second = makeSource(app, p, "Second open", "feed/3");
  const mixed = createCollection(app, p, { name: "Mixed", emoji: null, mode: "sources", sourceIds: [open, secret], query: null, view: "list" });
  const hidden = createCollection(app, p, { name: "Only private", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const privateOnly = makeSource(app, p, "Private too", "feed/4", { isPrivate: true });
  app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", hidden.id, privateOnly);
  addItem(app, p, open, { title: "Visible title", discoveredAt: "2026-11-04T10:00:00.000Z" });
  addItem(app, p, secret, { title: "Patron only", discoveredAt: "2026-11-04T11:00:00.000Z" });
  addItem(app, p, privateOnly, { title: "Another private title", discoveredAt: "2026-11-04T12:00:00.000Z" });
  addItem(app, p, second, { title: "Second visible", discoveredAt: "2026-11-04T13:00:00.000Z" });
  const window = { from: "2026-11-04T00:00:00.000Z", to: "2026-11-05T00:00:00.000Z" };
  const everyTitle = (d: ReturnType<typeof digestFor>) => d.boxes.flatMap((b) => b.titles);

  assert.deepEqual(everyTitle(digestFor(app, p.workspaceId, window)), [], "titles are off until the person turns them on");
  setPreferences(app, p.workspaceId, { timezone: "UTC", notifications: { previews: true, frequency: "daily", digestTime: "08:00" } });
  const on = digestFor(app, p.workspaceId, window);
  assert.deepEqual(everyTitle(on).sort(), ["Second visible", "Visible title"], "public titles only");
  assert.equal(on.total, 4, "private items are still counted");
  assert.deepEqual(on.boxes.find((b) => b.id === hidden.id)!.titles, [], "a collection of private sources has counts and no titles");
  assert.deepEqual(on.boxes.find((b) => b.id === mixed.id)!.titles, ["Visible title"]);

  // The notification made from it carries the same.
  app.db.run("UPDATE notification_state SET window_end = ?", window.from);
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-05T09:00:00.000Z")), true);
  const text = notes(app).map((n) => `${n.title}\n${n.body}`).join("\n");
  assert.match(text, /Visible title/);
  for (const secretTitle of ["Patron only", "Another private title"]) assert.ok(!text.includes(secretTitle), `${secretTitle} stays out`);
});

test("choosing \"Other sources\" tells about the sources that are in no collection, whether or not that box shows on Home", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const inBox = makeSource(app, p, "In a collection", "feed/1");
  const loose = makeSource(app, p, "Loose one", "feed/2");
  const col = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", sourceIds: [inBox], query: null, view: "list" });
  const window = { from: "2026-11-04T00:00:00.000Z", to: "2026-11-05T00:00:00.000Z" };
  for (let i = 0; i < 8; i++) addItem(app, p, loose, { discoveredAt: "2026-11-04T10:00:00.000Z" });
  addItem(app, p, inBox, { discoveredAt: "2026-11-04T10:00:00.000Z" });
  const boxes = () => digestFor(app, p.workspaceId, window).boxes.map((b) => [b.id, b.count]);

  for (const homeOther of [true, false]) {
    setPreferences(app, p.workspaceId, { homeOther, notifications: { include: { newItems: [OTHER_BOX_ID] } } });
    assert.deepEqual(boxes(), [[OTHER_BOX_ID, 8]], `only Other sources was chosen (shown on Home: ${homeOther})`);
  }
  setPreferences(app, p.workspaceId, { homeOther: false, notifications: { include: { newItems: [col.id] } } });
  assert.deepEqual(boxes(), [[col.id, 1]], "not chosen: left out");
  setPreferences(app, p.workspaceId, { homeOther: false, notifications: { include: { newItems: "all" } } });
  assert.deepEqual(boxes(), [[col.id, 1]], "all of Home, and Other sources is hidden from Home");
  setPreferences(app, p.workspaceId, { homeOther: true, notifications: { include: { newItems: "all" } } });
  assert.deepEqual(boxes(), [[OTHER_BOX_ID, 8], [col.id, 1]]);

  // An arrival from a loose source tells when it was chosen, and not when something else was.
  setPreferences(app, p.workspaceId, { homeOther: false, notifications: { frequency: "arrivals", include: { newItems: [OTHER_BOX_ID] } } });
  notifyArrivals(app, p.workspaceId, [[loose, 2], [inBox, 1]]);
  assert.deepEqual(notes(app).map((n) => n.source_id), [loose]);
  app.db.run("DELETE FROM notifications");
  setPreferences(app, p.workspaceId, { notifications: { include: { newItems: [col.id] } } });
  notifyArrivals(app, p.workspaceId, [[loose, 2], [inBox, 1]]);
  assert.deepEqual(notes(app).map((n) => n.source_id), [inBox]);
});

test("a weekly digest comes on its day, in the person's time zone", () => {
  // 2026-11-05 is a Thursday. Monday 08:00 in Tokyo is Sunday 23:00 UTC.
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  assert.equal(new Date(lastScheduled(now, "Asia/Tokyo", "08:00", 1)).toISOString(), "2026-11-01T23:00:00.000Z");
  assert.equal(new Date(lastScheduled(now, "UTC", "08:00", 1)).toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal(new Date(lastScheduled(now, "UTC", "08:00", null)).toISOString(), "2026-11-05T08:00:00.000Z");
  assert.equal(new Date(lastScheduled(Date.parse("2026-11-05T07:00:00.000Z"), "UTC", "08:00", null)).toISOString(), "2026-11-04T08:00:00.000Z");
  // Across the end of daylight saving in Brussels (clocks went back on 2026-10-25): 08:00 local is 07:00 UTC after, 06:00 UTC before.
  assert.equal(new Date(lastScheduled(Date.parse("2026-10-26T12:00:00.000Z"), "Europe/Brussels", "08:00", null)).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(new Date(lastScheduled(Date.parse("2026-10-24T12:00:00.000Z"), "Europe/Brussels", "08:00", null)).toISOString(), "2026-10-24T06:00:00.000Z");
});

test("a digest time the clocks skip lands after the gap, never before it; one that happens twice takes the first", () => {
  const at = (iso: string, tz: string, time: string) => new Date(lastScheduled(Date.parse(iso), tz, time, null)).toISOString();
  // New York, 14 March 2027: 02:00 became 03:00, so 02:30 does not exist. It is 03:30 (07:30 UTC), not 01:30.
  assert.equal(at("2027-03-14T12:00:00.000Z", "America/New_York", "02:30"), "2027-03-14T07:30:00.000Z");
  assert.equal(at("2027-03-14T07:00:00.000Z", "America/New_York", "02:30"), "2027-03-13T07:30:00.000Z", "before it comes the day before's 02:30 (EST)");
  // Brussels, 28 March 2027 (clocks go forward at 01:00 UTC): 02:30 becomes 03:30 (01:30 UTC).
  assert.equal(at("2027-03-28T12:00:00.000Z", "Europe/Brussels", "02:30"), "2027-03-28T01:30:00.000Z");
  // Times either side of the gap are what they say.
  assert.equal(at("2027-03-14T12:00:00.000Z", "America/New_York", "03:30"), "2027-03-14T07:30:00.000Z");
  assert.equal(at("2027-03-14T12:00:00.000Z", "America/New_York", "01:30"), "2027-03-14T06:30:00.000Z");
  // New York, 1 November 2026: 01:30 happens twice (05:30 and 06:30 UTC); the first is used.
  assert.equal(at("2026-11-01T12:00:00.000Z", "America/New_York", "01:30"), "2026-11-01T05:30:00.000Z");
  // An ordinary day, and a zone without daylight saving.
  assert.equal(at("2026-07-10T12:00:00.000Z", "America/New_York", "08:00"), "2026-07-10T12:00:00.000Z");
  assert.equal(at("2026-07-10T12:00:00.000Z", "Asia/Kolkata", "08:00"), "2026-07-10T02:30:00.000Z");
});

test("a weekly digest is made once, on or after its day", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  setPreferences(app, p.workspaceId, { timezone: "UTC", notifications: { frequency: "weekly", digestDay: 1, digestTime: "08:00" } });
  app.db.run("UPDATE notification_state SET window_end = '2026-10-29T00:00:00.000Z'");
  addItem(app, p, src, { discoveredAt: "2026-11-01T10:00:00.000Z" });
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-01T12:00:00.000Z")), false, "Sunday: Monday has not come");
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-05T12:00:00.000Z")), true, "Thursday: Monday's digest, late, still comes");
  assert.match(notes(app)[0]!.title, /^Your weekly digest: 1 new in/);
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-06T12:00:00.000Z")), false);
});

test("switching how often to be told starts from now; off silences the bell badge", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  addItem(app, p, src, { discoveredAt: ago(2 * DAY) });
  setPreferences(app, p.workspaceId, { notifications: { frequency: "daily" } });
  const end = app.db.get<{ w: string }>("SELECT window_end AS w FROM notification_state")!.w;
  assert.ok(Date.now() - Date.parse(end) < 5000, "nothing from before the switch is sent");
  app.db.run("INSERT INTO notifications (id, workspace_id, kind, title, dedup_key, created_at) VALUES ('n1', ?, 'arrivals', 'x', 'k', ?)", p.workspaceId, nowIso());
  assert.equal(unreadCount(app, p.workspaceId), 1);
  setPreferences(app, p.workspaceId, { notifications: { frequency: "off" } });
  assert.equal(unreadCount(app, p.workspaceId), 0, "no badge while off");
  assert.equal(listNotifications(app, p).length, 1, "what is already there can still be read");
});

test("legacy 'off' mode reads as the frequency off, and the new fields validate", () => {
  assert.equal(preferencesPatchSchema.safeParse({ notifications: { mode: "off", quietStart: null, quietEnd: null, previews: false } }).success, true);
  assert.equal(preferencesPatchSchema.safeParse({ freshDays: 366 }).success, false);
  assert.equal(preferencesPatchSchema.safeParse({ notifications: { digestTime: "25:00" } }).success, false);
  assert.equal(preferencesPatchSchema.safeParse({ notifications: { digestDay: 7 } }).success, false);
  assert.equal(preferencesPatchSchema.safeParse({ notifications: { include: { newItems: ["col_a"] } } }).success, true);
  const { app, p, cleanup } = setup();
  try {
    setPreferences(app, p.workspaceId, { notifications: { mode: "off" } } as never);
    const n = getPreferences(app, p.workspaceId).notifications;
    assert.deepEqual([n.mode, n.frequency], ["inapp", "off"]);
    // Changing one include switch keeps the others.
    setPreferences(app, p.workspaceId, { notifications: { frequency: "daily", include: { problems: false } } });
    const after: Preferences["notifications"] = getPreferences(app, p.workspaceId).notifications;
    assert.deepEqual(after.include, { newItems: "all", problems: false, reminders: true, captures: true });
  } finally { cleanup(); }
});

test("a source that stops working is told about once for that failure, however often it is checked or notifications are pruned", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Broken", "feed/1");
  const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + min * 60_000);
  app.db.run("UPDATE sources SET health = 'error', health_text = 'The site refused us.' WHERE id = ?", src);
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, at(0)), 1);
  assert.deepEqual(notes(app).map((n) => [n.kind, n.title, n.body]), [["source", "Broken isn't working", "The site refused us."]]);
  for (let i = 1; i <= 50; i++) runProblemCheck(app, p.workspaceId, p.accountId, at(i * 5));
  assert.equal(notes(app).length, 1, "every five minutes for four hours: still one");
  // Pruning (or deleting) the notification does not make it come back.
  app.db.run("DELETE FROM notifications");
  for (let i = 51; i <= 60; i++) runProblemCheck(app, p.workspaceId, p.accountId, at(i * 5));
  assert.equal(notes(app).length, 0, "the failure was told about; the memory of it is on the source, not in the notification");

  // It recovers, and fails again the next day: a new failure.
  app.db.run("UPDATE sources SET health = 'ok', health_text = NULL WHERE id = ?", src);
  runProblemCheck(app, p.workspaceId, p.accountId, at(400));
  app.db.run("UPDATE sources SET health = 'error', health_text = 'Gone again.' WHERE id = ?", src);
  runProblemCheck(app, p.workspaceId, p.accountId, at(410));
  assert.equal(notes(app).length, 0, "a flap within the day is not a second notification");
  runProblemCheck(app, p.workspaceId, p.accountId, at(60 * 26));
  assert.deepEqual(notes(app).map((n) => n.body), ["Gone again."]);

  setPreferences(app, p.workspaceId, { notifications: { include: { problems: false } } });
  app.db.run("UPDATE sources SET problem_notified_for = NULL, problem_notified_at = NULL WHERE id = ?", src);
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, at(60 * 60)), 0, "switched off");
  setPreferences(app, p.workspaceId, { notifications: { frequency: "off", include: { problems: true } } });
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, at(60 * 60)), 0, "and nothing while notifications are off");
});

test("a failed text save is told about once; a new attempt that fails is told about again", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", src);
  const item = addItem(app, p, src);
  const failure = (id: string, completedAt: string) => app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', 'failed', 'x', ?, ?)", id, p.workspaceId, item, completedAt, completedAt);
  const now = new Date();
  failure("cap1", new Date(now.getTime() - 60_000).toISOString());
  failure("cap2", new Date(now.getTime() - 120_000).toISOString());
  failure("old", new Date(now.getTime() - 3 * DAY).toISOString());
  assert.equal(runProblemCheck(app, p.workspaceId, p.accountId, now), 1);
  assert.deepEqual(notes(app).map((n) => n.title), ["Couldn't save the text of 1 item from S"], "two attempts on one item are one item; the one from three days ago is not news");
  for (let i = 1; i <= 30; i++) runProblemCheck(app, p.workspaceId, p.accountId, new Date(now.getTime() + i * 5 * 60_000));
  app.db.run("DELETE FROM notifications");
  for (let i = 31; i <= 40; i++) runProblemCheck(app, p.workspaceId, p.accountId, new Date(now.getTime() + i * 5 * 60_000));
  assert.equal(notes(app).length, 0, "a capture that stays failed is not told about every five minutes, nor again after pruning");

  // Trying again re-arms the capture; failing again is a new failure.
  const later = new Date(now.getTime() + 3_600_000);
  app.db.run("UPDATE captures SET status = 'pending', completed_at = NULL WHERE id = 'cap1'");
  runProblemCheck(app, p.workspaceId, p.accountId, new Date(later.getTime() - 1000));
  assert.equal(notes(app).length, 0, "pending is not a failure");
  app.db.run("UPDATE captures SET status = 'failed', completed_at = ? WHERE id = 'cap1'", new Date(later.getTime() - 500).toISOString());
  runProblemCheck(app, p.workspaceId, p.accountId, later);
  assert.deepEqual(notes(app).map((n) => n.title), ["Couldn't save the text of 1 item from S"]);

  setPreferences(app, p.workspaceId, { notifications: { include: { captures: false } } });
  failure("cap3", new Date(later.getTime() + 1000).toISOString());
  runProblemCheck(app, p.workspaceId, p.accountId, new Date(later.getTime() + 5000));
  assert.equal(notes(app).length, 1, "switched off");
});

test("a digest is made once: its window moves with it in one transaction, and pruning cannot make it come again", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  createCollection(app, p, { name: "All", emoji: null, mode: "sources", sourceIds: [src], query: null, view: "list" });
  setPreferences(app, p.workspaceId, { timezone: "UTC", notifications: { frequency: "daily", digestTime: "08:00" } });
  app.db.run("UPDATE notification_state SET window_end = '2026-11-03T08:00:00.000Z'");
  addItem(app, p, src, { discoveredAt: "2026-11-04T10:00:00.000Z" });
  const windowEnd = () => app.db.get<{ w: string }>("SELECT window_end AS w FROM notification_state")!.w;
  const due = new Date("2026-11-05T08:05:00.000Z");

  // If recording the notification fails, the window has not moved and nothing was made.
  app.db.exec("CREATE TRIGGER digest_fails BEFORE INSERT ON notifications WHEN NEW.dedup_key LIKE 'digest:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => runDigest(app, p.workspaceId, p.accountId, due), /disk full/);
  assert.equal(windowEnd(), "2026-11-03T08:00:00.000Z", "the window did not move");
  assert.equal(notes(app).length, 0);
  app.db.exec("DROP TRIGGER digest_fails");

  assert.equal(runDigest(app, p.workspaceId, p.accountId, due), true);
  assert.equal(windowEnd(), due.toISOString());
  assert.equal(notes(app).length, 1);

  // Pruned, deleted or restored without it: the window still says it was covered.
  app.db.run("DELETE FROM notifications");
  assert.equal(pruneNotifications(app, p.workspaceId), 0);
  for (const minutes of [1, 30, 600]) assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date(due.getTime() + minutes * 60_000)), false);
  assert.equal(notes(app).length, 0, "nothing comes again");
  // Another day's window makes another digest, named for its own window.
  addItem(app, p, src, { discoveredAt: "2026-11-05T12:00:00.000Z" });
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-06T08:05:00.000Z")), true);
  assert.equal(app.db.get<{ k: string }>("SELECT dedup_key AS k FROM notifications")!.k, `digest:daily:${due.toISOString()}`);

  // A digest with nothing New still closes its window, without a notification.
  assert.equal(runDigest(app, p.workspaceId, p.accountId, new Date("2026-11-07T08:05:00.000Z")), false);
  assert.equal(windowEnd(), "2026-11-07T08:05:00.000Z");
  assert.equal(notes(app).length, 1);
});

test("old notifications are pruned: past 90 days, or beyond the newest 500; and unfollowing deletes a source's", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Gone soon", "feed/1");
  app.db.tx(() => {
    for (let i = 0; i < 560; i++) {
      app.db.run("INSERT INTO notifications (id, workspace_id, kind, title, dedup_key, created_at, source_id) VALUES (?, ?, 'arrivals', ?, ?, ?, ?)",
        `n${i}`, p.workspaceId, `t${i}`, `k${i}`, ago(i * 60_000), i % 2 ? null : src);
    }
    for (let i = 0; i < 5; i++) app.db.run("INSERT INTO notifications (id, workspace_id, kind, title, dedup_key, created_at) VALUES (?, ?, 'arrivals', 'old', ?, ?)", `o${i}`, p.workspaceId, `ok${i}`, ago(100 * DAY + i));
  });
  assert.equal(pruneNotifications(app, p.workspaceId), 5 + 60);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications")!.n, 500);
  assert.ok(app.db.get("SELECT 1 FROM notifications WHERE id = 'n0'"), "the newest stay");
  assert.equal(app.db.get("SELECT 1 FROM notifications WHERE id = 'n559'"), undefined);
  unfollowSource(app, p, src);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE source_id = ?", src)!.n, 0);
  assert.ok(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications")!.n > 0, "others stay");
});

test("a source set to 'Notify me' tells as items arrive even with a digest; muted never does", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const loud = makeSource(app, p, "Loud", "feed/1");
  const mute = makeSource(app, p, "Mute", "feed/2");
  const plain = makeSource(app, p, "Plain", "feed/3");
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", loud);
  app.db.run("UPDATE sources SET notify = 'muted' WHERE id = ?", mute);
  setPreferences(app, p.workspaceId, { notifications: { frequency: "daily" } });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/2"), entry("feed/3")]));
  assert.deepEqual(notes(app).map((n) => n.source_id), [loud]);
  setPreferences(app, p.workspaceId, { notifications: { frequency: "arrivals" } });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/2"), entry("feed/3")]));
  assert.deepEqual(notes(app).map((n) => n.source_id).sort(), [loud, plain].sort());
});

// ---------- the pass, and tenant isolation ----------

test("the returning pass expires markers, resumes pauses and is throttled", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "S", "feed/1");
  const old = addItem(app, p, src, { discoveredAt: ago(60 * DAY) });
  patchSource(app, p, src, { pauseFor: "week" });
  app.db.run("UPDATE sources SET paused_until = ? WHERE id = ?", ago(1000), src);
  const t0 = new Date();
  runReturningPass(app, t0);
  assert.equal(fresh(app, old), false);
  assert.equal(app.db.get<{ paused: number }>("SELECT paused FROM sources WHERE id = ?", src)!.paused, 0);
  const again = addItem(app, p, src, { discoveredAt: ago(60 * DAY) });
  runReturningPass(app, new Date(t0.getTime() + 60_000));
  assert.equal(fresh(app, again), true, "too soon to look again");
  runReturningPass(app, new Date(t0.getTime() + 61 * 60_000));
  assert.equal(fresh(app, again), false);
});

test("a PURSS's Home, digest and activity never include another's", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  const mine = makeSource(app, p, "Mine", "feed/1");
  const theirs = makeSource(app, other, "Theirs", "feed/2");
  addItem(app, p, mine);
  const secret = addItem(app, other, theirs, { discoveredAt: ago(1000) });
  changeState(app, other, secret, { workflow: "toread", expectedRevision: 0 });
  app.db.run("UPDATE workspaces SET last_visit_at = ? WHERE id = ?", ago(DAY), p.workspaceId);
  const o = homeOverview(app, p);
  assert.deepEqual(o.since!.boxes.map((b) => b.name), ["Other sources"]);
  assert.equal(o.since!.total, 1);
  assert.equal(o.toRead.total, 0);
  assert.deepEqual(listItems(app, p, { scope: "home", filter: "open", mix: "home" }).items.map((i) => i.sourceTitle), ["Mine"]);
  assert.deepEqual(activityFor(app, p).sources.map((s) => s.title), ["Mine"]);
  assert.equal(digestFor(app, p.workspaceId, { from: ago(DAY), to: ahead(DAY) }).total, 1);
});

// ---------- F109 activity ----------

test("activity: checking, setting up, saving text, what arrived and what went wrong", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Fine", "feed/1");
  const bad = makeSource(app, p, "Bad", "feed/2");
  app.db.run("UPDATE sources SET health = 'error', health_text = 'The site refused us.' WHERE id = ?", bad);
  const idle = activityFor(app, p);
  assert.deepEqual([idle.checking, idle.subscribing, idle.savingText, idle.lastCheckedAt], [false, 0, 0, null]);

  const crawled = nowIso();
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { crawledAt: crawled }), entry("feed/1", { crawledAt: crawled })]));
  const item = app.db.get<{ id: string }>("SELECT id FROM items LIMIT 1")!.id;
  app.db.run("INSERT INTO jobs (id, account_id, workspace_id, kind, payload, status, run_after, created_at, updated_at) VALUES ('j1', ?, ?, 'engine.sync', '{}', 'leased', ?, ?, ?)", p.accountId, p.workspaceId, nowIso(), nowIso(), nowIso());
  app.db.run("INSERT INTO jobs (id, account_id, workspace_id, kind, payload, status, run_after, created_at, updated_at) VALUES ('j2', ?, ?, 'engine.subscribe', '{}', 'queued', ?, ?, ?)", p.accountId, p.workspaceId, nowIso(), nowIso(), nowIso());
  app.db.run("INSERT INTO jobs (id, account_id, workspace_id, kind, payload, status, run_after, created_at, updated_at) VALUES ('j3', ?, ?, 'engine.subscribe', '{}', 'queued', ?, ?, ?)", p.accountId, p.workspaceId, ahead(DAY), nowIso(), nowIso());
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES ('c1', ?, ?, 'fulltext', 'pending', ?)", p.workspaceId, item, nowIso());
  const busy = activityFor(app, p);
  assert.deepEqual([busy.checking, busy.subscribing, busy.savingText], [true, 1, 1], "a retry that is not due yet is not 'subscribing'");
  assert.ok(busy.lastCheckedAt && busy.nextCheckAt && busy.nextCheckAt > busy.lastCheckedAt);
  const fine = busy.sources.find((s) => s.id === src)!;
  assert.deepEqual([fine.arrived, fine.note], [2, null]);
  assert.equal(busy.sources.find((s) => s.id === bad)!.note, "The site refused us.");
  assert.equal(busy.sources.find((s) => s.id === bad)!.lastCheckedAt, null);
  assert.ok(busy.events.some((e) => e.kind === "arrived" && e.text === "2 new items from Fine"));
  assert.ok(busy.events.some((e) => e.kind === "problem" && e.text.startsWith("Bad:")));
});

// ---------- queries stay on their indexes ----------

test("the new queries use indexes, not whole-table scans", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const plan = (sql: string, ...params: (string | number | null)[]) => app.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail);
  const scans = (lines: string[]) => lines.filter((l) => /^SCAN (i|st|items|item_state|s|sources|basket_items|b|notifications|captures)\b/.test(l) && !/USING (COVERING )?INDEX/.test(l));
  const ws = p.workspaceId;
  const expiry = plan(`UPDATE item_state SET fresh = 0 WHERE workspace_id = ? AND item_id IN (
     SELECT st.item_id FROM item_state st JOIN items i ON i.id = st.item_id WHERE st.workspace_id = ? AND st.fresh = 1 AND i.discovered_at < ? AND (? IS NULL OR i.discovered_at <= ?) LIMIT 10)`, ws, ws, "x", null, null);
  assert.deepEqual(scans(expiry), [], expiry.join("\n"));
  assert.ok(expiry.some((l) => /item_state_fresh/.test(l)), expiry.join("\n"));
  const fromVisible = "FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id";
  const since = plan(`SELECT i.source_id, COUNT(*) ${fromVisible} WHERE i.workspace_id = ? AND i.discovered_at > ? AND st.fresh = 1 AND s.followed = 1 GROUP BY i.source_id`, ws, "x");
  assert.deepEqual(scans(since), [], since.join("\n"));
  const inProgress = plan(`SELECT i.id ${fromVisible} WHERE i.workspace_id = ? AND st.workflow = 'inprogress' ORDER BY st.updated_at DESC LIMIT 6`, ws);
  assert.deepEqual(scans(inProgress), [], inProgress.join("\n"));
  const opened = plan(`SELECT i.id ${fromVisible} WHERE i.workspace_id = ? AND st.opened_at IS NOT NULL AND st.opened_at >= ? ORDER BY st.opened_at DESC LIMIT 6`, ws, "x");
  assert.deepEqual(scans(opened), [], opened.join("\n"));
  const freshCount = plan(`SELECT COUNT(*) ${fromVisible} WHERE st.workspace_id = ? AND st.fresh = 1`, ws);
  assert.deepEqual(scans(freshCount), [], freshCount.join("\n"));
  const kept = plan("SELECT item_id FROM basket_items WHERE workspace_id = ? AND kept_at >= ? ORDER BY kept_at DESC LIMIT 30", ws, "x");
  assert.deepEqual(scans(kept), [], kept.join("\n"));
  const feed = plan(`SELECT i.id, COALESCE(i.published_at, i.discovered_at) AS k ${fromVisible} WHERE i.workspace_id = ? AND st.workflow <> 'ignored'
     ORDER BY COALESCE(i.published_at, i.discovered_at) DESC, i.id DESC LIMIT 201`, ws);
  assert.deepEqual(scans(feed), [], feed.join("\n"));
  assert.ok(!feed.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), `the default order reads the index:\n${feed.join("\n")}`);
  const pending = plan("SELECT COUNT(*) FROM captures WHERE workspace_id = ? AND status = 'pending'", ws);
  assert.deepEqual(scans(pending), [], pending.join("\n"));
  const sameLink = plan("SELECT id, url, title FROM items WHERE workspace_id = ? AND source_id = ? AND discovered_at >= ? AND url IS NOT NULL AND instr(lower(url), ?) > 0 LIMIT 20", ws, "s", "x", "y");
  assert.deepEqual(scans(sameLink), [], sameLink.join("\n"));
  const prune = plan("DELETE FROM notifications WHERE workspace_id = ? AND created_at < ?", ws, "x");
  assert.deepEqual(scans(prune), [], prune.join("\n"));
});
