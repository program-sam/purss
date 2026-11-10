import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowState } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { bulk, changeState, keepItem } from "./state.ts";
import { createBasket, createCollection, listCollections } from "./collections.ts";
import { VISIBLE_SOURCE, insertItem, listItems, listTuning, scopeClause } from "./items.ts";
import { itemCounts } from "./counts.ts";
import { listSources, unfollowSource } from "./sources.ts";
import type { SqlParam } from "../db/database.ts";

/*
 * The source list, the collection list and the totals of item lists add up one set of counts instead of counting rows
 * for each. These tests build PURSSes with the awkward cases (sources no longer followed, hand-kept links without a
 * source, items kept from sources that were unfollowed, every workflow state, New and not) at random and check every
 * number against the queries the counts replaced, which are kept here as the reference.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATES: WorkflowState[] = ["new", "toread", "inprogress", "finished", "ignored"];

type World = { app: App; p: Principal & { engineUserId: string }; sources: string[]; collections: string[]; queryCollection: string; baskets: string[]; cleanup: () => void };

/** A PURSS with every awkward case, from a seed. */
function build(seed: number): World {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const sources = Array.from({ length: 9 }, (_, i) => makeSource(app, p, `Source ${i}`, `feed/${i}`));
  const manual = makeSource(app, p, "Saved links", "feed/manual", { kind: "manual" });
  const baskets = [createBasket(app, p, { name: "One", captureMode: "metadata" }).id, createBasket(app, p, { name: "Two", captureMode: "metadata" }).id];
  const entries = Array.from({ length: 120 + Math.floor(r() * 120) }, () => entry(`feed/${Math.floor(r() * 9)}`));
  applySyncBatch(app, p.engineUserId, batch(entries));
  // Items without a source, and items of the hand-kept source.
  for (let i = 0; i < 6; i++) {
    insertItem(app, {
      accountId: p.accountId, workspaceId: p.workspaceId, sourceId: i < 3 ? null : manual, kind: "article", title: `Kept by hand ${i}`, url: `https://example.org/hand/${i}`,
      author: null, summaryHtml: null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
      publishedAt: null, discoveredAt: new Date().toISOString(), enclosures: [], fresh: r() < 0.5, reason: "keep",
    });
  }
  const ids = () => app.db.all<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? ORDER BY seq", p.workspaceId).map((x) => x.id);
  // Workflow states and cleared New markers, at random.
  for (const workflow of ["toread", "inprogress", "finished", "ignored"] as const) {
    const some = ids().filter(() => r() < 0.12);
    if (some.length) bulk(app, p, some, { type: "workflow", workflow });
  }
  const cleared = ids().filter(() => r() < 0.4);
  if (cleared.length) bulk(app, p, cleared, { type: "clearFresh" });
  changeState(app, p, ids()[0]!, { workflow: "finished", expectedRevision: app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", ids()[0]!)!.revision });
  // Keep some items, then stop following two sources: their items leave the lists unless kept.
  for (const id of ids().filter(() => r() < 0.1)) keepItem(app, p, id, pick(baskets));
  const collections = [
    createCollection(app, p, { name: "A", emoji: null, mode: "sources", sourceIds: sources.slice(0, 4), query: null, view: "list" }).id,
    createCollection(app, p, { name: "B", emoji: null, mode: "sources", sourceIds: sources.slice(3, 8), query: null, view: "list" }).id,
    createCollection(app, p, { name: "Empty", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" }).id,
  ];
  const queryCollection = createCollection(app, p, { name: "Unread", emoji: null, mode: "query", sourceIds: [], query: { field: "workflow", value: ["new"] }, view: "list" }).id;
  unfollowSource(app, p, sources[1]!);
  unfollowSource(app, p, sources[5]!);
  // Some more arrivals after the changes.
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: 30 }, () => entry(`feed/${Math.floor(r() * 9)}`))));
  return { app, p, sources, collections, queryCollection, baskets, cleanup };
}

/** The queries the counts replaced. */
function referenceTotal(app: App, p: Principal, scope: string, filter: string): number {
  const params: SqlParam[] = [p.workspaceId];
  const where = ["i.workspace_id = ?", scopeClause(app, p, scope, params), VISIBLE_SOURCE];
  if (filter === "fresh") where.push("st.fresh = 1");
  else if (filter === "active") where.push("st.workflow <> 'ignored'");
  else if (filter !== "all") { where.push("st.workflow = ?"); params.push(filter); }
  return app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id WHERE ${where.join(" AND ")}`, ...params)!.n;
}

const SEEDS = [1, 2, 3, 4, 5, 6];

test("source and collection counts equal the queries they replaced, in every awkward PURSS", () => {
  for (const seed of SEEDS) {
    const w = build(seed);
    try {
      const listed = listSources(w.app, w.p);
      assert.ok(listed.length >= 6);
      for (const s of listed) {
        const fresh = w.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.source_id = ? AND st.fresh = 1", s.id)!.n;
        const items = w.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items i WHERE i.source_id = ?", s.id)!.n;
        assert.deepEqual([s.freshCount, s.itemCount], [fresh, items], `seed ${seed}, ${s.title}`);
      }
      for (const c of listCollections(w.app, w.p)) {
        if (c.mode !== "sources") continue;
        const row = w.app.db.get<{ fresh: number; items: number }>(
          `SELECT COALESCE(SUM(st.fresh), 0) AS fresh, COUNT(*) AS items FROM items i JOIN item_state st ON st.item_id = i.id
           WHERE i.workspace_id = ? AND st.workflow <> 'ignored' AND i.source_id IN (SELECT source_id FROM collection_sources WHERE collection_id = ?)`, w.p.workspaceId, c.id)!;
        assert.deepEqual([c.freshCount, c.itemCount], [row.fresh, row.items], `seed ${seed}, ${c.name}`);
      }
    } finally { w.cleanup(); }
  }
});

test("the total of every list a person can open equals counting its rows", (t) => {
  // Small collections are counted from their rows; make the counts answer for them too, so both ways are compared.
  const was = listTuning.countFromRowsBelowShare;
  t.after(() => { listTuning.countFromRowsBelowShare = was; });
  let compared = 0;
  for (const below of [0, was]) {
    listTuning.countFromRowsBelowShare = below;
    compared += everyListTotal();
  }
  assert.ok(compared > 1000);
});

function everyListTotal(): number {
  let compared = 0;
  for (const seed of SEEDS) {
    const w = build(seed);
    try {
      const scopes = ["all", "home", "fresh", "toread", "loose", `collection:${w.collections[0]}`, `collection:${w.collections[1]}`, `collection:${w.collections[2]}`, `collection:${w.queryCollection}`,
        `source:${w.sources[0]}`, `source:${w.sources[1]}`, `basket:${w.baskets[0]}`];
      for (const scope of scopes) {
        for (const filter of ["all", "active", "fresh", ...STATES]) {
          const total = listItems(w.app, w.p, { scope, filter: filter as never, limit: 5 }).total;
          assert.equal(total, referenceTotal(w.app, w.p, scope, filter), `seed ${seed}, ${scope}, filter ${filter}`);
          compared++;
        }
      }
      // Items of a source nobody follows any more are listed only while a basket keeps them.
      assert.ok(w.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items i JOIN sources s ON s.id = i.source_id WHERE s.followed = 0")!.n > 0);
    } finally { w.cleanup(); }
  }
  return compared;
}

test("counts are reused until something is written, and never kept from inside a transaction that rolls back", () => {
  const w = build(7);
  try {
    const first = itemCounts(w.app, w.p.workspaceId);
    assert.equal(itemCounts(w.app, w.p.workspaceId), first, "nothing written: the same counts");
    applySyncBatch(w.app, w.p.engineUserId, batch([entry("feed/0")]));
    const second = itemCounts(w.app, w.p.workspaceId);
    assert.notEqual(second, first, "a write: counted again");
    assert.equal(second.items(w.sources[0]!), first.items(w.sources[0]!) + 1);

    // Counted inside a transaction that is rolled back: the rolled-back rows must not be remembered.
    const before = second.items(w.sources[0]!);
    assert.throws(() => w.app.db.tx(() => {
      applySyncBatch(w.app, w.p.engineUserId, batch([entry("feed/0"), entry("feed/0")]));
      assert.equal(itemCounts(w.app, w.p.workspaceId).items(w.sources[0]!), before + 2);
      throw new Error("roll back");
    }), /roll back/);
    assert.equal(itemCounts(w.app, w.p.workspaceId).items(w.sources[0]!), before, "the rolled-back items are not counted");
  } finally { w.cleanup(); }
});

test("pages in title order, read from the index, come out in the same order as sorting the whole list", () => {
  const w = build(3);
  try {
    const everything = listItems(w.app, w.p, { scope: "all", limit: 200 }).items;
    const expected = [...everything].sort((a, b) => {
      const x = a.title.toLowerCase(), y = b.title.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }).map((i) => i.id);
    const seen: string[] = [];
    for (let cursor: string | undefined, guard = 0; guard < 100; guard++) {
      const page = listItems(w.app, w.p, { scope: "all", sort: "title", limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(everything.length < 200, true, "the list fits in one page of 200, so it is the whole list");
    assert.deepEqual(seen, expected);
  } finally { w.cleanup(); }
});
