import { OTHER_BOX_ID } from "@purss/domain";
import type { HomeOverview, ItemDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { badRequest, notFound } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import { CAPTURE_FAILED, ITEM_COLUMNS, VISIBLE_SOURCE, listItems, toDTO, typeLengthConditions } from "./items.ts";
import type { ItemRow } from "./items.ts";
import { getPreferences } from "./preferences.ts";
import { inHomeBox, onHomeItem } from "./home-sources.ts";
import { itemCounts } from "./counts.ts";
import { NOT_MUTED_ROW, countMuted, mutedAmong, mutedScan, workspaceMuted } from "./muted.ts";

/*
 * Home for someone coming back (plan/29 §2): when the last visit was, what is New since and what to pick up again.
 * Home's own lists are ordinary item lists (`mix=home` in `listItems`).
 */

/** A visit starts when activity resumes after this long without any. */
export const VISIT_GAP_MS = 30 * 60_000;
const ROW_ITEMS = 6;
const RECENT_DAYS = 30;

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
  const rows = app.db.all<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.workspace_id = ? AND i.id IN (${ids.map(() => "?").join(",")})`, workspaceId, ...ids);
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
    const rows = app.db.all<{ source_id: string; n: number }>(
      `SELECT i.source_id, COUNT(*) AS n ${FROM_VISIBLE}
       WHERE i.workspace_id = ? AND i.discovered_at > ? AND st.fresh = 1 AND s.followed = 1 AND s.kind <> 'manual'
       GROUP BY i.source_id`, ws, lastVisitAt);
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

  // Recently kept leaves out what Home leaves out (items of sources whose collections are all hidden on Home);
  // To read is what the person put aside, wherever it came from. Both leave out what the muted words match, and an item is listed
  // in the first of them that has it.
  const homeParams: SqlParam[] = [];
  const onHome = onHomeItem(app, ws, homeParams);
  const muted = workspaceMuted(app, ws, now);
  const recentCut = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();

  // To read: the oldest items and how many there are, in one pass over them. With muted words the first thousand are read (see
  // `mutedScan`) and each is asked about them, so the list takes the first unmuted ones and the total leaves out those they match;
  // with more To read items than that, the total is made in part and may be too high.
  const toReadRows = app.db.all<{ id: string; n: number; m: number }>(
    `SELECT id, n, ${muted ? "purss_muted(?, title, excerpt)" : "0"} AS m FROM (
       SELECT i.id AS id, i.title AS title, i.excerpt AS excerpt, COUNT(*) OVER () AS n ${FROM_VISIBLE}
       WHERE st.workspace_id = ? AND i.workspace_id = ? AND st.workflow = 'toread' AND ${VISIBLE_SOURCE}
       ORDER BY COALESCE(i.published_at, i.discovered_at) ASC, i.id ASC LIMIT ${muted ? mutedScan.rows + 1 : ROW_ITEMS})`,
    ...(muted ? [muted] : []), ws, ws);
  const toRead = toReadRows.filter((r) => !r.m).map((r) => r.id).slice(0, ROW_ITEMS);
  const toReadTotal = (toReadRows[0]?.n ?? 0) - toReadRows.reduce((sum, r) => sum + r.m, 0);
  const toReadPartial = muted !== null && toReadRows.length > mutedScan.rows;

  const keptIds: string[] = [];
  const keptBase = `SELECT b.item_id AS item_id${muted ? ", i.title AS title, i.excerpt AS excerpt" : ""}
     FROM basket_items b JOIN items i ON i.id = b.item_id JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id
     WHERE b.workspace_id = ? AND b.kept_at >= ? AND ${onHome} ORDER BY b.kept_at DESC`;
  for (const r of muted
    ? app.db.all<{ item_id: string }>(`SELECT item_id FROM (${keptBase} LIMIT -1) WHERE ${NOT_MUTED_ROW} LIMIT 30`, ws, recentCut, ...homeParams, muted)
    : app.db.all<{ item_id: string }>(`${keptBase} LIMIT 30`, ws, recentCut, ...homeParams)) {
    if (!keptIds.includes(r.item_id) && !toRead.includes(r.item_id) && keptIds.length < ROW_ITEMS) keptIds.push(r.item_id);
  }
  const fresh = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${FROM_VISIBLE} WHERE st.workspace_id = ? AND st.fresh = 1 AND ${VISIBLE_SOURCE}`, ws)!.n;

  // Items on Home that were not looked at and are not New: the backlog a first follow brings, and what the New marker has outlived.
  const counts = itemCounts(app, ws);
  const boxParams: SqlParam[] = [ws];
  const onBoxes = app.db.all<{ id: string }>(`SELECT s.id FROM sources s WHERE s.workspace_id = ? AND s.followed = 1 AND ${inHomeBox(app, ws, boxParams)}`, ...boxParams).map((r) => r.id);
  const unread = counts.sum(onBoxes, (w, isNew) => w === "new" && !isNew);
  // What the muted words left out of Home: the newest open items it would show, counted among the first thousand (see `mutedScan`).
  const hidden = muted
    ? countMuted(app, muted, FROM_VISIBLE, `st.workspace_id = ? AND i.workspace_id = ? AND st.workflow IN ('new', 'toread') AND ${VISIBLE_SOURCE} AND ${onHome}`,
      [ws, ws, ...homeParams], "ORDER BY COALESCE(i.published_at, i.discovered_at) DESC, i.id DESC")
    : { hidden: 0, atLeast: false };

  const dtos = new Map(itemsByIds(app, ws, [...new Set([...toRead, ...keptIds])]).map((d) => [d.id, d]));
  const pick = (ids: string[]) => ids.flatMap((id) => dtos.get(id) ?? []);
  return {
    lastVisitAt,
    since,
    toRead: { items: pick(toRead), total: toReadTotal, totalAtMost: toReadPartial },
    recentlyKept: pick(keptIds),
    fresh,
    unread,
    mutedHidden: hidden.hidden,
    mutedHiddenAtLeast: hidden.atLeast,
  };
}
