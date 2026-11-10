import type { LateStore } from "../lib/late-writes.ts";

/**
 * Reading progress read without a connection (plan/31): kept on the device (lib/late-writes.ts) and
 * sent when the connection is back. Progress only grows, so the larger value wins: what is waiting is
 * sent only when it is ahead of the server's, against the item's current revision (the server's
 * guard against stale writers still applies), and dropped once the server has as much or more.
 */
export type LateProgressDeps = {
  store: LateStore<number>;
  /** The server's progress and revision for an item. */
  read(itemId: string): Promise<{ progress: number; revision: number }>;
  /** Send progress against a revision; rejects with the API's error. */
  write(itemId: string, progress: number, expectedRevision: number): Promise<void>;
  worthRetrying(err: unknown): boolean;
};

/** Progress that reached the server: whatever was waiting for the item at or below it isn't needed any more. */
export function settleProgress(store: LateStore<number>, itemId: string, sent: number): void {
  const waiting = store.all()[itemId];
  if (waiting !== undefined && waiting <= sent) store.remove(itemId, waiting);
}

/** Send what is waiting; stops at the first item that can't be reached (still offline). */
export async function sendLateProgress(deps: LateProgressDeps): Promise<void> {
  for (const [itemId, value] of Object.entries(deps.store.all())) {
    try {
      const server = await deps.read(itemId);
      if (server.progress < value) await deps.write(itemId, value, server.revision);
      deps.store.remove(itemId, value);
    } catch (err) {
      const e = err as { code?: unknown } | null;
      // Changed meanwhile: read it again next time. Unreachable: try again later.
      if (e?.code === "conflict") continue;
      if (deps.worthRetrying(err)) return;
      deps.store.remove(itemId, value);
    }
  }
}
