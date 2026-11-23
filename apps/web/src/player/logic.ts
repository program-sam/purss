import { app } from "@purss/translations/app";
import type { PlaybackPosition, WorkflowState } from "@purss/domain";

/** Pure decisions of the player, kept apart so they can be tested without a browser. */

export const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2] as const;
export const SKIP_BACK_SECONDS = 15;
/** How far an arrow key moves the position slider, in seconds. */
export const SEEK_STEP_SECONDS = 5;

/** The seconds an arrow key moves the position slider by (right and up forward, left and down back); 0 for any other key. */
export function seekKeyStep(key: string): number {
  return key === "ArrowRight" || key === "ArrowUp" ? SEEK_STEP_SECONDS : key === "ArrowLeft" || key === "ArrowDown" ? -SEEK_STEP_SECONDS : 0;
}
export const SKIP_FORWARD_SECONDS = 30;
/** The sleep timer's choices, in minutes. */
export const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60] as const;
/** While playing, the position is saved at most this often. */
export const SAVE_EVERY_MS = 15_000;
/** Closer than this to the end counts as finished: the next play starts from the beginning. */
export const FINISHED_WITHIN_SECONDS = 15;
/** Real playing time in a player session before an item that is New or To read/listen/watch moves to In progress. */
export const IN_PROGRESS_AFTER_SECONDS = 30;
/** Played time at or after the finish point that makes the item Finished. A seek over it, or onto it, is not this. */
export const FINISHED_AFTER_PLAYED_SECONDS = 3;

/** States playback may move to In progress by itself. */
export function canPlaybackStart(workflow: WorkflowState): boolean {
  return workflow === "new" || workflow === "toread";
}

/** States playback may move forward from by itself (to Finished, or to In progress first). Ignored and Finished are left alone. */
export function canPlaybackMove(workflow: WorkflowState): boolean {
  return canPlaybackStart(workflow) || workflow === "inprogress";
}

/**
 * Where the end of an item starts: 95% of its length or its last two minutes, whichever comes first. Never before halfway, so a
 * clip shorter than four minutes is not Finished a moment into it. Null while the length is unknown.
 */
export function playbackFinishPoint(duration: number | null): number | null {
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(duration * 0.5, Math.min(duration * 0.95, duration - 120));
}

/** Where to start: the saved position, a couple of seconds back for context, or the beginning when it was finished. */
export function resumePoint(playback: PlaybackPosition | null | undefined): number {
  if (!playback) return 0;
  const { positionSeconds: pos, durationSeconds: dur } = playback;
  if (dur !== null && pos >= dur - FINISHED_WITHIN_SECONDS) return 0;
  return pos > 5 ? pos - 2 : 0;
}

/** Whether a position is worth saving now: changed by a few seconds, and not saved recently unless forced. */
export function shouldSave(last: { at: number; position: number } | null, position: number, now: number, force: boolean): boolean {
  if (!last) return position > 1 || force;
  if (Math.abs(position - last.position) < 2) return false;
  return force || now - last.at >= SAVE_EVERY_MS;
}

/** The next speed in the list, wrapping around. */
export function nextRate(rate: number): number {
  const i = RATES.findIndex((r) => r === rate);
  return RATES[(i + 1) % RATES.length]!;
}

export function rateLabel(rate: number): string {
  return `${rate}×`;
}

/** Whole minutes left on the sleep timer, rounded up, at least 1. */
export function sleepMinutesLeft(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** "4:05", "1:02:09". */
export function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "45 MB", "1.2 GB": sizes of media files. */
export function fileSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Plain words for where the sound comes from, shown beside the controls. */
export function sourceLabel(from: "publisher" | "device"): string {
  return from === "device" ? app.player.source.device : app.player.source.publisher;
}
