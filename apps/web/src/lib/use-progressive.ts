import { startTransition, useEffect, useState } from "react";

/** Rows drawn at once: enough to fill a tall screen in any view. */
export const FIRST_BATCH = 30;
/** Rows added per later batch. */
export const NEXT_BATCH = 40;

/**
 * How many of `total` rows to draw now. A long list draws its first screenful at once and the rest in batches
 * after that, as low-priority updates, so a click or a key press in between is handled first.
 * Changing `key` (another view, another place) starts again from the first batch; rows already drawn stay when
 * more load.
 */
export function useProgressive(total: number, key: string): number {
  const [state, setState] = useState({ key, n: FIRST_BATCH });
  let n = state.n;
  if (state.key !== key) {
    n = FIRST_BATCH;
    setState({ key, n });
  }
  const shown = Math.min(total, n);
  useEffect(() => {
    // A low-priority render: the batch just committed paints first, and input in between is handled first.
    if (shown < total) startTransition(() => setState((s) => (s.key === key ? { key, n: Math.max(s.n, shown) + NEXT_BATCH } : s)));
  }, [shown, total, key]);
  return shown;
}
