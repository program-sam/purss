import type { App } from "../app.ts";
import { emit } from "../app.ts";
import { nowIso } from "../http.ts";
import { pruneItemReminders, runItemReminders } from "./item-reminders.ts";
import { pruneNotifications, runDigest, runProblemCheck } from "./notifications.ts";
import { getPreferences } from "./preferences.ts";

/*
 * The work that keeps a PURSS tidy for someone who comes back (plan/29 §2), run from the API's maintenance
 * tick but throttled here, so the tick can call it every time: every five minutes digests that have come due,
 * problems worth telling about, reminders whose day has come and pauses that have run out; every hour New markers that have expired, old
 * notifications and each source's recent rate. Every step works one PURSS at a time and in small batches.
 */

const FAST_MS = 5 * 60_000;
const SLOW_MS = 60 * 60_000;
const EXPIRE_BATCH = 1000;

const lastRun = new WeakMap<App, { fast: number; slow: number }>();

type Active = { id: string; account_id: string };
const workspaces = (app: App) => app.db.all<Active>("SELECT w.id, w.account_id FROM workspaces w JOIN accounts a ON a.id = w.account_id WHERE a.status = 'active'");

/** Sources paused "for a week" or "for a month" start collecting again once that time has passed. */
export function resumePausedSources(app: App, now: Date = new Date()): number {
  const due = app.db.all<{ id: string; account_id: string }>("SELECT id, account_id FROM sources WHERE paused = 1 AND paused_until IS NOT NULL AND paused_until <= ?", now.toISOString());
  for (const s of due) {
    app.db.run("UPDATE sources SET paused = 0, paused_until = NULL WHERE id = ?", s.id);
    emit(app, s.account_id, { type: "source", sourceId: s.id });
  }
  return due.length;
}

/**
 * Clear the New marker on items that arrived longer ago than the person chose (never when they chose "never").
 * Only the marker changes. Items that arrived since the previous visit began keep theirs, so someone away for a long
 * time still finds what came while they were gone; the next visit lets those expire too.
 */
export function expireFreshMarkers(app: App, workspaceId: string, now: Date = new Date()): number {
  const days = getPreferences(app, workspaceId).freshDays;
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const lastVisit = app.db.get<{ last_visit_at: string | null }>("SELECT last_visit_at FROM workspaces WHERE id = ?", workspaceId)?.last_visit_at ?? null;
  let total = 0;
  for (;;) {
    const n = app.db.tx(() => app.db.run(
      `UPDATE item_state SET fresh = 0, state_version = state_version + 1, updated_at = ? WHERE workspace_id = ? AND item_id IN (
         SELECT st.item_id FROM item_state st JOIN items i ON i.id = st.item_id
         WHERE st.workspace_id = ? AND st.fresh = 1 AND i.discovered_at < ? AND (? IS NULL OR i.discovered_at <= ?) LIMIT ?)`,
      nowIso(), workspaceId, workspaceId, cutoff, lastVisit, lastVisit, EXPIRE_BATCH).changes);
    total += n;
    if (n < EXPIRE_BATCH) break;
  }
  return total;
}

export function runReturningPass(app: App, now: Date = new Date(), opts: { force?: boolean } = {}): void {
  const t = lastRun.get(app) ?? { fast: 0, slow: 0 };
  lastRun.set(app, t);
  const ms = now.getTime();
  const fast = opts.force || ms - t.fast >= FAST_MS;
  const slow = opts.force || ms - t.slow >= SLOW_MS;
  if (!fast && !slow) return;
  if (fast) t.fast = ms;
  if (slow) t.slow = ms;
  if (fast) resumePausedSources(app, now);
  for (const w of workspaces(app)) {
    // One PURSS's trouble must not hold up the others.
    try {
      if (fast) { runDigest(app, w.id, w.account_id, now); runProblemCheck(app, w.id, w.account_id, now); runItemReminders(app, w.id, w.account_id, now); }
      if (slow) {
        if (expireFreshMarkers(app, w.id, now)) emit(app, w.account_id, { type: "items", sourceIds: [], count: 0 });
        pruneNotifications(app, w.id, now);
        pruneItemReminders(app, w.id, now);
      }
    } catch (err) {
      console.error(`[api] returning pass failed for ${w.id}:`, err);
    }
  }
}
