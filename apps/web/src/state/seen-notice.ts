import { useSyncExternalStore } from "react";
import { createSeenStore } from "../lib/open-item.ts";
import type { SeenNotice } from "../lib/open-item.ts";

/**
 * The item panel's "Marked as seen" line for the item just opened. In memory only: a reload does not bring it back, and
 * opening another item (or closing the panel) removes it.
 */
export const seenNotices = createSeenStore();

/** The notice for this item, or null when the line is not showing for it. */
export function useSeenNotice(itemId: string): SeenNotice | null {
  return useSyncExternalStore(seenNotices.subscribe, () => { const n = seenNotices.get(); return n?.itemId === itemId ? n : null; }, () => null);
}
