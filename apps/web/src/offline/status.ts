import { useSyncExternalStore } from "react";
import { OFFLINE_HEADER } from "../sw/protocol.ts";

/**
 * Whether what is on screen may be older than the server's truth: the browser says it is offline, or
 * the last answer came from this device's saved copy. A real answer from the server clears it.
 */
export type OfflineStatus = { browserOnline: boolean; copySavedAt: string | null };

let status: OfflineStatus = { browserOnline: typeof navigator === "undefined" ? true : navigator.onLine !== false, copySavedAt: null };
const listeners = new Set<() => void>();

function set(next: OfflineStatus): void {
  if (next.browserOnline === status.browserOnline && next.copySavedAt === status.copySavedAt) return;
  status = next;
  listeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => set({ ...status, browserOnline: true }));
  window.addEventListener("offline", () => set({ ...status, browserOnline: false }));
}

/** Read the browser's own answer again, for when its online and offline events didn't arrive. */
export function refreshBrowserOnline(): void {
  set({ ...status, browserOnline: navigator.onLine !== false });
}

/** Call with the headers of every answer to a read of PURSS's data. */
export function noteAnswer(headers: Headers): void {
  set({ ...status, copySavedAt: headers.get(OFFLINE_HEADER) });
}

export function showsSavedCopy(s: OfflineStatus): boolean {
  return !s.browserOnline || s.copySavedAt !== null;
}

export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => status, () => status);
}

/** Subscribe to the browser coming back online (to refresh what was shown from copies). */
export function onBackOnline(fn: () => void): () => void {
  window.addEventListener("online", fn);
  return () => window.removeEventListener("online", fn);
}

/**
 * When changes kept on this device should be sent again: the connection came back, or the page is shown again. Shared by
 * the state-write outbox and the highlights-and-notes outbox, which keep their own stores.
 */
export function onResume(fn: () => void): () => void {
  const shown = () => { if (document.visibilityState === "visible") fn(); };
  const offOnline = onBackOnline(fn);
  document.addEventListener("visibilitychange", shown);
  return () => { offOnline(); document.removeEventListener("visibilitychange", shown); };
}
