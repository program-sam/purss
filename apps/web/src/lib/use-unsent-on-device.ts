import { useEffect, useState } from "react";
import { useOtherAccountsUnsent, useWaitingCount } from "../annotations/use-annotations.ts";
import { usePendingCount } from "../outbox/hooks.ts";
import { deviceWrites } from "./unsent-writes.ts";
import type { UnsentCounts } from "./unsent-writes.ts";

const NONE: UnsentCounts = { notes: 0, late: 0, changes: 0 };

/** Playback positions and reading progress announce nothing when they change, so they are counted again this often. */
const RECOUNT_MS = 5_000;

/**
 * Everything this device holds that has not been sent, of every account, counted from the device (see unsent-writes.ts):
 * what disconnecting the app would delete. Counted again when this page's own queues change and every few seconds.
 */
export function useUnsentOnDevice(): UnsentCounts {
  const [counts, setCounts] = useState(NONE);
  const [tick, setTick] = useState(0);
  const notes = useWaitingCount();
  const otherNotes = useOtherAccountsUnsent().entries.length;
  const changes = usePendingCount();
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), RECOUNT_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let current = true;
    void deviceWrites.count().then((held) => {
      if (current) setCounts((was) => (was.notes === held.notes && was.late === held.late && was.changes === held.changes ? was : held));
    }, () => undefined);
    return () => { current = false; };
  }, [notes, otherNotes, changes, tick]);
  return counts;
}
