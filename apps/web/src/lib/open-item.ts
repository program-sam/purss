import type { ItemDTO } from "@purss/domain";
import { newMarkerCleared } from "./items.ts";

/** The line shown in the item panel after opening took the New marker away: kept in memory only, for that item. */
export type SeenNotice = { itemId: string; undoToken: string };

/**
 * Where the panel's "Marked as seen" line is kept. An opening gets a generation when it starts, and may show its line only
 * while it is still the latest: opening another item, closing the panel and Undo all end the generation, so a slow answer
 * for an earlier item can never replace or remove the line of the one now open.
 */
export type SeenStore = {
  get: () => SeenNotice | null;
  subscribe: (fn: () => void) => () => void;
  /** An opening starts: any line goes, and the returned generation is the one this opening's line must still match. */
  begin: () => number;
  /** Show the line, if no later opening, closing or Undo has happened since `generation`. */
  publish: (generation: number, notice: SeenNotice) => void;
  /** Remove the line and end every opening still waiting for its answer. */
  clear: () => void;
  /**
   * The panel showing an item is on screen. Its effect may be replayed (React's development StrictMode mounts, unmounts and
   * mounts again), so leaving is only decided a moment later: `hold` after a `release` cancels it.
   */
  hold: () => void;
  /** The panel is leaving. If nothing holds the store a moment later (the panel really closed), `clear` follows. */
  release: () => void;
};

export function createSeenStore(): SeenStore {
  let current: SeenNotice | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const set = (n: SeenNotice | null) => { if (current === n) return; current = n; listeners.forEach((fn) => fn()); };
  const stay = () => { if (leaving) { clearTimeout(leaving); leaving = null; } };
  return {
    get: () => current,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    begin: () => { generation += 1; set(null); return generation; },
    publish: (g, n) => { if (g === generation) set(n); },
    clear: () => { stay(); generation += 1; set(null); },
    hold: stay,
    release: () => { stay(); leaving = setTimeout(() => { leaving = null; generation += 1; set(null); }, 0); },
  };
}

export type OpenDeps = {
  find: (id: string) => ItemDTO | undefined;
  put: (item: ItemDTO) => void;
  /** The write itself (one at a time per item, on the revision the page has): the item as PURSS now has it, and the token that undoes the change. */
  write: () => Promise<{ item: ItemDTO; undoToken: string }>;
  /** The opening took the New marker away: counts elsewhere follow. */
  newCleared: (before: ItemDTO, after: ItemDTO) => void;
  /** The panel's "Marked as seen" line. Opening an item always removes the previous one first. */
  seen: Pick<SeenStore, "begin" | "publish">;
  /** The item changed elsewhere meanwhile: look at it again. */
  conflict: (id: string) => void;
};

/**
 * Opening writes "opened" unless the item is already opened and no longer New. An item can be both opened and New (after a
 * migration, or after Undoing a seen marker), and opening it again must still clear the marker.
 */
export function itemNeedsOpening(item: Pick<ItemDTO, "opened" | "fresh">): boolean {
  return !item.opened || item.fresh;
}

/**
 * Open an item: shown as opened at once and written. When that took the New marker away, the panel gets a quiet "Marked as
 * seen" line with the Undo token (no message, no announcement); when it did not, there is nothing to say.
 */
export async function openItem(id: string, d: OpenDeps): Promise<void> {
  const generation = d.seen.begin();
  const before = d.find(id);
  if (!before || !itemNeedsOpening(before)) return;
  d.put({ ...before, opened: true });
  try {
    const out = await d.write();
    d.put(out.item);
    if (newMarkerCleared(before, out.item)) {
      d.newCleared(before, out.item);
      d.seen.publish(generation, { itemId: id, undoToken: out.undoToken });
    }
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "conflict") d.conflict(id); else d.put(before);
  }
}

export type UndoSeenDeps = {
  find: (id: string) => ItemDTO | undefined;
  put: (item: ItemDTO) => void;
  /** Press PURSS's Undo for the token. */
  undo: (undoToken: string) => Promise<void>;
  seen: Pick<SeenStore, "clear">;
  /** Everything that shows items or counts is read again. */
  refresh: () => void;
  fail: (err: unknown) => void;
};

/** Undo the "Marked as seen": the line goes at once, the item shows New again, and PURSS's Undo makes it so. */
export async function undoSeen(notice: SeenNotice, d: UndoSeenDeps): Promise<void> {
  d.seen.clear();
  const item = d.find(notice.itemId);
  if (item) d.put({ ...item, fresh: true });
  try {
    await d.undo(notice.undoToken);
    d.refresh();
  } catch (err) {
    if (item) d.put({ ...item, fresh: false });
    d.fail(err);
  }
}
