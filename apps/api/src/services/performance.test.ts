import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { SyncEntry } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { buildDataset } from "../../../../scripts/dataset.ts";
import { pausedReason } from "./storage.ts";
import { applySyncBatch } from "./sync.ts";
import { createBasket, createCollection, listBaskets, listCollections } from "./collections.ts";
import { listSources } from "./sources.ts";
import { insertItem, listItems, listTuning } from "./items.ts";
import { keepItem } from "./state.ts";
import { getPreferences, setPreferences } from "./preferences.ts";
import { homeOverview } from "./home.ts";
import { mutedScan } from "./muted.ts";
import { matchesMuted, mutedPatterns } from "./muted-match.ts";
import { unreadCount } from "./notifications.ts";

/*
 * Size defects only show above a few thousand items: a lookup without an index costs nothing on a test
 * database and a minute on a real one. These tests look at how queries are executed, and at timings with a
 * wide margin, on data shaped like a real account (scripts/dataset.ts).
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

test("the bootstrap queries and the sync path never read a whole table to find rows", (t) => {
  const { app, p, entries, cleanup } = populated();
  t.after(cleanup);
  const { seen: bootstrap } = recordQueries(app, () => {
    listCollections(app, p);
    listSources(app, p);
    listBaskets(app, p);
    getPreferences(app, p.workspaceId);
    pausedReason(app, p.accountId);
    unreadCount(app, p.workspaceId);
  });
  assert.ok(bootstrap.some((q) => q.sql.includes("FROM items WHERE workspace_id")), "the recording saw the queries that matter");

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

  // The counting queries must run the way they were designed, which "no scan" alone does not say: the
  // counts read the rare rows from their partial index.
  const planOf = (q: Seen) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  const designed = (pattern: RegExp, expected: RegExp, what: string) => {
    const hits = bootstrap.filter((q) => pattern.test(q.sql));
    assert.ok(hits.length > 0, `bootstrap runs ${what}`);
    for (const q of hits) assert.ok(planOf(q).some((l) => expected.test(l)), `${what} should plan as ${expected}:\n${planOf(q).join("\n")}`);
  };
  designed(/FROM item_state\s+WHERE workspace_id = \? AND NOT \(workflow = 'new' AND fresh = 0\)/, /COVERING INDEX item_state_rare/, "the counts of acted-on, New and Ignored items, from the index alone");

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

const DATA_ROOT = path.resolve(import.meta.dirname, "../../../../data");

test("a generated 20,000-item account: the bootstrap queries stay fast", { timeout: 600_000 }, (t) => {
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
  const bootstrapMs = median(() => {
    listCollections(app, p);
    listSources(app, p);
    listBaskets(app, p);
    getPreferences(app, p.workspaceId);
    pausedReason(app, p.accountId);
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

test("an account that followed its sources from now has most items Ignored: Home and the counts leave them out, and a page reads the date index in order", { timeout: 120_000 }, (t) => {
  mkdirSync(DATA_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(DATA_ROOT, "test-dataset-"));
  const data = buildDataset({ dir, accounts: 1, sources: 12, items: 600, seed: 11, startFrom: "now" });
  t.after(() => { data.close(); rmSync(dir, { recursive: true, force: true }); });
  const { app } = data;
  const { principal: p } = data.accounts[0]!;
  const n = (sql: string) => app.db.get<{ n: number }>(sql, p.workspaceId)!.n;
  const hidden = n("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND workflow = 'ignored'");
  assert.ok(hidden > 600 * 0.6, `most items are back catalogue, which arrived Ignored (${hidden} of 600)`);
  assert.equal(n("SELECT COUNT(*) AS n FROM item_state WHERE workspace_id = ? AND workflow = 'ignored' AND fresh = 1"), 0, "and none of them is New");

  const was = listTuning.countFromRowsBelowShare;
  listTuning.countFromRowsBelowShare = 5; // the collection's total is counted from its rows, not from the counts
  const { result, seen } = (() => {
    try {
      return recordQueries(app, () => {
        const home = homeOverview(app, p);
        const page = listItems(app, p, { scope: "home", mix: "home", filter: "new", limit: 50 });
        const collection = listItems(app, p, { scope: `collection:${listCollections(app, p)[0]!.id}`, limit: 50 });
        listSources(app, p);
        return { home, page, collection };
      });
    } finally { listTuning.countFromRowsBelowShare = was; }
  })();
  const shown = n("SELECT COUNT(*) AS n FROM items i JOIN item_state st ON st.item_id = i.id JOIN sources s ON s.id = i.source_id WHERE i.workspace_id = ? AND s.followed = 1 AND st.workflow = 'new' AND st.fresh = 0");
  assert.equal(result.home.unread, shown, "Home counts the older items that show, not the Ignored ones");
  const ignoredIds = new Set(app.db.all<{ id: string }>("SELECT item_id AS id FROM item_state WHERE workspace_id = ? AND workflow = 'ignored'", p.workspaceId).map((r) => r.id));
  assert.ok(result.page.items.length > 0 && result.page.items.every((i) => !ignoredIds.has(i.id)) && result.collection.items.every((i) => !ignoredIds.has(i.id)), "no Ignored item on Home or in the collection");
  const planOf = (q: Seen) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  const pages = seen.filter((q) => /ORDER BY sort_key/.test(q.sql));
  assert.ok(pages.length >= 2);
  for (const q of pages) assert.ok(planOf(q).some((l) => /^SEARCH i USING (COVERING )?INDEX items_ws_sortkey/.test(l)) && !planOf(q).some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), `a page reads the date index in order:\n${planOf(q).join("\n")}`);
  // Counting a collection from its rows reads the source index alone for the items.
  const counting = seen.filter((q) => /^\s*SELECT COUNT\(\*\) AS n FROM items i JOIN item_state st/.test(q.sql) && /collection_sources/.test(q.sql));
  assert.ok(counting.length > 0, "the collection's total was counted from its rows");
  for (const q of counting) assert.ok(planOf(q).some((l) => /COVERING INDEX items_source_sortkey/.test(l)), `counting a collection's rows reads the source index alone:\n${planOf(q).join("\n")}`);
});

test("after a sync a source's newest item time is the latest time its items are listed at", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app);
    const a = makeSource(app, p, "A", "feed/a");
    const b = makeSource(app, p, "B", "feed/b");
    const day = (n: number) => new Date(Date.UTC(2026, 5, n)).toISOString();
    applySyncBatch(app, p.engineUserId, batch([
      entry("feed/a", { publishedAt: day(3), crawledAt: day(20) }),
      entry("feed/a", { publishedAt: day(9), crawledAt: day(10) }),
      entry("feed/a", { publishedAt: null, crawledAt: day(15) }),
      entry("feed/b", { publishedAt: day(1), crawledAt: day(2) }),
    ]));
    const latest = (id: string) => app.db.get<{ t: string }>("SELECT MAX(listed_at) AS t FROM items WHERE source_id = ?", id)!.t;
    const stored = (id: string) => app.db.get<{ t: string | null }>("SELECT last_item_at AS t FROM sources WHERE id = ?", id)!.t;
    assert.equal(stored(a), day(20), "the sources are settled, so their posts are listed when they arrived");
    assert.equal(stored(a), latest(a));
    assert.equal(stored(b), latest(b));
    applySyncBatch(app, p.engineUserId, batch([entry("feed/a", { publishedAt: day(12), crawledAt: day(30) })]));
    assert.equal(stored(a), latest(a), "a later item moves it; an older one would not");
    assert.equal(stored(a), day(30));
  } finally { cleanup(); }
});

test("the queue page and Home's To read rows find what was put aside or started by state in the workspace's own index, not by probing every item", (t) => {
  const { app, p, cleanup } = populated();
  t.after(cleanup);
  const planOf = (q: Seen) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  app.db.run("UPDATE item_state SET workflow = 'toread' WHERE item_id IN (SELECT id FROM items ORDER BY seq LIMIT 4)");
  app.db.run("UPDATE item_state SET workflow = 'inprogress' WHERE item_id IN (SELECT id FROM items ORDER BY seq DESC LIMIT 3)");
  const { seen: pages } = recordQueries(app, () => listItems(app, p, { scope: "toread", sort: "newest", limit: 5 }));
  const { seen: rows } = recordQueries(app, () => homeOverview(app, p));
  const queue = [
    ...pages.filter((q) => /ORDER BY/.test(q.sql) && /st\.workspace_id = \? AND st\.workflow IN \('toread', 'inprogress'\)/.test(q.sql)),
    ...rows.filter((q) => /COUNT\(\*\) OVER \(\)/.test(q.sql)),
  ];
  assert.equal(queue.length, 2 + 3, "the page's two runs and Home's three rows");
  for (const q of queue) {
    const lines = planOf(q);
    assert.ok(lines.some((l) => /^SEARCH st USING INDEX item_state_ws \(workspace_id=\? AND workflow=\?\)/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /^SCAN (i|items)\b/.test(l) || /USING (COVERING )?INDEX items_ws_(visible_sortkey|number)/.test(l)), `the items are looked up by id:\n${lines.join("\n")}`);
  }
});

test("Home reads New items, the newest open items and its rows by id, and the kept and source orders read their indexes in order", (t) => {
  const { app, p, cleanup } = populated();
  t.after(cleanup);
  const planOf = (q: Seen) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  const planned = (queries: Seen[], pattern: RegExp, expected: RegExp, what: string) => {
    const hits = queries.filter((q) => pattern.test(q.sql));
    assert.ok(hits.length > 0, `runs ${what}`);
    for (const q of hits) {
      const lines = planOf(q);
      assert.ok(lines.some((l) => expected.test(l)) && !lines.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), `${what} should plan as ${expected}, unsorted:\n${lines.join("\n")}`);
    }
  };
  // Back from a long absence, with a muted word: "since the last visit" is read from the New items, not from everything that
  // arrived since; what the muted words hid is counted among the newest open items, read newest first; the rows' items by id.
  app.db.run("UPDATE workspaces SET last_visit_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", p.workspaceId);
  app.db.run("UPDATE item_state SET workflow = 'toread' WHERE item_id IN (SELECT id FROM items ORDER BY seq LIMIT 3)");
  app.db.run("UPDATE items SET title = 'Garden notes' WHERE id IN (SELECT id FROM items ORDER BY seq DESC LIMIT 4)");
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "garden", until: null }] });
  const { result, seen } = recordQueries(app, () => homeOverview(app, p));
  assert.ok(result.since && result.toRead.items.length > 0 && result.mutedHidden > 0, "every part of Home is in play");
  planned(seen, /SELECT i\.source_id, COUNT\(\*\) AS n FROM item_state st/, /SEARCH st USING INDEX item_state_fresh/, "New since the last visit");
  planned(seen, /SUM\(purss_muted/, /SEARCH i USING INDEX items_ws_sortkey/, "what the muted words hid");
  planned(seen, /AND \+i\.workspace_id = \?/, /USING INDEX sqlite_autoindex_(items|item_state)_1 \((id|item_id)=\?\)/, "the rows' items");

  // Counted among the first candidates only, newest first and by id within the same date: the muted items straddle the cut.
  app.db.run("UPDATE items SET listed_at = '2027-01-01T00:00:00.000Z' WHERE id IN (SELECT id FROM items ORDER BY seq DESC LIMIT 8)");
  const was = mutedScan.rows;
  mutedScan.rows = 5;
  try {
    const candidates = app.db.all<{ id: string; title: string; excerpt: string | null; key: string }>(
      `SELECT i.id, i.title, i.excerpt, i.listed_at AS key FROM items i JOIN item_state st ON st.item_id = i.id
       WHERE i.workspace_id = ? AND st.workflow IN ('new', 'toread')`, p.workspaceId)
      .sort((a, b) => (a.key === b.key ? (a.id < b.id ? 1 : -1) : a.key < b.key ? 1 : -1)).slice(0, mutedScan.rows + 1);
    const patterns = mutedPatterns(["garden"])!;
    const home = homeOverview(app, p);
    assert.deepEqual([home.mutedHidden, home.mutedHiddenAtLeast], [candidates.filter((c) => matchesMuted(patterns, c.title, c.excerpt)).length, true]);
  } finally { mutedScan.rows = was; }

  // A page sorted by kept time or by source is read from its index in order, like the date orders; a source with few items is
  // sorted from its own rows instead of looked for along the whole PURSS's index.
  const source = app.db.get<{ id: string }>("SELECT id FROM sources WHERE workspace_id = ? ORDER BY title LIMIT 1", p.workspaceId)!.id;
  for (const [sort, index] of [["kept", "items_ws_kept"], ["source", "items_ws_source_title"]] as const) {
    const { seen: pageQueries } = recordQueries(app, () => listItems(app, p, { scope: "all", sort, limit: 5, muted: "show" }));
    planned(pageQueries, /ORDER BY sort_key/, new RegExp(`SEARCH i USING (COVERING )?INDEX ${index}`), `the ${sort} order`);
    for (const query of [{ scope: `source:${source}` }, { scope: "all", source }]) {
      const { seen: fewQueries } = recordQueries(app, () => listItems(app, p, { ...query, sort, limit: 5, muted: "show" }));
      const page = fewQueries.find((q) => /ORDER BY \+\(sort_key\)/.test(q.sql));
      assert.ok(page, `a source's few items, sort ${sort}: sorted, not read in index order`);
      const lines = planOf(page);
      assert.ok(lines.some((l) => /SEARCH i USING (COVERING )?INDEX \w+ \(workspace_id=\? AND source_id=\?\)/.test(l)) && !lines.some((l) => l.includes(index)), `${JSON.stringify(query)} sort ${sort}:\n${lines.join("\n")}`);
    }
  }
});
