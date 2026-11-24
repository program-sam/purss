import type { Outbox as NoteOutbox } from "../annotations/outbox.ts";
import { outbox as deviceNotes } from "../annotations/outbox-store.ts";
import { outbox as deviceChanges } from "../outbox/instance.ts";
import type { Outbox as ChangeOutbox } from "../outbox/outbox.ts";
import { clearLateWrites, countLateWrites } from "./late-writes.ts";

/**
 * What this device does with the writes it could not send yet when a person leaves it. Three queues
 * hold them, each under the account that made them:
 *
 * - highlights and notes, in IndexedDB (`purss-annotations`, annotations/outbox.ts);
 * - playback positions and reading progress, in local storage (`purss-late:`, lib/late-writes.ts);
 * - changes to items (workflow, keep, clearing New), in IndexedDB (`purss-outbox`, outbox/outbox.ts).
 *
 * Signing out and disconnecting the app delete every account's highlights, notes, positions and progress. A
 * connection PURSS ended (`lost`) keeps them, per account, to be sent when that account connects again: they are the
 * person's own writing. Changes to items are not, so the app forgets them with the rest whenever it stops being connected
 * (disconnected, PURSS unreachable, lost). Signing out is different: it asks the person whether to send or discard the
 * signed-in account's first (outbox/sign-out.ts), and other accounts' stay on the device, set aside, until that account
 * signs in again. Another account signing in is each queue's own housekeeping while it syncs (annotations/use-annotations.ts,
 * state/late-progress-sync.ts, outbox/outbox.ts): a browser deletes the other accounts' highlights, notes, positions and
 * progress, an app keeps them, and the changes to items stay set aside in both.
 *
 * `count` is what the warning before disconnecting counts: everything `forget` removes for that reason, read from the
 * device itself rather than from what this page has loaded.
 */
export type UnsentReason = "signed-out" | "disconnected" | "unreachable" | "lost";

/** Whether the highlights, notes, positions and progress stay on the device for each reason. */
const STAYS: Record<UnsentReason, boolean> = {
  "signed-out": false,
  disconnected: false,
  unreachable: false,
  lost: true,
};

/** Whether every account's changes to items are removed from the device for each reason. */
const CHANGES_GO: Record<UnsentReason, boolean> = {
  "signed-out": false,
  disconnected: true,
  unreachable: true,
  lost: true,
};

export type UnsentQueues = {
  /** Highlights and notes. */
  notes: Pick<NoteOutbox, "clearAll" | "count">;
  /** Playback positions and reading progress, of every account. */
  late: { count(): number; clear(): void };
  /** Changes to items, of every account. */
  changes: Pick<ChangeOutbox, "clearAll" | "countAll">;
};

/** What this device holds that has not been sent, of every account. */
export type UnsentCounts = {
  /** Highlights and notes. */
  notes: number;
  /** Playback positions and reading progress. */
  late: number;
  /** Changes to items. */
  changes: number;
};

export const unsentTotal = ({ notes, late, changes }: UnsentCounts): number => notes + late + changes;

export type Forgotten = {
  /** Highlights and notes left on the device (every account's), for the notice that says they stay. */
  keptNotes: number;
  /** Playback positions and reading progress left on the device (every account's), for the same notice. */
  keptLate: number;
};

export type UnsentWrites = {
  /** What is on this device now, counted from the device. */
  count(): Promise<UnsentCounts>;
  /** Apply the rule for `reason` to everything unsent on this device. Rejects, after doing the rest, when one queue could not be forgotten. */
  forget(reason: UnsentReason): Promise<Forgotten>;
};

export function unsentWrites(queues: UnsentQueues): UnsentWrites {
  return {
    async count() {
      const [notes, changes] = await Promise.all([queues.notes.count(), queues.changes.countAll()]);
      return { notes, late: queues.late.count(), changes };
    },
    async forget(reason) {
      const failures: unknown[] = [];
      const attempt = async <T>(run: () => T | Promise<T>): Promise<T | undefined> => {
        try { return await run(); } catch (err) { failures.push(err); return undefined; }
      };
      let kept: Forgotten = { keptNotes: 0, keptLate: 0 };
      if (STAYS[reason]) {
        kept = { keptNotes: await attempt(() => queues.notes.count()) ?? 0, keptLate: await attempt(() => queues.late.count()) ?? 0 };
      } else {
        await attempt(() => queues.late.clear());
        await attempt(() => queues.notes.clearAll());
      }
      if (CHANGES_GO[reason]) await attempt(() => queues.changes.clearAll());
      if (failures.length) throw failures[0];
      return kept;
    },
  };
}

/** This device's. */
export const deviceWrites = unsentWrites({
  notes: deviceNotes,
  late: { count: () => countLateWrites(), clear: () => clearLateWrites() },
  changes: deviceChanges,
});
