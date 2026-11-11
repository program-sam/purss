import type { CollectionStatsRow, StatsNumbers, WorkflowState } from "@purss/domain";

/** Plain presentation of the statistics numbers. Nothing here ranks or judges; it only formats and orders. */

/** "24%", "<1%" for a small non-zero share, "0%" for none. Empty when there is nothing to take a share of. */
export function sharePercent(count: number, total: number): string {
  if (total <= 0) return "";
  if (count <= 0) return "0%";
  const p = (count / total) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** The count first, so a small number is visible as small: "31 (24%)". */
export function countWithShare(count: number, total: number): string {
  const share = sharePercent(count, total);
  return share ? `${count} (${share})` : String(count);
}

/** Items per week over the weeks given, to one decimal. */
export function weeklyAverage(weekly: readonly number[]): number {
  if (!weekly.length) return 0;
  return Math.round((weekly.reduce((n, c) => n + c, 0) / weekly.length) * 10) / 10;
}

/** The numbers behind a weekly bar chart, for people who can't see it. */
export function sparklineLabel(weekly: readonly number[]): string {
  return `Items per week over the last ${weekly.length} weeks, oldest first: ${weekly.join(", ")}. Average ${weeklyAverage(weekly)} per week.`;
}

/** "56 days", "1 day", "0.4 days"; a dash when there are fewer than two items to measure between. */
export function gapLabel(days: number | null): string {
  if (days === null) return "–";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export type StatsSortKey = "name" | "items" | "weekly" | "last" | WorkflowState | "opened" | "kept" | "filtered";

/** The number a column sorts by (the name sorts as text). */
function valueOf(row: CollectionStatsRow, key: Exclude<StatsSortKey, "name">): number {
  const s: StatsNumbers = row.stats;
  switch (key) {
    case "items": return s.totalItems;
    case "weekly": return weeklyAverage(s.weekly);
    case "last": return s.lastItemAt ? Date.parse(s.lastItemAt) : Number.NEGATIVE_INFINITY;
    case "opened": return s.opened;
    case "kept": return s.kept;
    case "filtered": return s.filteredOut;
    default: return s.workflow[key];
  }
}

/** Rows ordered by one column, in the direction the person chose; ties fall back to the name. */
export function sortRows(rows: readonly CollectionStatsRow[], key: StatsSortKey, dir: "asc" | "desc"): CollectionStatsRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: CollectionStatsRow, b: CollectionStatsRow) => a.title.localeCompare(b.title);
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    const x = valueOf(a, key);
    const y = valueOf(b, key);
    return x === y ? byName(a, b) : sign * (x < y ? -1 : 1);
  });
}

/** A column opens in the direction people expect: names A to Z, numbers and dates largest or latest first. */
export function firstDirection(key: StatsSortKey): "asc" | "desc" {
  return key === "name" ? "asc" : "desc";
}
