import type { Player, PlayerSnapshot } from "./player.ts";
import { SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS } from "./logic.ts";

/** The parts of the Media Session API the player uses (lock screen, headset buttons, OS media controls). */
export type MediaSessionLike = {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler(action: string, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void;
  setPositionState?(state?: { duration: number; playbackRate: number; position: number }): void;
};

type MetadataCtor = new (init: { title: string; artist: string; album?: string; artwork?: { src: string }[] }) => unknown;

/**
 * Keep the operating system's media controls in step with the player. Returns a function that
 * removes the handlers. A native backend replaces this with the platform's own session.
 */
export function bindMediaSession(player: Player, session: MediaSessionLike, Metadata: MetadataCtor): () => void {
  const handlers: Record<string, (d: { seekTime?: number; seekOffset?: number }) => void> = {
    play: () => void player.play(),
    pause: () => player.pause(),
    stop: () => void player.close(),
    seekbackward: (d) => player.skip(-(d.seekOffset ?? SKIP_BACK_SECONDS)),
    seekforward: (d) => player.skip(d.seekOffset ?? SKIP_FORWARD_SECONDS),
    seekto: (d) => { if (typeof d.seekTime === "number") player.seek(d.seekTime); },
    // One episode plays at a time, so next and previous skip within it: a headset's double press arrives as "next track".
    nexttrack: () => player.forward(),
    previoustrack: () => player.back(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { session.setActionHandler(action, fn); } catch { /* an action this browser doesn't know */ }
  }
  let lastItem: string | null = null;
  const sync = (snap: PlayerSnapshot) => {
    const now = snap.now;
    if (!now) {
      session.metadata = null;
      session.playbackState = "none";
      lastItem = null;
      return;
    }
    if (now.itemId !== lastItem) {
      lastItem = now.itemId;
      const artwork = now.imageUrl && /^https:\/\//.test(now.imageUrl) ? [{ src: now.imageUrl }] : undefined;
      session.metadata = new Metadata({ title: now.title, artist: now.sourceTitle, ...(artwork ? { artwork } : {}) });
    }
    session.playbackState = snap.state.playing ? "playing" : "paused";
    const { duration, position } = snap.state;
    if (duration !== null && session.setPositionState) {
      try { session.setPositionState({ duration, playbackRate: snap.rate, position: Math.min(position, duration) }); } catch { /* inconsistent values while seeking */ }
    }
  };
  const unsubscribe = player.subscribe(() => sync(player.getSnapshot()));
  sync(player.getSnapshot());
  return () => {
    unsubscribe();
    for (const action of Object.keys(handlers)) { try { session.setActionHandler(action, null); } catch { /* ignore */ } }
    session.metadata = null;
    session.playbackState = "none";
  };
}
