import type { MutedWord } from "@purss/domain";
import type { App } from "../app.ts";
import type { SqlParam } from "../db/database.ts";
import { mutedPatterns } from "./muted-match.ts";
import { getPreferences } from "./preferences.ts";

/*
 * Muted words (plan/34): words or phrases whose items are left out of Home and lists for a while or until removed. The items stay
 * stored; only what is listed changes. A word matches whole words of an item's title or summary, the way search reads them (see
 * muted-match.ts). The match is made on the row a query looks at, by the SQL function `purss_muted`, so what a list costs does not
 * depend on how many items a word matches, or on what other PURSSes hold.
 */

/** Muted words that have not ended yet. */
export function activeMutedWords(words: readonly MutedWord[], now: Date = new Date()): MutedWord[] {
  const at = now.getTime();
  return words.filter((w) => w.until === null || Date.parse(w.until) > at);
}

/** The PURSS's muted words for `purss_muted` (a JSON string, the one parameter below), or null when none are set. */
export function workspaceMuted(app: App, workspaceId: string, now: Date = new Date()): string | null {
  return mutedPatterns(activeMutedWords(getPreferences(app, workspaceId).mutedWords, now).map((w) => w.text));
}

/** Over `items i`: no muted word matches the item. Takes `workspaceMuted` as its parameter. */
export const NOT_MUTED = "NOT purss_muted(?, i.title, i.excerpt)";
/** The same over the columns `title` and `excerpt` of a list's rows (a query around the list). */
export const NOT_MUTED_ROW = "NOT purss_muted(?, title, excerpt)";

/**
 * How many items are looked at to say how many muted words left out of a list or Home: the first this many of what the list
 * would hold without them. A longer list is counted in part and says so. A test hook, so the tests need not make thousands of items.
 */
export const mutedScan = { rows: 1000 };

/**
 * Count the items the muted words match among the candidates of `from ... where` (alias `i` for items), looking at no more than
 * `mutedScan.rows` of them. `order`: the order to take them in, which also steers the planner to the index the list's own query
 * uses: asked in no order, it may walk the whole PURSS for a scope with few items (New, To read).
 */
export function countMuted(app: App, patterns: string, from: string, where: string, params: readonly SqlParam[], order = ""): { hidden: number; atLeast: boolean } {
  const row = app.db.get<{ hidden: number | null; scanned: number }>(
    `SELECT SUM(purss_muted(?, t, e)) AS hidden, COUNT(*) AS scanned FROM (SELECT i.title AS t, i.excerpt AS e ${from} WHERE ${where} ${order} LIMIT ${mutedScan.rows + 1})`,
    patterns, ...params)!;
  return { hidden: row.hidden ?? 0, atLeast: row.scanned > mutedScan.rows };
}

/** Which of these items (by id) the muted words match. */
export function mutedAmong(app: App, patterns: string, itemIds: readonly string[]): Set<string> {
  if (!itemIds.length) return new Set();
  return new Set(app.db.all<{ id: string }>(
    "SELECT i.id FROM json_each(?) j CROSS JOIN items i ON i.id = j.value WHERE purss_muted(?, i.title, i.excerpt)", JSON.stringify(itemIds), patterns).map((r) => r.id));
}
