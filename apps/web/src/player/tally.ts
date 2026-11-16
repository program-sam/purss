import type { BackendState } from "./backend.ts";
import { FINISHED_AFTER_PLAYED_SECONDS, playbackFinishPoint } from "./logic.ts";

/** How far the playhead may run ahead of the clock between two reports and still count as playing (timers and reports are never exact). */
const SLACK_SECONDS = 1;

/**
 * What a player session has really played, apart from where its playhead is. A report counts only when the playhead moved
 * forward about as fast as the clock allows, from a report that was already playing: a seek (either way), a stall, a pause and
 * the time a page spent frozen all add nothing. The stored position is the playhead, so this is what says "listened".
 */
export class PlaybackTally {
  /** Seconds of the clock spent playing. */
  played = 0;
  /** Seconds of the media played at or after the finish point. */
  playedInFinish = 0;
  #last: { at: number; position: number } | null = null;
  /**
   * The playhead last moved by playing, not by a seek: an end reached this way was played into, whether or not the length is known.
   * Reports that leave the playhead where it was (the end reported again, a pause) keep it; any other move clears it.
   */
  #advanced = false;
  #position: number | null = null;

  /** `at`: a monotonic clock in milliseconds; `rate`: the playing speed. Call on every report of the backend. */
  report(state: BackendState, at: number, rate: number): void {
    const last = this.#last;
    const moved = this.#position !== null && state.position !== this.#position;
    this.#position = state.position;
    let advancedNow = false;
    if (last) {
      const clock = Math.max(0, at - last.at) / 1000;
      const media = state.position - last.position;
      if (media > 0 && media <= clock * rate + SLACK_SECONDS) {
        // Never more than the clock allows: a seek that lands next to the end, however close, has played none of it.
        const playedMedia = Math.min(media, clock * rate);
        this.played += playedMedia / rate;
        advancedNow = playedMedia > 0;
        const finish = playbackFinishPoint(state.duration);
        if (finish !== null) this.playedInFinish += Math.min(playedMedia, Math.max(0, state.position - Math.max(last.position, finish)));
      }
    }
    if (advancedNow) this.#advanced = true;
    else if (moved) this.#advanced = false;
    this.#last = state.playing && !state.buffering ? { at, position: state.position } : null;
  }

  /** Playing has gone on in the last stretch for a few seconds, or ran into the end of the file (by playing, not by a seek; also with no known length). */
  playedToTheEnd(state: Pick<BackendState, "ended">): boolean {
    return this.playedInFinish >= FINISHED_AFTER_PLAYED_SECONDS || (state.ended && (this.playedInFinish > 0 || this.#advanced));
  }
}
