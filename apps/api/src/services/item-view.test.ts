import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@purss/domain";
import type { QueryNode, WorkflowState } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { applyUndo, bulk, clearNewAll, keepItem } from "./state.ts";
import { createBasket, createCollection, listCollections } from "./collections.ts";
import { listItemIds, listItems } from "./items.ts";
import { insertItem } from "./item-store.ts";
import { viewTuning } from "./item-view.ts";
import { applySyncBatch } from "./sync.ts";
import { putAnnotation } from "./annotations.ts";
import { unfollowSource } from "./sources.ts";
import { searchItems } from "./search.ts";
import { homeOverview } from "./home.ts";
import { collectionStats, sourceStats } from "./statistics.ts";
import { projection, saveShare } from "./shares.ts";

/*
 * What a list, a collection's count, a search and Home show is decided in one place (item-view.ts). These tests ask the interface
 * every question a person can ask of it, in a PURSS holding every awkward case (items of sources nobody follows any more, kept or
 * annotated or both, in every workflow state, New and not), and compare the answers with a model written out in plain
 * code from what each item is, not with another query: the rows of a list are what its scope, state filter and the visible-source
 * rule allow; its total, the count of its collection and the ids "Select all" takes are that many.
 */

type Owner = Principal & { engineUserId: string };
type Kind = { workflow: WorkflowState; isNew: boolean };
type Item = { id: string; source: string | null; workflow: WorkflowState; isNew: boolean; kept: string | null; annotated: boolean };

const KINDS: Kind[] = [
  { workflow: "undecided", isNew: false }, { workflow: "undecided", isNew: true }, { workflow: "toread", isNew: false }, { workflow: "inprogress", isNew: false },
  { workflow: "finished", isNew: false }, { workflow: "ignored", isNew: false }, { workflow: "ignored", isNew: true },
];

type World = {
  app: App; p: Owner; items: Item[]; followed: Set<string>; sources: Record<"f1" | "f2" | "f3" | "u1" | "u2" | "hand", string>;
  baskets: string[]; collections: { a: string; b: string; unseen: string; named: string; everything: string; empty: string }; queries: Record<string, QueryNode>; cleanup: () => void;
};

/**
 * An Ignored item that is New again. No one sets that: the server takes the marker off an Ignored item. It is what Undo of a Clear New
 * leaves when another tab ignored the item in between (Undo puts the marker back whatever the item has become).
 */
function ignoredAndNew(app: App, p: Principal, itemId: string): void {
  const cleared = bulk(app, p, [itemId], { type: "clearNew" });
  bulk(app, p, [itemId], { type: "workflow", workflow: "ignored" });
  applyUndo(app, p, cleared.undoToken!);
}

/** Followed sources f1..f3 (f3 in no collection), sources u1 and u2 that were followed and no longer are, and hand-kept links, each holding one item of every kind that is kept, annotated, both or neither. */
function build(): World {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const sources = {
    f1: makeSource(app, p, "Followed one", "feed/f1"), f2: makeSource(app, p, "Followed two", "feed/f2"), f3: makeSource(app, p, "Followed three", "feed/f3"),
    u1: makeSource(app, p, "Unfollowed one", "feed/u1"), u2: makeSource(app, p, "Unfollowed two", "feed/u2"), hand: makeSource(app, p, "Saved links", "feed/hand", { kind: "manual" }),
  };
  const baskets = [createBasket(app, p, { name: "One", captureMode: "metadata" }).id, createBasket(app, p, { name: "Two", captureMode: "metadata" }).id];
  const items: Item[] = [];
  let n = 0;
  const add = (source: string | null, k: Kind, keep: boolean, annotate: boolean) => {
    n++;
    const r = insertItem(app, {
      accountId: p.accountId, sourceId: source, kind: "article", title: `Zebra post ${n} release 9.${n}`, url: `https://example.org/post/${n}`, author: null, summaryHtml: null, contentHtml: null,
      imageUrl: null, durationSeconds: null, doi: null, curatorNote: null, publishedAt: new Date(Date.UTC(2026, 9, 1) + n * 3600_000).toISOString(),
      discoveredAt: new Date(Date.UTC(2026, 9, 1) + n * 3600_000).toISOString(), enclosures: [], isNew: k.isNew, reason: "test",
    });
    if (k.workflow === "ignored" && k.isNew) ignoredAndNew(app, p, r.id);
    else if (k.workflow !== "undecided") bulk(app, p, [r.id], { type: "workflow", workflow: k.workflow });
    const basket = keep ? baskets[n % 2]! : null;
    if (basket) keepItem(app, p, r.id, basket);
    if (annotate) putAnnotation(app, p, r.id, newId("ann"), { kind: "note", body: `a note on ${n}`, updatedAt: nowIso() });
    // Keeping an item takes its New marker off (state.ts), so the model asks the database what the item is now.
    const st = app.db.get<{ workflow: WorkflowState; is_new: number }>("SELECT workflow, is_new FROM item_state WHERE item_id = ?", r.id)!;
    items.push({ id: r.id, source, workflow: st.workflow, isNew: st.is_new === 1, kept: basket, annotated: annotate });
  };
  for (const source of [sources.f1, sources.f2, sources.f3, sources.u1, sources.u2, sources.hand, null]) {
    for (const k of KINDS) {
      for (const [keep, annotate] of [[false, false], [true, false], [false, true], [true, true]] as const) add(source, k, keep, annotate);
    }
  }
  const query = (value: QueryNode) => value;
  const queries = {
    unseen: query({ field: "workflow", value: ["undecided", "toread"] }),
    named: query({ field: "source", value: [sources.u1, sources.f1] }),
    everything: query({ field: "kind", value: ["article"] }),
  };
  const col = (name: string, mode: "sources" | "filter", sourceIds: string[], q: QueryNode | null) =>
    createCollection(app, p, { name, emoji: null, mode, sourceIds, query: q, view: "list" }).id;
  const collections = {
    a: col("A", "sources", [sources.f1, sources.u1], null), b: col("B", "sources", [sources.f2, sources.u2], null), empty: col("Empty", "sources", [], null),
    unseen: col("Unseen", "filter", [], queries.unseen), named: col("Named", "filter", [], queries.named), everything: col("Everything", "filter", [], queries.everything),
  };
  unfollowSource(app, p, sources.u1);
  unfollowSource(app, p, sources.u2);
  return { app, p, items, followed: new Set([sources.f1, sources.f2, sources.f3]), sources, baskets, collections, queries, cleanup };
}

/** The visible-source rule: followed, kept by hand, without a source, kept in a basket or carrying a note or highlight. */
function visible(w: World, i: Item): boolean {
  return i.source === null || w.followed.has(i.source) || i.source === w.sources.hand || i.kept !== null || i.annotated;
}

function matches(w: World, q: QueryNode, i: Item): boolean {
  if ("all" in q) return q.all.every((x) => matches(w, x, i));
  if ("any" in q) return q.any.some((x) => matches(w, x, i));
  if ("not" in q) return !matches(w, q.not, i);
  if (q.field === "workflow") return q.value.includes(i.workflow);
  if (q.field === "source") return i.source !== null && q.value.includes(i.source);
  if (q.field === "kind") return q.value.includes("article");
  throw new Error(`the model does not know ${q.field}`);
}

/** The items a scope holds, before the state filter and the visible-source rule. */
function inScope(w: World, scope: string, i: Item): boolean {
  const [kind, id] = scope.split(":") as [string, string | undefined];
  switch (kind) {
    case "all": case "home": return true;
    case "new": return i.isNew;
    case "toread": return i.workflow === "toread" || i.workflow === "inprogress";
    // Followed sources in no collection of sources.
    case "loose": return i.source === w.sources.f3;
    case "source": return i.source === id;
    case "basket": return i.kept === id;
    case "collection":
      // A source stops belonging to its collections when it is unfollowed (sources.ts), so these two hold their followed source only.
      if (id === w.collections.a) return i.source === w.sources.f1;
      if (id === w.collections.b) return i.source === w.sources.f2;
      if (id === w.collections.empty) return false;
      return matches(w, id === w.collections.unseen ? w.queries.unseen! : id === w.collections.named ? w.queries.named! : w.queries.everything!, i);
    default: throw new Error(`the model does not know ${scope}`);
  }
}

function passes(filter: string, i: Item): boolean {
  if (filter === "all_with_ignored") return true;
  if (filter === "all") return i.workflow !== "ignored";
  if (filter === "new") return i.isNew;
  return i.workflow === filter;
}

/** Every row of a list, page by page. */
function rowsOf(w: World, query: Parameters<typeof listItems>[2]): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listItems(w.app, w.p, { ...query, limit: 40, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((x) => x.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

const FILTERS = ["all", "all_with_ignored", "new", "undecided", "toread", "inprogress", "finished", "ignored"] as const;

function scopesOf(w: World): string[] {
  const c = w.collections;
  return ["all", "home", "new", "toread", "loose", `collection:${c.a}`, `collection:${c.b}`, `collection:${c.empty}`, `collection:${c.unseen}`, `collection:${c.named}`, `collection:${c.everything}`,
    ...Object.values(w.sources).map((s) => `source:${s}`), ...w.baskets.map((b) => `basket:${b}`)];
}

test("every list shows the items its scope, state filter and the visible-source rule allow, and says so in its total, its collection's count and Select all", (t) => {
  const w = build();
  t.after(w.cleanup);
  assert.ok(w.items.some((i) => i.source !== null && !w.followed.has(i.source) && i.annotated && !i.kept), "an annotated item of a source nobody follows, kept by nothing");
  assert.ok(w.items.some((i) => !visible(w, i)), "an item no list shows");
  assert.ok(w.items.some((i) => i.workflow === "ignored" && i.isNew), "an Ignored item that is New");
  const was = viewTuning.countFromRowsBelowShare;
  t.after(() => { viewTuning.countFromRowsBelowShare = was; });
  const problems: string[] = [];
  const expect = (label: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };
  let compared = 0;
  // A collection of sources is counted from the PURSS's counts or from its rows, by its share of the sources: both are held to the model.
  for (const below of [0, was, 1]) {
    viewTuning.countFromRowsBelowShare = below;
    for (const scope of scopesOf(w)) {
      for (const filter of FILTERS) {
        const expected = w.items.filter((i) => inScope(w, scope, i) && passes(filter, i) && visible(w, i)).map((i) => i.id).sort();
        const label = `${scope}, filter ${filter}, counts below ${below}`;
        const rows = rowsOf(w, { scope, filter });
        expect(`rows of ${label}`, [...rows].sort().length, expected.length);
        expect(`which rows of ${label}`, [...rows].sort(), expected);
        expect(`total of ${label}`, listItems(w.app, w.p, { scope, filter, limit: 5 }).total, expected.length);
        const ids = listItemIds(w.app, w.p, { scope, filter });
        expect(`Select all of ${label}`, [[...ids.ids].sort(), ids.total], [expected, expected.length]);
        compared++;
      }
    }
    // The collections' own counts: what opening the collection shows, Ignored items left out; New is what is New among them.
    for (const c of listCollections(w.app, w.p)) {
      const scope = `collection:${c.id}`;
      expect(`${c.name}: itemCount, counts below ${below}`, c.itemCount, rowsOf(w, { scope, filter: "all" }).length);
      expect(`${c.name}: newCount, counts below ${below}`, c.newCount, rowsOf(w, { scope, filter: "new" }).filter((id) => w.items.find((i) => i.id === id)!.workflow !== "ignored").length);
      compared++;
    }
  }
  assert.ok(compared > 400);
  assert.deepEqual(problems.map((x) => x.replace(/"itm_[a-z0-9]+"/g, "id").replace(/col_[a-z0-9]+/g, "col").replace(/(\[(id,)*id\])+/g, "[ids]").slice(0, 140)), []);
});

test("a search finds what the visible-source rule lets through, an annotated item of an unfollowed source included", (t) => {
  const w = build();
  t.after(w.cleanup);
  const found = w.items.filter((i) => visible(w, i));
  const rows = rowsOf(w, { scope: "all", filter: "all_with_ignored", q: "zebra" });
  assert.deepEqual([...rows].sort(), found.map((i) => i.id).sort());
  assert.equal(listItems(w.app, w.p, { scope: "all", filter: "all_with_ignored", q: "zebra", limit: 5 }).total, found.length);
  // A version asked for exactly ("release 9.7") takes its own way to the items; it sees the same ones.
  const problems: string[] = [];
  for (const [n, i] of w.items.entries()) {
    const hit = searchItems(w.app, w.p, `9.${n + 1}`).map((x) => x.id);
    // The item with that exact version comes first; one the rule hides is not among the rest either.
    if (visible(w, i) ? hit[0] !== i.id : hit.includes(i.id)) problems.push(`post ${n + 1}: visible ${visible(w, i)}, found at ${hit.indexOf(i.id)}`);
  }
  assert.deepEqual(problems, []);
});

test("Home, the statistics and Clear New count the same items the lists show", (t) => {
  const w = build();
  t.after(w.cleanup);
  const shown = w.items.filter((i) => visible(w, i));
  const home = homeOverview(w.app, w.p);
  assert.equal(home.isNew, shown.filter((i) => i.isNew).length, "Home's New count");
  assert.equal(home.toRead.total + home.toWatch.total + home.toListen.total, shown.filter((i) => i.workflow === "toread" || i.workflow === "inprogress").length, "Home's queue");
  for (const [name, id] of Object.entries(w.collections)) {
    const stats = collectionStats(w.app, w.p, id).totals;
    const rows = rowsOf(w, { scope: `collection:${id}`, filter: "all_with_ignored" });
    assert.equal(stats.totalItems, rows.length, `the statistics of collection ${name}`);
    assert.equal(stats.workflow.ignored, rows.filter((r) => w.items.find((i) => i.id === r)!.workflow === "ignored").length, `its Ignored items, collection ${name}`);
  }
  for (const [name, id] of Object.entries(w.sources)) {
    assert.equal(sourceStats(w.app, w.p, id).stats.totalItems, rowsOf(w, { scope: `source:${id}`, filter: "all_with_ignored" }).length, `the statistics of source ${name}`);
  }
  const cleared = clearNewAll(w.app, w.p, "all");
  assert.equal(cleared.changed, shown.filter((i) => i.isNew).length, "what Clear New clears");
});

test("a readable copy that failed counts as failed in the bell's list and in a collection's rule alike, unless a later copy settled the item", (t) => {
  const w = build();
  t.after(w.cleanup);
  // Every mix of tries an item can have had, in the order they were made: f failed, p pending, d done in full, s done as part of the page only.
  const mixes = ["", "f", "p", "d", "s", "fd", "fp", "fs", "sf", "df", "pf", "fsf", "sfd", "fdf"];
  let at = 0;
  const made = new Map<string, string>();
  for (const [n, mix] of mixes.entries()) {
    const id = w.items.filter((i) => i.source !== null && w.followed.has(i.source) && i.workflow !== "ignored" && !i.kept && !i.annotated)[n]!.id;
    made.set(mix, id);
    for (const c of mix) {
      const status = c === "f" ? "failed" : c === "p" ? "pending" : "done";
      const quality = c === "s" ? "partial" : c === "d" ? "full" : null;
      const when = new Date(Date.UTC(2026, 10, 1, 8, 0, ++at)).toISOString();
      w.app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, quality, error, created_at, completed_at) VALUES (?, ?, ?, 'fulltext', ?, ?, ?, ?, ?)",
        newId("cap"), w.p.accountId, id, status, quality, status === "failed" ? "x" : null, when, status === "pending" ? null : when);
    }
  }
  const has = (mix: string, c: string) => mix.includes(c);
  const settled = (mix: string) => has(mix, "p") || has(mix, "d");
  const expected = {
    failed: mixes.filter((m) => has(m, "f") && !settled(m)),
    fulltext: mixes.filter((m) => has(m, "d")),
    pending: mixes.filter((m) => has(m, "p")),
  };
  const idsOf = (mixes: string[]) => mixes.map((m) => made.get(m)!).sort();
  const inCollection = (level: "failed" | "fulltext" | "pending") => {
    const c = createCollection(w.app, w.p, { name: `Copies ${level}`, emoji: null, mode: "filter", sourceIds: [], query: { field: "capture", value: [level] }, view: "list" });
    return rowsOf(w, { scope: `collection:${c.id}`, filter: "all" }).sort();
  };
  assert.deepEqual(listItems(w.app, w.p, { scope: "all", capture: "failed", limit: 50 }).items.map((i) => i.id).sort(), idsOf(expected.failed), "the bell's list");
  assert.deepEqual(inCollection("failed"), idsOf(expected.failed), "a collection's rule: the readable copy failed");
  assert.deepEqual(inCollection("fulltext"), idsOf(expected.fulltext), "a collection's rule: the full text was saved");
  assert.deepEqual(inCollection("pending"), idsOf(expected.pending), "a collection's rule: the copy is on its way");
});

test("a shared page leaves out what only the person's own notes keep in their list, and is in the order of the dates it shows", (t) => {
  const w = build();
  t.after(w.cleanup);
  // Highlights and notes are private: an unfollowed source's item that only they keep in the owner's list is not on the public page.
  saveShare(w.app, w.p, "collection", w.collections.everything, { curatorName: "Mara", description: null, listed: false });
  const share = w.app.db.get<{ id: string; target_kind: "collection"; target_id: string; account_id: string }>("SELECT id, target_kind, target_id, account_id FROM shares")!;
  const owned = new Set(rowsOf(w, { scope: `collection:${w.collections.everything}`, filter: "all" }));
  const page = projection(w.app, share, 100_000)!.map((i) => i.itemId);
  const notesOnly = w.items.filter((i) => owned.has(i.id) && i.source !== null && !w.followed.has(i.source) && i.source !== w.sources.hand && i.annotated && !i.kept).map((i) => i.id);
  assert.ok(notesOnly.length > 0, "the owner's list shows some");
  assert.deepEqual(page.filter((id) => notesOnly.includes(id)), [], "the public page shows none");
  assert.ok(page.length > 0 && page.every((id) => owned.has(id)), "everything on the page is in the owner's list");
  // The page's order is that of the publication dates it shows; the owner's list goes by when the items arrived.
  const newest = w.app.db.get<{ id: string }>(`SELECT id FROM items WHERE id IN (SELECT value FROM json_each(?)) ORDER BY published_at DESC LIMIT 1`, JSON.stringify(page))!.id;
  w.app.db.run("UPDATE items SET listed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", newest);
  assert.equal(projection(w.app, share, 100_000)![0]!.itemId, newest);
  assert.equal(rowsOf(w, { scope: `collection:${w.collections.everything}`, filter: "all" }).at(-1), newest);
});

test("an Ignored item that Undo made New again is in the lists and totals that ask for New or for Ignored, whichever way they are counted", (t) => {
  const { app, p, cleanup } = (() => { const x = makeTestApp(); return { ...x, p: makeOwner(x.app) }; })();
  t.after(cleanup);
  const was = viewTuning.countFromRowsBelowShare;
  t.after(() => { viewTuning.countFromRowsBelowShare = was; });
  const source = makeSource(app, p, "Followed", "feed/a");
  const collection = createCollection(app, p, { name: "Mine", emoji: null, mode: "sources", sourceIds: [source], query: null, view: "list" }).id;
  applySyncBatch(app, p.engineUserId, batch([entry("feed/a"), entry("feed/a"), entry("feed/a")]));
  const [ignored, other, untouched] = listItems(app, p, { scope: "all", sort: "oldest", limit: 5 }).items.map((i) => i.id) as [string, string, string];
  assert.ok(listItems(app, p, { scope: "new", limit: 5 }).items.length === 3, "all three arrived New");
  // Tab A clears New and keeps its Undo; tab B ignores one of the items; tab A then takes its Undo.
  const cleared = clearNewAll(app, p, "all");
  assert.equal(cleared.changed, 3);
  bulk(app, p, [ignored], { type: "workflow", workflow: "ignored" });
  bulk(app, p, [other], { type: "workflow", workflow: "toread" });
  applyUndo(app, p, cleared.undoToken!);
  const state = (id: string) => { const r = app.db.get<{ workflow: string; is_new: number }>("SELECT workflow, is_new FROM item_state WHERE item_id = ?", id)!; return `${r.workflow}${r.is_new ? "+new" : ""}`; };
  assert.deepEqual([state(ignored), state(other), state(untouched)], ["ignored+new", "toread+new", "undecided+new"], "Undo put the marker back on all three, the Ignored one included");

  const filters = ["all", "all_with_ignored", "new", "undecided", "toread", "ignored"] as const;
  const stored = (scope: string, filter: string) => app.db.all<{ id: string }>(
    `SELECT i.id FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.account_id = ? AND ${scope === "new" ? "st.is_new = 1" : scope === "toread" ? "st.workflow IN ('toread', 'inprogress')" : "1"}
       AND ${filter === "new" ? "st.is_new = 1" : filter === "all" ? "st.workflow <> 'ignored'" : filter === "all_with_ignored" ? "1" : `st.workflow = '${filter}'`}`, p.accountId).map((r) => r.id).sort();
  const problems: string[] = [];
  for (const below of [0, was, 1]) {
    viewTuning.countFromRowsBelowShare = below;
    for (const scope of ["all", "new", "toread", `collection:${collection}`]) {
      for (const filter of filters) {
        const rows = listItems(app, p, { scope, filter, limit: 50 });
        const ids = rows.items.map((i) => i.id).sort();
        const where = `${scope}, ${filter}, counts below ${below}`;
        // What a list shows is what is stored; its total, Select all and the collection it belongs to say the same.
        const expected = scope.startsWith("collection:") ? stored("all", filter) : stored(scope, filter);
        if (JSON.stringify(ids) !== JSON.stringify(expected)) problems.push(`rows of ${where}: ${ids.length}, expected ${expected.length}`);
        if (rows.total !== expected.length) problems.push(`total of ${where}: ${rows.total}, expected ${expected.length}`);
        const all = listItemIds(app, p, { scope, filter });
        if (all.total !== expected.length) problems.push(`Select all of ${where}: ${all.total}, expected ${expected.length}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(listItems(app, p, { scope: "all", filter: "new", limit: 5 }).items.some((i) => i.id === ignored), true);
  // The numbers beside the collection say what opening it shows (Ignored items left out) and how many of those are New.
  const beside = listCollections(app, p).find((c) => c.id === collection)!;
  assert.deepEqual([beside.itemCount, beside.newCount], [2, 2], "the Ignored item is in neither number, the two others are New");
});
