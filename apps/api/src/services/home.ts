import { OTHER_BOX_ID } from "@purss/domain";
import type { HomeOverview, ItemDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { badRequest, notFound } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import { CAPTURE_FAILED, ITEM_COLUMNS, QUEUE_STATES_SQL, VISIBLE_SOURCE, listItems, toDTO, typeLengthConditions } from "./items.ts";
import type { ItemRow } from "./items.ts";
import { getPreferences } from "./preferences.ts";
import { inHomeBox, onHomeItem } from "./home-sources.ts";
import { itemCounts } from "./counts.ts";
import { countMuted, mutedAmong, mutedScan, workspaceMuted } from "./muted.ts";

/*
 * Home for someone coming back (plan/29 §2): when the last visit was, what is New since and what to pick up again.
 * Home's own lists are ordinary item lists (`mix=home` in `listItems`).
 */

/** A visit starts when activity resumes after this long without any. */
export const VISIT_GAP_MS = 30 * 60_000;
const ROW_ITEMS = 6;

// ---------- visits ----------

/**
 * Note that the person is here, from any page. After 30 minutes without activity a new visit begins: the one that just
 * ended becomes the "last visit", which then stays the same for the whole visit. Both timestamps move together, in one
 * transaction. Returns the start of the visit before this one, and whether this call began a new visit.
 */
export function touchVisit(app: App, workspaceId: string, now: Date = new Date()): { lastVisitAt: string | null; started: boolean } {
  return app.db.tx(() => {
    const row = app.db.get<{ last_visit_at: string | null; visit_started_at: string | null; last_activity_at: string | null }>(
      "SELECT last_visit_at, visit_started_at, last_activity_at FROM workspaces WHERE id = ?", workspaceId);
    if (!row) return { lastVisitAt: null, started: false };
    const iso = now.toISOString();
    const quiet = row.last_activity_at ? now.getTime() - Date.parse(row.last_activity_at) : Infinity;
    if (!row.visit_started_at || quiet > VISIT_GAP_MS) {
      app.db.run("UPDATE workspaces SET last_visit_at = visit_started_at, visit_started_at = ?, last_activity_at = ? WHERE id = ?", iso, iso, workspaceId);
      return { lastVisitAt: row.visit_started_at, started: true };
    }
    if (quiet > 60_000) app.db.run("UPDATE workspaces SET last_activity_at = ? WHERE id = ?", iso, workspaceId);
    return { lastVisitAt: row.last_visit_at, started: false };
  });
}

// ---------- Home's boxes ----------

export type BoxLink = { id: string; name: string; home: boolean };

/** The collections (of the "sources" kind) each source belongs to. */
export function boxesBySource(app: App, workspaceId: string): Map<string, BoxLink[]> {
  const links = app.db.all<{ source_id: string; id: string; name: string; show_on_home: number }>(
    `SELECT cs.source_id, c.id, c.name, c.show_on_home FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id
     WHERE c.workspace_id = ? AND c.mode = 'sources'`, workspaceId);
  const out = new Map<string, BoxLink[]>();
  for (const l of links) {
    const list = out.get(l.source_id) ?? [];
    list.push({ id: l.id, name: l.name, home: l.show_on_home === 1 });
    out.set(l.source_id, list);
  }
  return out;
}

function itemsByIds(app: App, workspaceId: string, ids: string[]): ItemDTO[] {
  if (!ids.length) return [];
  // Looked up by id (the `+` keeps the planner from walking every item of the PURSS to find these few).
  const rows = app.db.all<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.id IN (${ids.map(() => "?").join(",")}) AND +i.workspace_id = ?`, ...ids, workspaceId);
  const byId = new Map(rows.map((r) => [r.id, toDTO(r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

const FROM_VISIBLE = `FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id`;

/** Everything Home says before its boxes. */
export function homeOverview(app: App, p: Principal, now: Date = new Date()): HomeOverview {
  // Reading Home never changes anything: the visit is recorded by touchVisit, called from any page.
  const lastVisitAt = app.db.get<{ last_visit_at: string | null }>("SELECT last_visit_at FROM workspaces WHERE id = ?", p.workspaceId)?.last_visit_at ?? null;
  const ws = p.workspaceId;

  // New since the last visit, by the Home box each source shows in.
  let since: HomeOverview["since"] = null;
  if (lastVisitAt) {
    const prefs = getPreferences(app, ws);
    const links = boxesBySource(app, ws);
    // Read from the New items (few: the marker expires), not from everything that arrived since, which after a long absence or a
    // first follow is most of the PURSS.
    const rows = app.db.all<{ source_id: string; n: number }>(
      `SELECT i.source_id, COUNT(*) AS n FROM item_state st CROSS JOIN items i ON i.id = st.item_id LEFT JOIN sources s ON s.id = i.source_id
       WHERE st.workspace_id = ? AND st.fresh = 1 AND i.workspace_id = ? AND i.discovered_at > ? AND s.followed = 1 AND s.kind <> 'manual'
       GROUP BY i.source_id`, ws, ws, lastVisitAt);
    const boxes = new Map<string, { id: string; name: string; count: number }>();
    let total = 0;
    for (const r of rows) {
      const mine = links.get(r.source_id);
      const shown = mine ? mine.filter((b) => b.home) : prefs.homeOther ? [{ id: OTHER_BOX_ID, name: "Other sources", home: true }] : [];
      if (!shown.length) continue;
      total += r.n;
      for (const b of shown) {
        const box = boxes.get(b.id) ?? { id: b.id, name: b.name, count: 0 };
        box.count += r.n;
        boxes.set(b.id, box);
      }
    }
    if (total) since = { total, boxes: [...boxes.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  }

  // To read, To watch and To listen are the queue: what the person put aside and what they started, wherever it came from; all leave
  // out what the muted words match.
  const homeParams: SqlParam[] = [];
  const onHome = onHomeItem(app, ws, homeParams);
  const muted = workspaceMuted(app, ws, now);

  // To read (articles), To watch (videos) and To listen (podcasts) are three rows, each the started items of its kind first, then the
  // oldest of the rest, and how many there are, in one pass over them.
  // With muted words the first thousand are read (see `mutedScan`) and each is asked about them, so a row takes the first unmuted
  // ones and its total leaves out those they match; with more items than that, the total is made in part and may be too high.
  const putAside = (kind: string) => {
    const rows = app.db.all<{ id: string; n: number; m: number }>(
      `SELECT id, n, ${muted ? "purss_muted(?, title, excerpt)" : "0"} AS m FROM (
         SELECT i.id AS id, i.title AS title, i.excerpt AS excerpt, COUNT(*) OVER () AS n ${FROM_VISIBLE}
         WHERE st.workspace_id = ? AND i.workspace_id = ? AND ${QUEUE_STATES_SQL} AND ${kind} AND ${VISIBLE_SOURCE}
         ORDER BY st.workflow = 'inprogress' DESC, COALESCE(i.published_at, i.discovered_at) ASC, i.id ASC LIMIT ${muted ? mutedScan.rows + 1 : ROW_ITEMS})`,
      ...(muted ? [muted] : []), ws, ws);
    return {
      ids: rows.filter((r) => !r.m).map((r) => r.id).slice(0, ROW_ITEMS),
      total: (rows[0]?.n ?? 0) - rows.reduce((sum, r) => sum + r.m, 0),
      totalAtMost: muted !== null && rows.length > mutedScan.rows,
    };
  };
  const toRead = putAside("i.kind NOT IN ('video', 'podcast')");
  const toWatch = putAside("i.kind = 'video'");
  const toListen = putAside("i.kind = 'podcast'");
  const putAsideIds = [...toRead.ids, ...toWatch.ids, ...toListen.ids];

  const fresh = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${FROM_VISIBLE} WHERE st.workspace_id = ? AND st.fresh = 1 AND ${VISIBLE_SOURCE}`, ws)!.n;

  // Items on Home that were not looked at and are not New: the older posts of sources followed before the choice of where to start
  // existed, and what the New marker has outlived. A source followed from now leaves its back catalogue out (see `ItemCounts.sum`).
  const counts = itemCounts(app, ws);
  const boxParams: SqlParam[] = [ws];
  const onBoxes = app.db.all<{ id: string }>(`SELECT s.id FROM sources s WHERE s.workspace_id = ? AND s.followed = 1 AND ${inHomeBox(app, ws, boxParams)}`, ...boxParams).map((r) => r.id);
  const unread = counts.sum(onBoxes, (w, isNew) => w === "new" && !isNew);
  // What the muted words left out of Home: the newest open items it would show, counted among the first thousand (see `mutedScan`).
  // The items are read newest first from the date index and stop at the thousandth; led by the state instead, the planner sorts
  // every open item first.
  const hidden = muted
    ? countMuted(app, muted, "FROM items i CROSS JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id",
      `st.workspace_id = ? AND i.workspace_id = ? AND st.workflow IN ('new', 'toread') AND i.backlog = 0 AND ${VISIBLE_SOURCE} AND ${onHome}`,
      [ws, ws, ...homeParams], "ORDER BY COALESCE(i.published_at, i.discovered_at) DESC, i.id DESC")
    : { hidden: 0, atLeast: false };

  const dtos = new Map(itemsByIds(app, ws, putAsideIds).map((d) => [d.id, d]));
  const pick = (ids: string[]) => ids.flatMap((id) => dtos.get(id) ?? []);
  return {
    lastVisitAt,
    since,
    toRead: { items: pick(toRead.ids), total: toRead.total, totalAtMost: toRead.totalAtMost },
    toWatch: { items: pick(toWatch.ids), total: toWatch.total, totalAtMost: toWatch.totalAtMost },
    toListen: { items: pick(toListen.ids), total: toListen.total, totalAtMost: toListen.totalAtMost },
    fresh,
    unread,
    mutedHidden: hidden.hidden,
    mutedHiddenAtLeast: hidden.atLeast,
  };
}
