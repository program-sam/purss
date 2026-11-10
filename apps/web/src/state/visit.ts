import { post } from "../api/client.ts";

/*
 * Visits. The server counts a visit from the first sign of the person being here after half an hour of quiet, wherever
 * in PURSS that is: a collection, To read or Home. The app tells it when the person interacts with the page in
 * the foreground (a press, a key, a scroll, coming back to the tab), and not more than every few minutes.
 */

/** Calls are at least this far apart. */
export const VISIT_PING_MIN_MS = 3 * 60_000;

/** Whether enough time has passed since the last call. Pure, so it is tested without a browser. */
export function shouldPing(lastAt: number | null, now: number, visible: boolean): boolean {
  return visible && (lastAt === null || now - lastAt >= VISIT_PING_MIN_MS);
}

let lastAt: number | null = null;
let release: () => void = () => {};
const firstDone = new Promise<void>((r) => { release = r; });

/** Home asks "since your last visit" only once this page load's own visit call has answered (or gave up), so the answer is about the right visit. */
export function visitKnown(waitMs = 2500): Promise<void> {
  return Promise.race([firstDone, new Promise<void>((r) => setTimeout(r, waitMs))]);
}

async function ping(onStarted: () => void): Promise<void> {
  lastAt = Date.now();
  try {
    const out = await post<{ lastVisitAt: string | null; started: boolean }>("/api/activity/visit");
    if (out.started) onStarted();
  } catch {
    // Offline or signed out: the next interaction tries again.
    lastAt = null;
  } finally {
    release();
  }
}

/** Start watching for foreground interaction; the returned function stops it. `onStarted`: a new visit began, so what depends on it should be asked again. */
export function trackVisits(onStarted: () => void): () => void {
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const maybe = () => { if (shouldPing(lastAt, Date.now(), visible())) void ping(onStarted); };
  maybe();
  const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const e of events) document.addEventListener(e, maybe, { passive: true, capture: true });
  document.addEventListener("visibilitychange", maybe);
  window.addEventListener("focus", maybe);
  return () => {
    for (const e of events) document.removeEventListener(e, maybe, { capture: true });
    document.removeEventListener("visibilitychange", maybe);
    window.removeEventListener("focus", maybe);
  };
}
