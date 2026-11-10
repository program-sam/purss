import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { SyncEntry } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { buildDataset } from "../../../../scripts/dataset.ts";
import { categories, summary } from "./storage.ts";
import { applySyncBatch } from "./sync.ts";
import { createBasket, createCollection, listBaskets, listCollections } from "./collections.ts";
import { listSources } from "./sources.ts";
import { insertItem, listItems } from "./items.ts";
import { keepItem } from "./state.ts";
import { completeCapture } from "./captures.ts";
import { getPreferences } from "./preferences.ts";
import { unreadCount } from "./notifications.ts";

/*
 * Size defects only show above a few thousand items: a lookup without an index costs nothing on a test
 * database and a minute on a real one. These tests look at how queries are executed, and at timings with a
 * wide margin, on data shaped like a real account (scripts/dataset.ts). The acceptance size gate is in plan/13.
 */

type Seen = { sql: string; params: unknown[] };

/** Record every query a function runs, so its plans can be checked without copying its SQL into the test. */
function recordQueries<T>(app: App, run: () => T): { result: T; seen: Seen[] } {
  const seen: Seen[] = [];
  const db = app.db as unknown as Record<"get" | "all" | "run", (sql: string, ...params: unknown[]) => unknown>;
  const original = { get: db.get, all: db.all, run: db.run };
  for (const name of ["get", "all", "run"] as const) {
    db[name] = (sql, ...params) => { seen.push({ sql, params }); return original[name].call(app.db, sql, ...params); };
  }
  try {
    return { result: run(), seen };
  } finally {
    db.get = original.get;
    db.all = original.all;
    db.run = original.run;
  }
}

/** Plan lines that read a whole table (or a whole index) where the query should look rows up. */
function fullScans(app: App, { sql, params }: Seen): string[] {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return [];
  const plan = app.db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])).map((r) => String(r.detail));
  const watched: Array<[RegExp, RegExp]> = [
    [/\bitems i\b|\bFROM items\b/, /^SCAN (i|items)\b/],
    [/\bbasket_items b\b/, /^SCAN (b|basket_items)\b/],
    [/\bcollection_sources cs\b/, /^SCAN (cs|collection_sources)\b/],
    [/\bstored_objects\b/, /^SCAN (o|stored_objects)\b/],
  ];
  return plan.filter((line) => watched.some(([inSql, scan]) => inSql.test(sql) && scan.test(line)));
}

function populated(): { app: App; p: Principal & { engineUserId: string }; entries: SyncEntry[]; cleanup: () => void } {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const sources = [0, 1, 2].map((i) => makeSource(app, p, `Source ${i}`, `feed/${i}`));
  createCollection(app, p, { name: "Mixed", emoji: null, mode: "sources", sourceIds: sources.slice(0, 2), query: null, view: "list" });
  const reading = createBasket(app, p, { name: "Reading", captureMode: "text" });
  const later = createBasket(app, p, { name: "Later", captureMode: "metadata" });
  const entries = Array.from({ length: 60 }, (_, i) => entry(`feed/${i % 3}`));
  applySyncBatch(app, p.engineUserId, batch(entries));
  const items = listItems(app, p, { scope: "all", limit: 60 }).items;
  for (const [i, item] of items.slice(0, 12).entries()) keepItem(app, p, item.id, i % 2 ? reading.id : later.id);
  return { app, p, entries, cleanup };
}

/** The entries the engine delivered for the items kept in a basket. */
function keptEntries(app: App, entries: SyncEntry[]): SyncEntry[] {
  const urls = new Set(app.db.all<{ url: string }>("SELECT i.url FROM items i JOIN basket_items b ON b.item_id = i.id").map((r) => r.url));
  return entries.filter((e) => e.url && urls.has(e.url));
}

test("the storage split, the bootstrap queries and the sync path never read a whole table to find rows", (t) => {
  const { app, p, entries, cleanup } = populated();
  t.after(cleanup);
  const { seen: bootstrap } = recordQueries(app, () => {
    listCollections(app, p);
    listSources(app, p);
    listBaskets(app, p);
    getPreferences(app, p.workspaceId);
    summary(app, p.accountId);
    unreadCount(app, p.workspaceId);
  });
  assert.ok(bootstrap.some((q) => q.sql.includes("stored_objects")) && bootstrap.some((q) => q.sql.includes("FROM items WHERE workspace_id")), "the recording saw the queries that matter");

  // The sync path's lookups: an upstream edit of a kept item, a new entry, and an entry for an item that is already there
  // without a mapping from this engine (as after an import) and is found by its link.
  const source = app.db.get<{ id: string }>("SELECT id FROM sources WHERE engine_stream_id = 'feed/0'")!.id;
  const known = insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId: source, kind: "article", title: "Imported", url: "https://example.org/imported",
    author: null, summaryHtml: null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: null, discoveredAt: new Date().toISOString(), enclosures: [], fresh: false, reason: "import",
  });
  assert.ok(known.id);
  const edited = keptEntries(app, entries)[0]!;
  const { seen: sync, result } = recordQueries(app, () => applySyncBatch(app, p.engineUserId, batch([
    { ...edited, title: "Edited upstream", contentHtml: "<p>New text.</p>" },
    entry("feed/1"),
    entry("feed/0", { url: "https://example.org/imported" }),
  ])));
  assert.deepEqual([result.accepted, result.updated, result.duplicates], [1, 1, 1], "an edit, a new item, and one matched by its link");
  assert.ok(sync.some((q) => /source_id = \? AND i\.url = \?/.test(q.sql)), "the lookup by source and link ran");

  // The counting and storage queries must run the way they were designed, which "no scan" alone does not say: the
  // counts read the rare rows from their partial index, the storage split reads one covering index and finds the pinned
  // versions and kept copies by id (a planner left to itself walks every copy against every pinned one).
  const planOf = (q: Seen) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  const designed = (pattern: RegExp, expected: RegExp, what: string) => {
    const hits = bootstrap.filter((q) => pattern.test(q.sql));
    assert.ok(hits.length > 0, `bootstrap runs ${what}`);
    for (const q of hits) assert.ok(planOf(q).some((l) => expected.test(l)), `${what} should plan as ${expected}:\n${planOf(q).join("\n")}`);
  };
  designed(/FROM item_state st JOIN items i ON i\.id = st\.item_id\s+WHERE st\.workspace_id = \?/, /COVERING INDEX item_state_rare/, "the counts of acted-on and New items");
  designed(/GROUP BY kind, is_current/, /COVERING INDEX stored_objects_account/, "the storage split's totals");
  designed(/CROSS JOIN stored_objects o ON o\.kind = 'item_version'/, /SEARCH o USING INDEX stored_objects_live/, "the pinned versions' lookup");
  designed(/CROSS JOIN stored_objects o ON o\.kind IN \('capture', 'image'\)/, /SEARCH o USING INDEX stored_objects_item/, "the kept copies' and pictures' lookup");

  // A page in the default order or in title order is read from its index in order, with no sorting of the rest.
  for (const [sort, index] of [["newest", "items_ws_sortkey"], ["title", "items_ws_title"]] as const) {
    const { seen: pageQueries } = recordQueries(app, () => listItems(app, p, { scope: "all", sort, limit: 5 }));
    const page = pageQueries.find((q) => /ORDER BY sort_key/.test(q.sql))!;
    const lines = planOf(page);
    assert.ok(lines.some((l) => l.includes(index)) && !lines.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), `${sort} order reads ${index}:\n${lines.join("\n")}`);
  }

  // After each batch a source's newest item time is one row from its own index, not the maximum over all its items.
  const newest = sync.filter((q) => q.sql.includes("SET last_item_at"));
  assert.ok(newest.length > 0, "the sync updated a source's newest item time");
  for (const q of newest) {
    const lines = planOf(q);
    assert.ok(lines.some((l) => /SEARCH items USING (COVERING )?INDEX items_source_sortkey \(workspace_id=\? AND source_id=\?\)/.test(l)) && !lines.some((l) => /TEMP B-TREE/.test(l)), `newest item time reads the source's index in order:\n${lines.join("\n")}`);
  }

  const found = [...bootstrap, ...sync].flatMap((q) => fullScans(app, q).map((line) => `${line}  <-  ${q.sql.replace(/\s+/g, " ").slice(0, 90)}`));
  assert.deepEqual(found, []);
});

/** The same split worked out in plain code from the tables, one object at a time. */
function splitInCode(app: App, accountId: string): { kept: number; feed: number; other: number } {
  const keptVersions = new Set(app.db.all<{ v: string }>("SELECT version_id AS v FROM basket_items").map((r) => r.v));
  const keptItems = new Set(app.db.all<{ i: string }>("SELECT item_id AS i FROM basket_items").map((r) => r.i));
  const current = new Set(app.db.all<{ v: string }>("SELECT current_version_id AS v FROM items").map((r) => r.v));
  const out = { kept: 0, feed: 0, other: 0 };
  for (const o of app.db.all<{ kind: string; ref_id: string; item_id: string | null; bytes: number }>("SELECT kind, ref_id, item_id, bytes FROM stored_objects WHERE account_id = ? AND released_at IS NULL", accountId)) {
    if ((o.kind === "item_version" && keptVersions.has(o.ref_id)) || (o.kind === "capture" && o.item_id !== null && keptItems.has(o.item_id))) out.kept += o.bytes;
    else if ((o.kind === "item_version" && current.has(o.ref_id)) || (o.kind === "capture" && o.item_id !== null)) out.feed += o.bytes;
    else out.other += o.bytes;
  }
  return out;
}

test("the storage split matches the objects, worked out independently, with kept, superseded and captured versions", (t) => {
  const { app, p, entries, cleanup } = populated();
  t.after(cleanup);
  // Kept items whose original then changed upstream (a pinned old version and a new current one), a finished capture,
  // an item with no basket, and the small state records.
  const edited = keptEntries(app, entries).slice(0, 4).map((e) => ({ ...e, title: `${e.title} (edited)`, contentHtml: "<p>New text.</p>" }));
  assert.equal(applySyncBatch(app, p.engineUserId, batch(edited)).updated, 4);
  assert.ok(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions v WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = v.id)")!.n >= 4, "old versions stay pinned");
  const capture = app.db.get<{ id: string }>("SELECT id FROM captures WHERE status = 'pending' LIMIT 1")!;
  completeCapture(app, capture.id, { ok: true, title: "t", text: "readable text", html: "<p>readable text</p>", finalUrl: "https://example.org/x", bytes: 13 });
  const now = categories(app, p.accountId);
  assert.ok(now.kept > 0 && now.feed > 0 && now.other > 0, "all three groups are in play");
  assert.deepEqual({ ...now }, splitInCode(app, p.accountId));
  // Another account's objects never count.
  const other = makeOwner(app, { admin: false });
  assert.deepEqual({ ...categories(app, other.accountId) }, { kept: 0, feed: 0, other: 0 });
});

const DATA_ROOT = path.resolve(import.meta.dirname, "../../../../data");

test("a generated 20,000-item account: the storage split and the bootstrap queries stay fast", { timeout: 600_000 }, (t) => {
  mkdirSync(DATA_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(DATA_ROOT, "test-dataset-"));
  const data = buildDataset({ dir, accounts: 1, sources: 100, items: 20_000 });
  t.after(() => { data.close(); rmSync(dir, { recursive: true, force: true }); });
  const { app } = data;
  const p = data.accounts[0]!.principal;
  const median = (run: () => unknown) => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[2]!;
  };

  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 20_000);
  const split = categories(app, p.accountId);
  assert.ok(split.kept > 0 && split.feed > 0 && split.other > 0);
  // Without the index this scans every item for each of the 20 000 stored objects: tens of seconds.
  const splitMs = median(() => categories(app, p.accountId));
  assert.ok(splitMs < 1000, `the storage split took ${Math.round(splitMs)} ms`);
  const bootstrapMs = median(() => {
    listCollections(app, p);
    listSources(app, p);
    listBaskets(app, p);
    getPreferences(app, p.workspaceId);
    summary(app, p.accountId);
    unreadCount(app, p.workspaceId);
  });
  assert.ok(bootstrapMs < 1500, `the bootstrap queries took ${Math.round(bootstrapMs)} ms`);
});

test("the dataset generator builds separate, realistic accounts", { timeout: 120_000 }, (t) => {
  mkdirSync(DATA_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(DATA_ROOT, "test-dataset-"));
  const data = buildDataset({ dir, accounts: 2, sources: 12, items: 400, seed: 7 });
  t.after(() => { data.close(); rmSync(dir, { recursive: true, force: true }); });
  const { app } = data;
  assert.equal(data.accounts.length, 2);
  for (const a of data.accounts) {
    const ws = a.principal.workspaceId;
    const n = (sql: string) => app.db.get<{ n: number }>(sql, ws)!.n;
    assert.equal(n("SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?"), 400);
    assert.equal(a.sourceIds.length, 12);
    assert.ok(n("SELECT COUNT(*) AS n FROM basket_items WHERE workspace_id = ?") > 0, "kept items");
    assert.ok(n("SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?") > 0, "captures");
    assert.ok(n("SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ?") > 0, "notifications");
    assert.ok(n("SELECT COUNT(DISTINCT workflow) AS n FROM item_state WHERE workspace_id = ?") >= 3, "workflow states");
    assert.ok(n("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND fresh = 0") > 0 && n("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND fresh = 1") > 0, "some New, some not");
    // Every item belongs to a source of the same account: accounts never share rows.
    assert.equal(n("SELECT COUNT(*) AS n FROM items i JOIN sources s ON s.id = i.source_id WHERE i.workspace_id = ? AND s.workspace_id <> i.workspace_id"), 0);
  }
});

test("after a sync a source's newest item time is the latest date among its items", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app);
    const a = makeSource(app, p, "A", "feed/a");
    const b = makeSource(app, p, "B", "feed/b");
    const day = (n: number) => new Date(Date.UTC(2026, 5, n)).toISOString();
    applySyncBatch(app, p.engineUserId, batch([
      entry("feed/a", { publishedAt: day(3), crawledAt: day(20) }),
      entry("feed/a", { publishedAt: day(9), crawledAt: day(10) }),
      entry("feed/a", { publishedAt: null, crawledAt: day(15) }), // no publication date: its discovery date counts
      entry("feed/b", { publishedAt: day(1), crawledAt: day(2) }),
    ]));
    const latest = (id: string) => app.db.get<{ t: string }>("SELECT MAX(COALESCE(published_at, discovered_at)) AS t FROM items WHERE source_id = ?", id)!.t;
    const stored = (id: string) => app.db.get<{ t: string | null }>("SELECT last_item_at AS t FROM sources WHERE id = ?", id)!.t;
    assert.equal(stored(a), day(15));
    assert.equal(stored(a), latest(a));
    assert.equal(stored(b), latest(b));
    applySyncBatch(app, p.engineUserId, batch([entry("feed/a", { publishedAt: day(12), crawledAt: day(30) })]));
    assert.equal(stored(a), latest(a), "a later item moves it; an older one would not");
    assert.equal(stored(a), day(15));
  } finally { cleanup(); }
});
