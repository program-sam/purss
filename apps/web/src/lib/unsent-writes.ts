import type { Outbox as NoteOutbox } from "../annotations/outbox.ts";
import { outbox as deviceNotes } from "../annotations/outbox-store.ts";
import { clearLateWrites } from "./late-writes.ts";

/**
 * What this device does with the writes it could not send yet when a person leaves it. Three queues
 * hold them, each under the account that made them:
 *
 * - highlights and notes, in IndexedDB (`purss-annotations`, annotations/outbox.ts);
 * - playback positions and reading progress, in local storage (`purss-late:`, lib/late-writes.ts);
 * - changes to items (workflow, keep, clearing New), in IndexedDB (`purss-outbox`, outbox/outbox.ts).
 *
 * The first two follow `STAYS`: signing out and disconnecting the app delete every account's, and a
 * connection PURSS ended (`lost`) keeps them, per account, to be sent when that account connects again.
 * The changes to items are not forgotten here: signing out asks the person whether to send or discard them
 * first (outbox/sign-out.ts), and they stay on the device, set aside, when another account signs in or the
 * app is disconnected. Another account signing in is each queue's own housekeeping while it syncs
 * (annotations/use-annotations.ts, state/late-progress-sync.ts): a browser deletes the other accounts'
 * highlights, notes, positions and progress, an app keeps them.
 */
export type UnsentReason = "signed-out" | "disconnected" | "unreachable" | "lost";

/** Whether the highlights, notes, positions and progress stay on the device for each reason. */
const STAYS: Record<UnsentReason, boolean> = {
  "signed-out": false,
  disconnected: false,
  unreachable: false,
  lost: true,
};

export type UnsentQueues = {
  /** Highlights and notes. */
  notes: Pick<NoteOutbox, "clearAll" | "load" | "snapshot">;
  /** Delete every account's playback positions and reading progress. */
  clearLate(): void;
};

export type Forgotten = {
  /** Highlights and notes left on the device (every account's), for the notice that says they stay. */
  keptNotes: number;
};

export type UnsentWrites = {
  /** Apply the rule for `reason` to the highlights, notes, positions and progress on this device. */
  forget(reason: UnsentReason): Promise<Forgotten>;
};

export function unsentWrites(queues: UnsentQueues): UnsentWrites {
  return {
    async forget(reason) {
      if (STAYS[reason]) {
        await queues.notes.load();
        return { keptNotes: queues.notes.snapshot().length };
      }
      queues.clearLate();
      await queues.notes.clearAll();
      return { keptNotes: 0 };
    },
  };
}

/** This device's. */
export const deviceWrites = unsentWrites({ notes: deviceNotes, clearLate: () => clearLateWrites() });
