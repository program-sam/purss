/**
 * The platform boundary of the in-app player (plan/25). Everything that actually plays a URL and
 * reports where it is lives behind this interface; the controller (player.ts), the Media Session
 * wiring and the UI never touch a media element directly. The web app uses HtmlMediaBackend; a
 * native app can supply its own backend (background audio, lock-screen controls, files downloaded
 * to the device) without changing anything else.
 */

export type PlaybackSource = {
  /** What to play: a publisher's https address, or a device file. */
  url: string;
  kind: "audio" | "video";
  /** Declared or stored MIME type, when known. */
  type: string | null;
  /** What is playing, for the system's media controls (the lock screen and notification in the apps). */
  title?: string;
  artist?: string;
  /** An https image for those controls. */
  artwork?: string | null;
};

export type BackendState = {
  /** Seconds from the start. */
  position: number;
  /** Seconds, once known. */
  duration: number | null;
  playing: boolean;
  /** Waiting for data while meant to be playing. */
  buffering: boolean;
  ended: boolean;
  /** Set when the source can't be played; plain words are added by the controller. */
  failed: boolean;
};

export const IDLE_STATE: BackendState = { position: 0, duration: null, playing: false, buffering: false, ended: false, failed: false };

export interface PlayerBackend {
  /** Whether video can be shown (the web backend draws it in an element; an audio-only native backend can't). */
  readonly supportsVideo: boolean;
  /** Replace whatever is loaded. Starts at `startAt` seconds once the duration is known. */
  load(source: PlaybackSource, opts: { startAt: number; rate: number; autoplay: boolean }): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  /** The element that shows video, to be placed in the page; null for backends that draw nothing. */
  view(): HTMLElement | null;
  state(): BackendState;
  /** Called on every change of state (time, duration, play/pause, buffering, end, failure). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stop and forget the source. */
  unload(): void;
}
