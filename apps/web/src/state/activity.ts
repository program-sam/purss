import type { QueryClient } from "@tanstack/react-query";
import { ACTIVITY_MIN_MS, activityKey } from "../api/home-queries.ts";

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Ask for fresh background activity after an event from the server, but never sooner than ACTIVITY_MIN_MS after the
 * last answer: a busy sync sends many events, and the panel only needs the latest picture. Does nothing until
 * something shows the activity.
 */
export function refreshActivity(qc: QueryClient, now = Date.now()): void {
  const state = qc.getQueryState(activityKey);
  if (!state) return;
  const wait = ACTIVITY_MIN_MS - (now - state.dataUpdatedAt);
  if (wait <= 0) { void qc.invalidateQueries({ queryKey: activityKey }); return; }
  if (pending) return;
  pending = setTimeout(() => { pending = null; void qc.invalidateQueries({ queryKey: activityKey }); }, wait);
  (pending as unknown as { unref?: () => void }).unref?.(); // only matters outside a browser: a waiting refresh must not keep a test process alive
}
