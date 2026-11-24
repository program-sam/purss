import { app } from "@purss/translations/app";
import type { UnsentReason, UnsentWrites } from "../../lib/unsent-writes.ts";

const t = app.platform.forget;

/**
 * What the app removes from the device when it stops being connected, apart from the
 * device APIs it calls, so the rules can be tested without a phone.
 *
 * - Disconnect (the person asked, after a warning that counts everything unsent on the device): everything,
 *   unsent highlights, notes, playback positions, reading progress and changes to items of every account included.
 * - Lost (PURSS says the device isn't connected any more): everything except unsent highlights, notes, playback positions
 *   and reading progress. Those are what the person made; they stay, per account, and are sent when the same account
 *   connects this app again. Unsent changes to items (workflow, keep, clearing New) go with the rest.
 *   Which of those stay or go for which reason is lib/unsent-writes.ts's rule.
 * Either way the phone stops getting notifications (the relay is told to forget its handle and the native
 * notification code's credential is removed), and the background job, its state, unfinished files and
 * the widget's snapshot go.
 * When the connection itself can't be removed from secure storage, the app must not start with it
 * again (it would be refused and lost again, over and over): the result says so.
 */
export type ForgetDeps = {
  stopAudio(): Promise<void>;
  /** Remove the device token; rejects when secure storage refuses. */
  forgetConnection(): Promise<void>;
  wipeCopies(): Promise<void>;
  /** The unsent highlights, notes, playback positions, reading progress and changes to items on this device. */
  unsent: UnsentWrites;
  removeDownloads(): Promise<void>;
  /** Stop the native background job and remove its state, unfinished files and the widget's snapshot. */
  stopBackground(): Promise<void>;
  /** Unregister from the push relay and remove the notification credential. */
  forgetPush(): Promise<void>;
  clearHints(): void;
};

export type ForgetReason = Exclude<UnsentReason, "signed-out">;

export type Forgotten = { notice: string; stuck: boolean };

export async function forgetDevice(deps: ForgetDeps, reason: ForgetReason): Promise<Forgotten> {
  await deps.stopAudio().catch(() => undefined);
  let stuck = false;
  try { await deps.forgetConnection(); } catch { stuck = true; }
  // The background job stops first, so no transfer it was running can move files in after the downloads go,
  await deps.stopBackground().catch(() => undefined);
  let kept = { keptNotes: 0, keptLate: 0 };
  await Promise.allSettled([deps.wipeCopies(), deps.unsent.forget(reason).then((forgotten) => { kept = forgotten; }), deps.removeDownloads(), deps.forgetPush()]);
  // and again after them, so nothing the page told it while removing them outlives this.
  await deps.stopBackground().catch(() => undefined);
  deps.clearHints();
  const keptNote = kept.keptNotes || kept.keptLate ? t.unsentKept(kept.keptNotes, kept.keptLate) : "";
  const stuckNote = stuck ? t.stuck : "";
  const notice = reason === "disconnected"
    ? t.disconnected
    : reason === "unreachable"
      ? t.unreachable
      : t.lost(keptNote);
  return { notice: notice + stuckNote, stuck };
}
