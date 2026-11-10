import { useSyncExternalStore } from "react";
import { readRecord, savedItemIds } from "./store.ts";

/** What Settings shows about the saved reading queue. */
export type PackStatus = { running: boolean; savedCount: number; savedAt: string | null };

let status: PackStatus = { running: false, savedCount: 0, savedAt: null };
const listeners = new Set<() => void>();

function set(next: Partial<PackStatus>): void {
  const merged = { ...status, ...next };
  if (merged.running === status.running && merged.savedCount === status.savedCount && merged.savedAt === status.savedAt) return;
  status = merged;
  listeners.forEach((fn) => fn());
}

export function setPackRunning(running: boolean): void {
  set({ running });
}

/** Read the device's copies again: how many items are saved and when the queue was last saved. */
export async function refreshPackStatus(accountId: string | null): Promise<void> {
  if (!accountId) { set({ savedCount: 0, savedAt: null }); return; }
  const ids = await savedItemIds(accountId);
  set({ savedCount: ids.size, savedAt: readRecord(accountId).savedAt });
}

export function usePackStatus(): PackStatus {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => status, () => status);
}
