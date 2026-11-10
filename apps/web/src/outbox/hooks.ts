import { useEffect, useState, useSyncExternalStore } from "react";
import { useOfflineStatus } from "../offline/status.ts";
import { outbox } from "./instance.ts";

const subscribe = (fn: () => void) => outbox.subscribe(fn);

/** Whether this item has a change that PURSS has not confirmed yet. */
export function usePending(itemId: string): boolean {
  return useSyncExternalStore(subscribe, () => outbox.pendingItemIds().has(itemId), () => false);
}

/** How many changes are waiting to be sent. */
export function usePendingCount(): number {
  return useSyncExternalStore(subscribe, () => outbox.pendingCount(), () => 0);
}

/** How long a change may wait before the page says so: a change confirmed in the blink of an eye never shows a mark. */
const MARK_DELAY_MS = 700;

/**
 * Whether to show that this item has a change not yet sent: it has waited a moment, or there is no connection at all
 * (then it is known at once that it will wait).
 */
export function usePendingMark(itemId: string): boolean {
  const pending = usePending(itemId);
  const online = useOfflineStatus().browserOnline;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!pending) { setWaited(false); return; }
    const timer = setTimeout(() => setWaited(true), MARK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && (waited || !online);
}
