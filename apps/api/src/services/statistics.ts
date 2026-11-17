import { STATS_WEEKS, WORKFLOW_STATES } from "@purss/domain";
import type { CollectionStatsResponse, CollectionStatsRow, SourceStatsResponse, StatsNumbers, WorkflowState } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { notFound, nowIso } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import { FILTERED_OUT } from "./ai-filters.ts";
import { VISIBLE_SOURCE, scopeClause } from "./items.ts";

/*
 * Private statistics for one source or one collection: plain counts and dates over the items the
 * signed-in account holds. Nothing here interprets the numbers, and nothing is reachable from
 * the public share pages. Every query is scoped through the principal like the item lists, and
 * a collection is read through the same scope clause the list page uses, so a filter collection
 * is computed over the items that match its filter.
 *
 * Dates use an item's publication date when the feed gave one and its arrival date otherwise,
 * so a newly followed feed's backlog lands in the weeks it was published, not in one burst.
 * Items dated after "now" count in the totals but are left out of weeks, gaps and the last date.
 */

const DAY_MS = 86_400_000;
const GAP_WINDOW_DAYS = 365;
const LOG_WINDOW_DAYS = 30;

const FROM = "FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id";
const EFFECTIVE = "COALESCE(i.published_at, i.discovered_at)";

type Sid = string | null;

function emptyNumbers(): StatsNumbers {
  return {
    totalItems: 0, weekly: new Array<number>(STATS_WEEKS).fill(0), lastItemAt: null, longestGapDays: null,
    workflow: { new: 0, toread: 0, inprogress: 0, finished: 0, ignored: 0 },
    opened: 0, kept: 0, finishedLast30Days: 0, ignoredLast30Days: 0, filteredOut: 0,
  };
}

/** Where-clause and parameters for the items in scope, shared by every query below. */
function scopeOf(app: App, p: Principal, scope: string): { where: string; params: SqlParam[] } {
  const params: SqlParam[] = [p.workspaceId];
  const clause = scopeClause(app, p, scope, params);
  return { where: `i.workspace_id = ? AND ${clause} AND ${VISIBLE_SOURCE}`, params };
}

const isoDaysBefore = (now: string, days: number) => new Date(Date.parse(now) - days * DAY_MS).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Numbers per source for the items in scope (a source with no items in scope has no entry). */
function numbersBySource(app: App, p: Principal, scope: string, now: string): Map<Sid, StatsNumbers> {
  const { where, params } = scopeOf(app, p, scope);
  const out = new Map<Sid, StatsNumbers>();
  const at = (sid: Sid): StatsNumbers => {
    let n = out.get(sid);
    if (!n) { n = emptyNumbers(); out.set(sid, n); }
    return n;
  };

  const perState = WORKFLOW_STATES.map((w) => `COALESCE(SUM(st.workflow = '${w}'), 0) AS w_${w}`).join(", ");
  type Counts = { sid: Sid; total: number; opened: number; kept: number; filtered: number; last_at: string | null } & Record<`w_${WorkflowState}`, number>;
  for (const r of app.db.all<Counts>(
    `SELECT i.source_id AS sid, COUNT(*) AS total, ${perState},
       COALESCE(SUM(st.opened_at IS NOT NULL), 0) AS opened,
       COALESCE(SUM(EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id)), 0) AS kept,
       COALESCE(SUM(${FILTERED_OUT}), 0) AS filtered,
       MAX(CASE WHEN ${EFFECTIVE} <= ? THEN ${EFFECTIVE} END) AS last_at
     ${FROM} WHERE ${where} GROUP BY i.source_id`, now, ...params)) {
    const n = at(r.sid);
    n.totalItems = r.total; n.opened = r.opened; n.kept = r.kept; n.filteredOut = r.filtered; n.lastItemAt = r.last_at;
    for (const w of WORKFLOW_STATES) n.workflow[w] = r[`w_${w}`];
  }

  // Consecutive 7-day periods counting back from now; week 0 is the most recent.
  for (const r of app.db.all<{ sid: Sid; wk: number; n: number }>(
    `SELECT i.source_id AS sid, CAST((julianday(?) - julianday(${EFFECTIVE})) / 7 AS INTEGER) AS wk, COUNT(*) AS n
     ${FROM} WHERE ${where} AND julianday(?) - julianday(${EFFECTIVE}) >= 0 AND julianday(?) - julianday(${EFFECTIVE}) < ?
     GROUP BY i.source_id, wk`, now, ...params, now, now, STATS_WEEKS * 7)) {
    at(r.sid).weekly[STATS_WEEKS - 1 - r.wk] = r.n;
  }

  for (const r of app.db.all<{ sid: Sid; gap: number | null }>(longestGapSql(where, true), ...params, now, now, GAP_WINDOW_DAYS)) {
    at(r.sid).longestGapDays = r.gap === null ? null : round1(r.gap);
  }

  // The account's own change log: items moved to Finished or Ignored recently, once per item.
  for (const r of app.db.all<{ sid: Sid; to_state: "finished" | "ignored"; n: number }>(
    `SELECT i.source_id AS sid, l.to_state AS to_state, COUNT(DISTINCT l.item_id) AS n
     FROM state_log l JOIN items i ON i.id = l.item_id JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id
     WHERE l.workspace_id = ? AND l.at >= ? AND l.to_state IN ('finished', 'ignored') AND ${where}
     GROUP BY i.source_id, l.to_state`, p.workspaceId, isoDaysBefore(now, LOG_WINDOW_DAYS), ...params)) {
    const n = at(r.sid);
    if (r.to_state === "finished") n.finishedLast30Days = r.n; else n.ignoredLast30Days = r.n;
  }
  return out;
}

/**
 * Longest gap in days between consecutive items dated within the window, per source or (merged)
 * over every item in scope. Both items of a gap must fall inside the window.
 */
function longestGapSql(where: string, perSource: boolean): string {
  return `WITH d AS (SELECT ${perSource ? "i.source_id" : "NULL"} AS sid, julianday(${EFFECTIVE}) AS t
       ${FROM} WHERE ${where} AND julianday(?) - julianday(${EFFECTIVE}) >= 0 AND julianday(?) - julianday(${EFFECTIVE}) <= ?),
     g AS (SELECT sid, t - LAG(t) OVER (PARTITION BY sid ORDER BY t) AS gap FROM d)
     SELECT sid, MAX(gap) AS gap FROM g GROUP BY sid`;
}

/** Sum of per-source numbers, with the last date and the whole-scope gap taken over all items. */
function totalsOf(app: App, p: Principal, scope: string, now: string, rows: StatsNumbers[]): StatsNumbers {
  const total = emptyNumbers();
  for (const n of rows) {
    total.totalItems += n.totalItems; total.opened += n.opened; total.kept += n.kept; total.filteredOut += n.filteredOut;
    total.finishedLast30Days += n.finishedLast30Days; total.ignoredLast30Days += n.ignoredLast30Days;
    for (const w of WORKFLOW_STATES) total.workflow[w] += n.workflow[w];
    n.weekly.forEach((c, i) => { total.weekly[i]! += c; });
    if (n.lastItemAt && (!total.lastItemAt || n.lastItemAt > total.lastItemAt)) total.lastItemAt = n.lastItemAt;
  }
  const { where, params } = scopeOf(app, p, scope);
  const gap = app.db.get<{ gap: number | null }>(longestGapSql(where, false), ...params, now, now, GAP_WINDOW_DAYS)?.gap ?? null;
  total.longestGapDays = gap === null ? null : round1(gap);
  return total;
}

export function sourceStats(app: App, p: Principal, sourceId: string, now = nowIso()): SourceStatsResponse {
  const source = app.db.get<{ title: string }>("SELECT title FROM sources WHERE id = ? AND workspace_id = ?", sourceId, p.workspaceId);
  if (!source) throw notFound("That source");
  const stats = numbersBySource(app, p, `source:${sourceId}`, now).get(sourceId) ?? emptyNumbers();
  return { sourceId, title: source.title, asOf: now, stats };
}

export function collectionStats(app: App, p: Principal, collectionId: string, now = nowIso()): CollectionStatsResponse {
  const c = app.db.get<{ name: string; mode: string }>("SELECT name, mode FROM collections WHERE id = ? AND workspace_id = ?", collectionId, p.workspaceId);
  if (!c) throw notFound("That collection");
  const scope = `collection:${collectionId}`;
  const bySource = numbersBySource(app, p, scope, now);
  const titles = new Map(app.db.all<{ id: string; title: string }>("SELECT id, title FROM sources WHERE workspace_id = ?", p.workspaceId).map((s) => [s.id, s.title]));

  // A source collection lists every member, including a source that has no items yet; a filter
  // collection lists the sources its matching items come from.
  const sids: Sid[] = c.mode === "sources"
    ? app.db.all<{ source_id: string }>("SELECT source_id FROM collection_sources WHERE collection_id = ?", collectionId).map((r) => r.source_id)
    : [...bySource.keys()];
  const sources: CollectionStatsRow[] = sids
    .map((sid) => ({ sourceId: sid, title: sid === null ? "Saved links" : titles.get(sid) ?? "Unknown source", stats: bySource.get(sid) ?? emptyNumbers() }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    collectionId, name: c.name, mode: c.mode === "sources" ? "sources" : "query", asOf: now, sources,
    totals: totalsOf(app, p, scope, now, sources.map((s) => s.stats)),
  };
}
