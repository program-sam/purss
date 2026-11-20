import { app } from "@purss/copy/app";

const t = app.platform.forget;

/**
 * What the app removes from the device when it stops being connected, apart from the
 * device APIs it calls, so the rules can be tested without a phone.
 *
 * - Disconnect (the person asked, after a warning about unsent highlights and notes): everything,
 *   the annotation outbox and unsent playback positions and reading progress included.
 * - Lost (PURSS says the device isn't connected any more): everything except those.
 *   Unsent highlights and notes are the person's own writing; they stay, per account, and are sent
 *   when the same account connects this app again, as do unsent positions and progress.
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
  /** The annotation outbox and the unsent playback positions and reading progress (lib/late-writes.ts). */
  clearOutbox(): Promise<void>;
  removeDownloads(): Promise<void>;
  /** Stop the native background job and remove its state, unfinished files and the widget's snapshot. */
  stopBackground(): Promise<void>;
  /** Unregister from the push relay and remove the notification credential. */
  forgetPush(): Promise<void>;
  clearHints(): void;
  /** Highlight and note changes on this device not sent yet. */
  unsent(): Promise<number>;
};

export type ForgetReason = "disconnected" | "unreachable" | "lost";

export type Forgotten = { notice: string; stuck: boolean };

export async function forgetDevice(deps: ForgetDeps, reason: ForgetReason): Promise<Forgotten> {
  await deps.stopAudio().catch(() => undefined);
  let stuck = false;
  try { await deps.forgetConnection(); } catch { stuck = true; }
  const keepOutbox = reason === "lost";
  // The background job stops first, so no transfer it was running can move files in after the downloads go,
  await deps.stopBackground().catch(() => undefined);
  await Promise.allSettled([deps.wipeCopies(), keepOutbox ? Promise.resolve() : deps.clearOutbox(), deps.removeDownloads(), deps.forgetPush()]);
  // and again after them, so nothing the page told it while removing them outlives this.
  await deps.stopBackground().catch(() => undefined);
  deps.clearHints();
  const kept = keepOutbox ? await deps.unsent().catch(() => 0) : 0;
  const keptNote = kept ? t.unsentKept(kept) : "";
  const stuckNote = stuck ? t.stuck : "";
  const notice = reason === "disconnected"
    ? t.disconnected
    : reason === "unreachable"
      ? t.unreachable
      : t.lost(keptNote);
  return { notice: notice + stuckNote, stuck };
}
