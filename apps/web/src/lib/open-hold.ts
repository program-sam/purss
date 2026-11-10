import type { ItemDTO } from "@purss/domain";

/**
 * The item open in the panel that was New when it was opened. Opening takes the New marker away at once, but lists keep
 * showing the item where it was, still marked New, until the panel closes, so you are never reading something the list
 * behind has already dropped.
 */
export type OpenHold = {
  get: () => string | null;
  subscribe: (fn: () => void) => () => void;
  /** The panel opened this item: held when it was New, otherwise nothing is held. */
  open: (item: Pick<ItemDTO, "id" | "fresh">) => void;
  /**
   * The panel is on screen. Its effect may be replayed (React's development StrictMode mounts, unmounts and mounts again),
   * so leaving is decided a moment later: `stay` after a `release` cancels it.
   */
  stay: () => void;
  /** The panel is leaving. If nothing stays a moment later (it really closed, or another item opened), the hold ends. */
  release: () => void;
};

export function createOpenHold(): OpenHold {
  let held: string | null = null;
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const set = (id: string | null) => { if (held === id) return; held = id; listeners.forEach((fn) => fn()); };
  const stay = () => { if (leaving) { clearTimeout(leaving); leaving = null; } };
  return {
    get: () => held,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    open: (item) => { stay(); set(item.fresh ? item.id : null); },
    stay,
    release: () => { stay(); leaving = setTimeout(() => { leaving = null; set(null); }, 0); },
  };
}

/**
 * A list as it shows while `held` is open: the held item keeps its place and its New marker. Only being seen is put off:
 * if it would not belong even as New (it was ignored, say), it leaves as usual. `openCopy` is the open item as the page
 * last has it and `lastShown` the list as it showed before, so a reload of the list that no longer has the item (the
 * PURSS already counts it as seen) puts it back where it was.
 */
export function withOpenItem(all: readonly ItemDTO[], keeps: (i: ItemDTO) => boolean, held: string | null, openCopy?: ItemDTO, lastShown: readonly ItemDTO[] = []): ItemDTO[] {
  const out: ItemDTO[] = [];
  for (const it of all) {
    if (it.id === held) { const asNew = { ...it, fresh: true }; if (keeps(asNew)) out.push(asNew); }
    else if (keeps(it)) out.push(it);
  }
  if (held && openCopy && openCopy.id === held && !all.some((i) => i.id === held)) {
    const at = lastShown.findIndex((i) => i.id === held);
    const asNew = { ...openCopy, fresh: true };
    if (at >= 0 && keeps(asNew)) out.splice(Math.min(at, out.length), 0, asNew);
  }
  return out;
}
