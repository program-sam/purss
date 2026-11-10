import test from "node:test";
import assert from "node:assert/strict";
import { STATS_WEEKS } from "@purss/domain";
import type { WorkflowState } from "@purss/domain";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { createBasket, createCollection, deleteItems, deletePreview } from "./collections.ts";
import { insertItem } from "./items.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { OPTIONAL_SECTION_NAMES, SECTION_NAMES, parseArchive, sha256Hex } from "./archive-format.ts";
import { collectionStats, sourceStats } from "./statistics.ts";
import { applyUndo, bulk, changeState, keepItem } from "./state.ts";
import { reconcile } from "./storage.ts";

const DAY = 86_400_000;
const NOW = Date.now();
/** An instant `days` before the test started (half days keep every item clear of a week boundary). */
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

type Owner = Principal & { engineUserId: string };

let serial = 0;
/** An item with explicit dates; `published` null means the feed gave none, so the arrival date stands in. */
function addItem(app: App, p: Owner, sourceId: string, published: string | null, discovered: string = published ?? NOW_ISO): string {
  serial++;
  return insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId, kind: "article", title: `Post ${serial}`, url: `https://example.org/stats/${serial}`, author: null,
    summaryHtml: `<p>Summary ${serial}</p>`, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: published, discoveredAt: discovered, enclosures: [], fresh: false, reason: "feed item",
  }).id;
}

const stateOf = (app: App, itemId: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", itemId)!.revision;
const setFlow = (app: App, p: Owner, itemId: string, workflow: WorkflowState) => changeState(app, p, itemId, { workflow, expectedRevision: stateOf(app, itemId) });
const logRows = (app: App, itemId?: string) =>
  app.db.all<{ item_id: string; from_state: string; to_state: string; at: string }>(
    `SELECT item_id, from_state, to_state, at FROM state_log ${itemId ? "WHERE item_id = ?" : ""} ORDER BY seq`, ...(itemId ? [itemId] : []));

test("source statistics: counts, publication-date weeks, gaps, states, opened, kept and storage", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "Tidal Notes", "feed/1");
  // Published 1.5 days ago (week 0), 8.5 days ago (week 1), no publication date but arrived 64.5 days ago, 400 days ago, and dated in the future.
  const a = addItem(app, p, src, ago(1.5));
  const b = addItem(app, p, src, ago(8.5));
  const c = addItem(app, p, src, null, ago(64.5));
  addItem(app, p, src, ago(400));
  addItem(app, p, src, new Date(NOW + 20 * DAY).toISOString());

  setFlow(app, p, a, "finished");
  setFlow(app, p, b, "ignored");
  setFlow(app, p, c, "toread");
  changeState(app, p, a, { opened: true, expectedRevision: stateOf(app, a) });
  keepItem(app, p, a, createBasket(app, p, { name: "Keep", captureMode: "metadata" }).id);

  const { stats, title, sourceId } = sourceStats(app, p, src);
  assert.deepEqual([title, sourceId], ["Tidal Notes", src]);
  assert.equal(stats.totalItems, 5);
  assert.equal(stats.weekly.length, STATS_WEEKS);
  const expectedWeeks = new Array<number>(STATS_WEEKS).fill(0);
  expectedWeeks[STATS_WEEKS - 1] = 1; // a
  expectedWeeks[STATS_WEEKS - 2] = 1; // b
  expectedWeeks[STATS_WEEKS - 1 - 9] = 1; // c: 64.5 days is the tenth 7-day period back
  assert.deepEqual(stats.weekly, expectedWeeks, "weeks follow the publication date, with the arrival date as the stand-in; older and future items are not placed");
  assert.equal(stats.lastItemAt, ago(1.5), "the future-dated item does not become the last item");
  // Items dated within the last 12 months: c, b, a. The 400-day-old and future items are outside.
  assert.equal(stats.longestGapDays, 56, "from 64.5 to 8.5 days ago");
  assert.deepEqual(stats.workflow, { new: 2, toread: 1, inprogress: 0, finished: 1, ignored: 1 });
  assert.equal(stats.opened, 1);
  assert.equal(stats.kept, 1);
  assert.equal(stats.finishedLast30Days, 1);
  assert.equal(stats.ignoredLast30Days, 1);

});

test("a source without items, and one with a single item, have no gap and empty weeks", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const empty = makeSource(app, p, "Empty", "feed/1");
  const single = makeSource(app, p, "Single", "feed/2");
  addItem(app, p, single, ago(3.5));
  const none = sourceStats(app, p, empty).stats;
  assert.deepEqual([none.totalItems, none.lastItemAt, none.longestGapDays, none.kept, none.opened], [0, null, null, 0, 0]);
  assert.deepEqual(none.weekly, new Array(STATS_WEEKS).fill(0));
  const one = sourceStats(app, p, single).stats;
  assert.deepEqual([one.totalItems, one.longestGapDays, one.weekly.reduce((n, c) => n + c, 0)], [1, null, 1]);
});

test("a newly followed feed's backlog lands in the weeks it was published, not in one burst", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "Backlog", "feed/1");
  // Everything arrived just now, but the feed dated its entries across a month.
  for (const days of [2.5, 10.5, 17.5, 24.5]) addItem(app, p, src, ago(days), NOW_ISO);
  const { weekly } = sourceStats(app, p, src).stats;
  assert.deepEqual(weekly.slice(-4), [1, 1, 1, 1]);
  assert.equal(weekly.reduce((n, c) => n + c, 0), 4);
});

test("statistics are scoped to the signed-in account", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p1 = makeOwner(app);
  const p2 = makeOwner(app, { admin: false });
  const s1 = makeSource(app, p1, "Mine", "feed/1");
  const s2 = makeSource(app, p2, "Theirs", "feed/2");
  addItem(app, p1, s1, ago(1.5));
  addItem(app, p2, s2, ago(1.5));
  addItem(app, p2, s2, ago(2.5));
  const c1 = createCollection(app, p1, { name: "Mine", emoji: null, mode: "sources", sourceIds: [s1], query: null, view: "list" });

  const notFound = (e: unknown) => e instanceof HttpError && e.status === 404;
  assert.throws(() => sourceStats(app, p1, s2), notFound);
  assert.throws(() => sourceStats(app, p2, s1), notFound);
  assert.throws(() => collectionStats(app, p2, c1.id), notFound);
  assert.throws(() => sourceStats(app, p1, "src_missing"), notFound);
  assert.equal(sourceStats(app, p1, s1).stats.totalItems, 1);
  assert.equal(sourceStats(app, p2, s2).stats.totalItems, 2);
  // A filter collection in one account never counts the other account's items.
  const f = createCollection(app, p1, { name: "Everything unread", emoji: null, mode: "query", sourceIds: [], query: { field: "workflow", value: ["new"] }, view: "list" });
  assert.deepEqual(collectionStats(app, p1, f.id).sources.map((r) => r.sourceId), [s1]);
  assert.equal(collectionStats(app, p1, f.id).totals.totalItems, 1);
});

test("collection statistics: one row per member source, totals, and a whole-collection gap", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const one = makeSource(app, p, "Bravo", "feed/1");
  const two = makeSource(app, p, "Alpha", "feed/2");
  const idle = makeSource(app, p, "Idle", "feed/3");
  const outside = makeSource(app, p, "Outside", "feed/4");
  addItem(app, p, one, ago(60.5));
  const oneLast = addItem(app, p, one, ago(10.5));
  addItem(app, p, two, ago(35.5));
  addItem(app, p, outside, ago(5.5));
  setFlow(app, p, oneLast, "finished");
  const col = createCollection(app, p, { name: "Mix", emoji: null, mode: "sources", sourceIds: [one, two, idle], query: null, view: "list" });

  const r = collectionStats(app, p, col.id);
  assert.deepEqual(r.sources.map((s) => s.title), ["Alpha", "Bravo", "Idle"], "every member is a row, including one with no items, ordered by name");
  assert.equal(r.mode, "sources");
  const bravo = r.sources.find((s) => s.sourceId === one)!.stats;
  assert.deepEqual([bravo.totalItems, bravo.longestGapDays, bravo.workflow.finished], [2, 50, 1]);
  assert.equal(r.sources.find((s) => s.sourceId === idle)!.stats.totalItems, 0);
  assert.equal(r.totals.totalItems, 3, "the source outside the collection is not counted");
  assert.equal(r.totals.workflow.finished, 1);
  assert.equal(r.totals.lastItemAt, ago(10.5));
  assert.equal(r.totals.longestGapDays, 25, "the longest stretch between consecutive items of the whole collection (60.5, 35.5, 10.5 days ago)");
  assert.equal(r.totals.weekly.reduce((n, c) => n + c, 0), 3);
  assert.equal(r.totals.finishedLast30Days, 1);
});

test("a filter collection is computed over the items that match its filter, grouped by source", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const one = makeSource(app, p, "One", "feed/1");
  const two = makeSource(app, p, "Two", "feed/2");
  const a1 = addItem(app, p, one, ago(3.5));
  addItem(app, p, one, ago(4.5));
  const b1 = addItem(app, p, two, ago(5.5));
  addItem(app, p, two, ago(6.5));
  setFlow(app, p, a1, "finished");
  setFlow(app, p, b1, "finished");
  const col = createCollection(app, p, { name: "Done", emoji: null, mode: "query", sourceIds: [], query: { field: "workflow", value: ["finished"] }, view: "list" });

  const r = collectionStats(app, p, col.id);
  assert.equal(r.mode, "query");
  assert.deepEqual(r.sources.map((s) => [s.title, s.stats.totalItems]), [["One", 1], ["Two", 1]]);
  assert.equal(r.totals.totalItems, 2);
  assert.deepEqual(r.totals.workflow, { new: 0, toread: 0, inprogress: 0, finished: 2, ignored: 0 });
});

test("the 30-day counts come from the log, count each item once and ignore older rows", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "S", "feed/1");
  const x = addItem(app, p, src, ago(2.5));
  const y = addItem(app, p, src, ago(3.5));
  setFlow(app, p, x, "finished");
  setFlow(app, p, x, "toread");
  setFlow(app, p, x, "finished"); // two changes to Finished, one item
  setFlow(app, p, y, "ignored");
  app.db.run("INSERT INTO state_log (account_id, workspace_id, item_id, from_state, to_state, at) VALUES (?, ?, ?, 'new', 'finished', ?)", p.accountId, p.workspaceId, y, ago(40));
  const stats = sourceStats(app, p, src).stats;
  assert.deepEqual([stats.finishedLast30Days, stats.ignoredLast30Days], [1, 1]);
});

test("workflow changes write the log: single, bulk and undo; no-ops and other fields do not", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "S", "feed/1");
  const x = addItem(app, p, src, ago(2.5));
  const y = addItem(app, p, src, ago(3.5));

  setFlow(app, p, x, "toread");
  assert.deepEqual(logRows(app, x).map((r) => [r.from_state, r.to_state]), [["new", "toread"]]);
  setFlow(app, p, x, "toread");
  changeState(app, p, x, { progress: 0.4, expectedRevision: stateOf(app, x) });
  changeState(app, p, x, { fresh: false, expectedRevision: stateOf(app, x) });
  assert.equal(logRows(app, x).length, 1, "same state, progress and fresh clearing are not workflow changes");

  const undoOne = changeState(app, p, x, { workflow: "finished", expectedRevision: stateOf(app, x) }).undoToken;
  assert.deepEqual(logRows(app, x).map((r) => r.to_state), ["toread", "finished"]);
  applyUndo(app, p, undoOne);
  assert.deepEqual(logRows(app, x).map((r) => [r.from_state, r.to_state]), [["new", "toread"], ["toread", "finished"], ["finished", "toread"]], "an undo is a change like any other");

  const res = bulk(app, p, [x, y], { type: "workflow", workflow: "ignored" });
  assert.equal(res.changed, 2);
  assert.deepEqual(logRows(app, y).map((r) => [r.from_state, r.to_state]), [["new", "ignored"]]);
  const last = logRows(app, x).at(-1)!;
  assert.deepEqual([last.from_state, last.to_state], ["toread", "ignored"]);
  assert.equal(bulk(app, p, [x, y], { type: "workflow", workflow: "ignored" }).changed, 0);
  assert.equal(logRows(app).length, 5, "an unchanged bulk adds nothing");

  applyUndo(app, p, res.undoToken);
  assert.deepEqual(logRows(app, y).map((r) => [r.from_state, r.to_state]), [["new", "ignored"], ["ignored", "new"]]);
  for (const row of logRows(app)) assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.equal(app.db.all("SELECT 1 FROM state_log WHERE account_id <> ? OR workspace_id <> ?", p.accountId, p.workspaceId).length, 0, "every row carries the account and workspace");
});

test("the log is counted in storage once per item, and deleting an item deletes its rows and releases that record", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: 10_000_000 });
  const src = makeSource(app, p, "S", "feed/1");
  const x = addItem(app, p, src, ago(2.5));
  const y = addItem(app, p, src, ago(3.5));
  for (const w of ["toread", "inprogress", "finished", "new"] as const) setFlow(app, p, x, w);
  bulk(app, p, [x, y], { type: "workflow", workflow: "ignored" });
  assert.equal(logRows(app, x).length, 5);
  const records = (id: string) => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE kind = 'record' AND ref_id = ? AND released_at IS NULL", `state:${id}`)!.n;
  assert.deepEqual([records(x), records(y)], [1, 1], "one small record per item, however many changes");
  assert.equal(reconcile(app, p.accountId).difference, 0);

  const token = deletePreview(app, p, [x]).confirmToken;
  deleteItems(app, p, token);
  assert.equal(logRows(app, x).length, 0);
  assert.equal(logRows(app, y).length, 1, "other items keep their rows");
  assert.equal(records(x), 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

// ------------------------------------------------------------------ export and import

async function exportDoc(app: App, p: Principal): Promise<any> {
  const parts: string[] = [];
  await streamExport(app, p, (c) => { parts.push(c); });
  return JSON.parse(parts.join(""));
}

function rebuild(doc: any): any {
  const sections: Record<string, { count: number; sha256: string }> = {};
  for (const n of [...SECTION_NAMES, ...OPTIONAL_SECTION_NAMES]) if (doc[n] !== undefined) sections[n] = { count: Array.isArray(doc[n]) ? doc[n].length : 1, sha256: sha256Hex(JSON.stringify(doc[n])) };
  return { ...doc, manifest: { algorithm: "sha256", sections } };
}

const historyOf = (app: App, title: string) => app.db.all<{ from_state: string; to_state: string; at: string }>(
  "SELECT l.from_state, l.to_state, l.at FROM state_log l JOIN items i ON i.id = l.item_id WHERE i.title = ? ORDER BY l.seq", title);

test("the log travels in the export and imports idempotently; older files without it still import", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  const src = makeSource(a.app, pa, "Letters", "feed/1");
  const x = addItem(a.app, pa, src, ago(2.5));
  const y = addItem(a.app, pa, src, ago(3.5));
  addItem(a.app, pa, src, ago(4.5));
  setFlow(a.app, pa, x, "toread");
  setFlow(a.app, pa, x, "finished");
  setFlow(a.app, pa, y, "ignored");
  const titleX = a.app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", x)!.title;
  const titleY = a.app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", y)!.title;

  const doc = await exportDoc(a.app, pa);
  assert.equal(doc.stateLog.length, 3);
  assert.deepEqual(doc.stateLog.map((l: any) => [l.from, l.to]), [["new", "toread"], ["toread", "finished"], ["new", "ignored"]]);
  assert.deepEqual(Object.keys(doc.stateLog[0]).sort(), ["at", "from", "itemId", "to"], "nothing but the change itself");
  assert.equal(doc.manifest.sections.stateLog.count, 3);
  assert.equal(parseArchive(doc).stateLog.length, 3);
  const tampered = structuredClone(doc);
  tampered.stateLog[0].to = "ignored";
  assert.throws(() => parseArchive(tampered), /damaged/);
  const orphanManifest = structuredClone(doc);
  delete orphanManifest.stateLog;
  assert.throws(() => parseArchive(orphanManifest), /missing its "stateLog" section/);

  applyImport(b.app, pb, stageImport(b.app, pb, doc).token);
  assert.deepEqual(historyOf(b.app, titleX).map((r) => [r.from_state, r.to_state, r.at]), doc.stateLog.filter((l: any) => l.itemId === x).map((l: any) => [l.from, l.to, l.at]));
  assert.equal(historyOf(b.app, titleY).length, 1);
  assert.equal(b.app.db.all("SELECT 1 FROM state_log WHERE account_id <> ?", pb.accountId).length, 0);
  assert.equal(reconcile(b.app, pb.accountId).difference, 0);
  const total = (app: App) => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_log")!.n;
  assert.equal(total(b.app), 3);

  // The same file again: the items are already there and so is their history.
  const again = stageImport(b.app, pb, doc);
  applyImport(b.app, pb, again.token);
  assert.equal(total(b.app), 3, "importing twice does not repeat history");
  assert.equal(reconcile(b.app, pb.accountId).difference, 0);
  // And the same PURSS importing its own export does not repeat it either.
  applyImport(a.app, pa, stageImport(a.app, pa, doc).token);
  assert.equal(total(a.app), 3);

  // A file from before the log existed.
  const old = structuredClone(doc);
  delete old.stateLog;
  const c = makeTestApp();
  t.after(c.cleanup);
  const pc = makeOwner(c.app);
  const result = applyImport(c.app, pc, stageImport(c.app, pc, rebuild(old)).token);
  assert.equal(result.created.items, 3);
  assert.equal(c.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_log")!.n, 0);
});

test("history for an item that already exists is added with its small record, and the preview's size is exact", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  const srcA = makeSource(a.app, pa, "Letters", "feed/1");
  const x = addItem(a.app, pa, srcA, ago(2.5));
  const title = a.app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", x)!.title;

  // B first receives the item without any history (an older export), then the newer file.
  const doc = await exportDoc(a.app, pa);
  const withoutLog = structuredClone(doc);
  delete withoutLog.stateLog;
  delete withoutLog.manifest.sections.stateLog;
  applyImport(b.app, pb, stageImport(b.app, pb, withoutLog).token);
  assert.equal(historyOf(b.app, title).length, 0);
  assert.equal(b.app.db.get("SELECT 1 FROM stored_objects WHERE ref_id LIKE 'state:%'"), undefined);

  setFlow(a.app, pa, x, "finished");
  const newer = await exportDoc(a.app, pa);
  const before = b.app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE released_at IS NULL")!.n;
  const preview = stageImport(b.app, pb, newer);
  applyImport(b.app, pb, preview.token);
  assert.deepEqual(historyOf(b.app, title).map((r) => [r.from_state, r.to_state]), [["new", "finished"]]);
  const after = b.app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE released_at IS NULL")!.n;
  assert.equal(after - before, preview.requiredBytes);
  assert.ok(preview.requiredBytes > 0, "the history needs its small record");
  assert.equal(reconcile(b.app, pb.accountId).difference, 0);
});
