import type { BackendState, PlaybackSource, PlayerBackend } from "./backend.ts";
import { IDLE_STATE } from "./backend.ts";

/** The browser's own media element. One <video> element plays both audio and video. */
export class HtmlMediaBackend implements PlayerBackend {
  readonly supportsVideo = true;
  #el: HTMLVideoElement | null = null;
  #listeners = new Set<() => void>();
  #state: BackendState = IDLE_STATE;
  #startAt = 0;
  #loaded = false;

  #element(): HTMLVideoElement {
    if (this.#el) return this.#el;
    const el = document.createElement("video");
    el.preload = "metadata";
    el.playsInline = true;
    el.className = "player-video";
    const update = () => this.#update();
    for (const ev of ["timeupdate", "durationchange", "play", "pause", "playing", "waiting", "ended", "error", "ratechange", "seeked"]) el.addEventListener(ev, update);
    el.addEventListener("loadedmetadata", () => {
      if (this.#startAt > 0 && Number.isFinite(el.duration)) el.currentTime = Math.min(this.#startAt, Math.max(0, el.duration - 1));
      this.#startAt = 0;
      this.#update();
    });
    this.#el = el;
    return el;
  }

  #update(): void {
    const el = this.#el;
    if (!el || !this.#loaded) return;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    this.#state = {
      position: el.currentTime || 0,
      duration,
      playing: !el.paused && !el.ended,
      buffering: !el.paused && el.readyState < 3,
      ended: el.ended,
      failed: !!el.error,
    };
    for (const l of this.#listeners) l();
  }

  load(source: PlaybackSource, opts: { startAt: number; rate: number; autoplay: boolean }): void {
    const el = this.#element();
    this.#loaded = true;
    this.#startAt = opts.startAt;
    el.src = source.url;
    el.playbackRate = opts.rate;
    el.defaultPlaybackRate = opts.rate;
    this.#update();
    if (opts.autoplay) void this.play();
  }

  async play(): Promise<void> {
    try { await this.#element().play(); } catch { /* blocked or failed: the element's state says which */ }
    this.#update();
  }

  pause(): void { this.#el?.pause(); }

  seek(seconds: number): void {
    const el = this.#el;
    if (!el) return;
    const end = Number.isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = Math.max(0, Math.min(seconds, end));
  }

  setRate(rate: number): void {
    if (!this.#el) return;
    this.#el.playbackRate = rate;
    this.#el.defaultPlaybackRate = rate;
  }

  view(): HTMLElement | null { return this.#element(); }

  state(): BackendState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  unload(): void {
    const el = this.#el;
    this.#loaded = false;
    this.#state = IDLE_STATE;
    if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
    for (const l of this.#listeners) l();
  }
}
