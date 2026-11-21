import { DISCOVERY_ROUTES, isDiscoveryEntry, isDiscoveryRoute } from "@purss/domain";
import type { DiscoveryEntry, DiscoveryRoute, DiscoveryRoutesDTO, DiscoveryRouteStatDTO } from "@purss/domain";
import type { App } from "../app.ts";

/*
 * Which discovery routes are used: for each way discovery found a candidate (its route) and each way the person got to the lookup (its
 * entry), how many candidates were shown ("offered") and how many were followed, per UTC day, across the whole installation. It is the
 * administrator's record of which routes earn their keep and which could go. It stores the two closed ids of domain/discovery-routes.ts and
 * a count, no account, workspace, source, address or title, so it is no part of any account's data or export. Kept 180 days.
 * A followed source keeps its own route and entry (sources.discovery_route, discovery_entry) for what became of it.
 */

export const KEEP_DAYS = 180;
/** The window of the administrator's table. */
export const WINDOW_DAYS = 90;
/** A source counts as kept when it was still followed this long after it was followed. */
export const KEPT_AFTER_DAYS = 30;

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Count candidates shown, per route. Never throws and never delays an answer: a record that can't be written is dropped, and what the person
 * sees does not depend on it. Rows older than KEEP_DAYS are deleted as part of the write.
 */
export function recordOffered(app: App, entry: DiscoveryEntry, routes: readonly DiscoveryRoute[], now: Date = new Date()): void {
  bump(app, entry, routes, "offered", now);
}

/** Count one follow. Same rules as `recordOffered`. */
export function recordFollowed(app: App, entry: DiscoveryEntry, route: DiscoveryRoute, now: Date = new Date()): void {
  bump(app, entry, [route], "followed", now);
}

function bump(app: App, entry: DiscoveryEntry, routes: readonly DiscoveryRoute[], column: "offered" | "followed", now: Date): void {
  try {
    if (!isDiscoveryEntry(entry)) return;
    const counts = new Map<DiscoveryRoute, number>();
    for (const route of routes) if (isDiscoveryRoute(route)) counts.set(route, (counts.get(route) ?? 0) + 1);
    if (!counts.size) return;
    const day = dayOf(now);
    // A savepoint when a follow is already running in a transaction: a count that fails is undone alone, and never the follow.
    app.db.tx(() => {
      app.db.run("DELETE FROM discovery_routes WHERE day < ?", dayOf(new Date(now.getTime() - KEEP_DAYS * 86_400_000)));
      for (const [route, n] of counts) {
        app.db.run(
          `INSERT INTO discovery_routes (day, entry, route, ${column}) VALUES (?, ?, ?, ?)
           ON CONFLICT (day, entry, route) DO UPDATE SET ${column} = ${column} + excluded.${column}`, day, entry, route, n);
      }
    });
  } catch (err) {
    console.warn("[api] a discovery route couldn't be counted:", err instanceof Error ? err.message : "unknown error");
  }
}

type SourceStat = { id: string; following: number; aged: number; agedStill: number };

/**
 * The counts over the last WINDOW_DAYS days. `offered` and `followed` come from the daily counters. The rest come from the sources followed in
 * those days that carry a route: `following` of them are still followed; `aged` were followed at least KEPT_AFTER_DAYS ago, and `agedStill` of
 * those were followed for at least that long (still followed, or unfollowed no sooner than that after following). `unused`: the routes of the
 * list that show nothing at all in the window, the ones that could go once the counting has run long enough to say so (`since`).
 */
export function discoveryRouteStats(app: App, now: Date = new Date()): DiscoveryRoutesDTO {
  const since = dayOf(new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000));
  const sinceAt = `${since}T00:00:00.000Z`;
  const agedBefore = new Date(now.getTime() - KEPT_AFTER_DAYS * 86_400_000).toISOString();
  const table = (column: "route" | "entry"): DiscoveryRouteStatDTO[] => {
    const counted = new Map(app.db.all<{ id: string; offered: number; followed: number }>(
      `SELECT ${column} AS id, SUM(offered) AS offered, SUM(followed) AS followed FROM discovery_routes WHERE day >= ? GROUP BY ${column}`, since).map((r) => [r.id, r]));
    const sources = new Map(app.db.all<SourceStat>(
      `SELECT discovery_${column} AS id, SUM(followed) AS following,
         SUM(created_at <= ?) AS aged,
         SUM(created_at <= ? AND (followed = 1 OR julianday(unfollowed_at) - julianday(created_at) >= ?)) AS agedStill
       FROM sources WHERE discovery_${column} IS NOT NULL AND created_at >= ? GROUP BY discovery_${column}`, agedBefore, agedBefore, KEPT_AFTER_DAYS, sinceAt).map((r) => [r.id, r]));
    // An id the list no longer has (a route that was removed) still shows while it has a count: the table says what was recorded.
    return [...new Set([...counted.keys(), ...sources.keys()])].map((id) => ({
      id, offered: counted.get(id)?.offered ?? 0, followed: counted.get(id)?.followed ?? 0,
      following: sources.get(id)?.following ?? 0, aged: sources.get(id)?.aged ?? 0, agedStill: sources.get(id)?.agedStill ?? 0,
    })).sort((a, b) => b.offered - a.offered || b.followed - a.followed || a.id.localeCompare(b.id));
  };
  const routes = table("route");
  const seen = new Set(routes.map((r) => r.id));
  return {
    days: WINDOW_DAYS,
    since: app.db.get<{ day: string | null }>("SELECT MIN(day) AS day FROM discovery_routes")?.day ?? null,
    routes,
    entries: table("entry"),
    unused: DISCOVERY_ROUTES.filter((r) => !seen.has(r)),
  };
}
