import { Capacitor } from "@capacitor/core";
import { AudioPlayer } from "@mediagrid/capacitor-native-audio";
import type { BackendState, PlaybackSource, PlayerBackend } from "../../player/backend.ts";
import { IDLE_STATE } from "../../player/backend.ts";
import { HtmlMediaBackend } from "../../player/html-backend.ts";
import { SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS } from "../../player/logic.ts";

/**
 * The apps' player (plan/31). Audio plays in the system's own player through
 * @mediagrid/capacitor-native-audio: Media3 in a foreground media service on Android, AVPlayer with the
 * Now Playing centre on iOS, so it keeps playing with the screen off or the app in the background and
 * shows lock-screen and notification controls. Video plays in the page, like on the web.
 */

const AUDIO_ID = "purss-player";
/** How often the position is read while playing (the plugin reports no time updates of its own). */
const POLL_MS = 1000;
/** A file that never becomes ready to play has failed (the plugin reports no errors of its own). */
const READY_TIMEOUT_MS = 30_000;

/** Narrow view of the plugin, so the backend can be driven by a fake in tests. */
export type AudioPlugin = Pick<typeof AudioPlayer,
  "create" | "initialize" | "changeAudioSource" | "changeMetadata" | "getDuration" | "getCurrentTime" | "play" | "pause" | "seek" | "setRate" | "destroy" | "onAudioReady" | "onAudioEnd" | "onPlaybackStatusChange">;

export class NativeAudioBackend implements PlayerBackend {
  readonly supportsVideo = false;
  #plugin: AudioPlugin;
  #listeners = new Set<() => void>();
  #state: BackendState = IDLE_STATE;
  /** Calls to the plugin run one after another, in order. */
  #op: Promise<void> = Promise.resolve();
  #created = false;
  #loaded = false;
  /** Bumped on every load and unload, so answers about an older file are ignored. */
  #generation = 0;
  #started = false;
  #startAt = 0;
  #rate = 1;
  #wantPlay = false;
  #poll: ReturnType<typeof setInterval> | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: AudioPlugin = AudioPlayer) { this.#plugin = plugin; }

  #set(patch: Partial<BackendState>): void {
    if (!this.#loaded) return;
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l();
  }

  /** Queue a call; it is skipped if another file was loaded meanwhile, unless `always`. */
  #queue(work: () => Promise<void>, always = false): Promise<void> {
    const gen = this.#generation;
    const run = this.#op.then(() => (always || gen === this.#generation ? work() : undefined));
    this.#op = run.catch(() => undefined);
    return run;
  }

  #fail(): void {
    this.#stopPolling();
    this.#set({ failed: true, playing: false, buffering: false });
  }

  load(source: PlaybackSource, opts: { startAt: number; rate: number; autoplay: boolean }): void {
    const gen = ++this.#generation;
    this.#loaded = true;
    this.#started = false;
    this.#startAt = opts.startAt;
    this.#rate = opts.rate;
    this.#wantPlay = opts.autoplay;
    this.#stopPolling();
    this.#state = { ...IDLE_STATE, position: opts.startAt, buffering: opts.autoplay };
    for (const l of this.#listeners) l();
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = setTimeout(() => { if (gen === this.#generation && !this.#started) this.#fail(); }, READY_TIMEOUT_MS);
    const meta = { friendlyTitle: source.title ?? "Playing", artistName: source.artist ?? "", ...(source.artwork ? { artworkSource: source.artwork } : {}) };
    void this.#queue(async () => {
      if (!this.#created) {
        // A player left over from before the page was reloaded (the native side outlives the page) goes first.
        await this.#plugin.destroy({ audioId: AUDIO_ID }).catch(() => undefined);
        await this.#plugin.create({
          audioId: AUDIO_ID, audioSource: source.url, useForNotification: true, ...meta,
          showSeekBackward: true, showSeekForward: true, seekBackwardTime: SKIP_BACK_SECONDS, seekForwardTime: SKIP_FORWARD_SECONDS,
        });
        this.#created = true;
        await this.#plugin.onAudioReady({ audioId: AUDIO_ID }, () => void this.#onReady());
        await this.#plugin.onAudioEnd({ audioId: AUDIO_ID }, () => this.#onEnd());
        await this.#plugin.onPlaybackStatusChange({ audioId: AUDIO_ID }, (r) => this.#onStatus(r.status));
        await this.#plugin.initialize({ audioId: AUDIO_ID });
      } else {
        await this.#plugin.changeMetadata({ audioId: AUDIO_ID, ...meta });
        await this.#plugin.changeAudioSource({ audioId: AUDIO_ID, source: source.url });
      }
    }).catch(() => { if (gen === this.#generation) this.#fail(); });
  }

  /** Ready to play (also after seeking): the first time for a file, apply the start point, speed and autoplay. */
  async #onReady(): Promise<void> {
    if (!this.#loaded) return;
    const gen = this.#generation;
    const { duration } = await this.#plugin.getDuration({ audioId: AUDIO_ID }).catch(() => ({ duration: -1 }));
    if (gen !== this.#generation) return;
    this.#set({ duration: duration > 0 ? duration : null, buffering: false });
    if (this.#started) return;
    this.#started = true;
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    const at = duration > 0 ? Math.min(this.#startAt, Math.max(0, duration - 1)) : this.#startAt;
    await this.#queue(async () => {
      if (at > 0) await this.#plugin.seek({ audioId: AUDIO_ID, timeInSeconds: Math.round(at) });
      await this.#plugin.setRate({ audioId: AUDIO_ID, rate: this.#rate });
      if (this.#wantPlay) await this.#plugin.play({ audioId: AUDIO_ID });
    }).catch(() => this.#fail());
  }

  #onEnd(): void {
    this.#stopPolling();
    const d = this.#state.duration;
    this.#set({ playing: false, buffering: false, ended: true, position: d ?? this.#state.position });
  }

  #onStatus(status: "playing" | "paused" | "stopped"): void {
    if (status === "playing") {
      this.#set({ playing: true, buffering: false, ended: false });
      this.#startPolling();
    } else {
      this.#stopPolling();
      // The lock screen or a headset paused it: read where it stopped so the position saved is exact.
      void this.#readPosition().finally(() => this.#set({ playing: false, buffering: false }));
    }
  }

  async #readPosition(): Promise<void> {
    if (!this.#created || !this.#loaded) return;
    const gen = this.#generation;
    try {
      const { currentTime } = await this.#plugin.getCurrentTime({ audioId: AUDIO_ID });
      if (gen === this.#generation && !this.#state.ended) this.#set({ position: currentTime });
    } catch { /* gone meanwhile */ }
  }

  #startPolling(): void {
    if (this.#poll) return;
    this.#poll = setInterval(() => void this.#readPosition(), POLL_MS);
  }

  #stopPolling(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
  }

  async play(): Promise<void> {
    this.#wantPlay = true;
    if (!this.#started) { this.#set({ buffering: true }); return; }
    // After the end the plugin is back at the start; play from there.
    if (this.#state.ended) this.#set({ ended: false, position: 0 });
    await this.#queue(() => this.#plugin.play({ audioId: AUDIO_ID })).catch(() => this.#fail());
  }

  pause(): void {
    this.#wantPlay = false;
    if (!this.#started) { this.#set({ buffering: false }); return; }
    void this.#queue(() => this.#plugin.pause({ audioId: AUDIO_ID })).catch(() => undefined);
  }

  seek(seconds: number): void {
    const end = this.#state.duration ?? Infinity;
    const to = Math.max(0, Math.min(seconds, end));
    if (!this.#started) { this.#startAt = to; this.#set({ position: to }); return; }
    this.#set({ position: to, ended: false });
    void this.#queue(() => this.#plugin.seek({ audioId: AUDIO_ID, timeInSeconds: Math.round(to) })).catch(() => undefined);
  }

  setRate(rate: number): void {
    this.#rate = rate;
    if (this.#started) void this.#queue(() => this.#plugin.setRate({ audioId: AUDIO_ID, rate })).catch(() => undefined);
  }

  view(): HTMLElement | null { return null; }
  state(): BackendState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stop, and remove the notification and lock-screen controls. */
  unload(): void {
    this.#generation++;
    this.#stopPolling();
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#loaded = false;
    this.#started = false;
    this.#state = IDLE_STATE;
    for (const l of this.#listeners) l();
    if (!this.#created) return;
    this.#created = false;
    // Runs even when another file is loaded straight after: that one is created only once this is gone.
    void this.#queue(() => this.#plugin.destroy({ audioId: AUDIO_ID }), true).catch(() => undefined);
  }
}

/** Audio through the native player, video in the page. */
export class AppPlayerBackend implements PlayerBackend {
  readonly supportsVideo = true;
  #audio: PlayerBackend;
  #video: PlayerBackend;
  #active: PlayerBackend;

  constructor(audio: PlayerBackend = new NativeAudioBackend(), video: PlayerBackend = new HtmlMediaBackend()) {
    this.#audio = audio;
    this.#video = video;
    this.#active = audio;
  }

  load(source: PlaybackSource, opts: { startAt: number; rate: number; autoplay: boolean }): void {
    const next = source.kind === "video" ? this.#video : this.#audio;
    if (next !== this.#active) this.#active.unload();
    this.#active = next;
    // A downloaded video is a device file; the page reaches those through the app's own address for them.
    const url = next === this.#video && source.url.startsWith("file://") ? Capacitor.convertFileSrc(source.url) : source.url;
    next.load({ ...source, url }, opts);
  }

  play(): Promise<void> { return this.#active.play(); }
  pause(): void { this.#active.pause(); }
  seek(seconds: number): void { this.#active.seek(seconds); }
  setRate(rate: number): void { this.#active.setRate(rate); }
  view(): HTMLElement | null { return this.#active === this.#video ? this.#video.view() : null; }
  state(): BackendState { return this.#active.state(); }

  subscribe(listener: () => void): () => void {
    const a = this.#audio.subscribe(() => { if (this.#active === this.#audio) listener(); });
    const v = this.#video.subscribe(() => { if (this.#active === this.#video) listener(); });
    return () => { a(); v(); };
  }

  unload(): void { this.#active.unload(); }
}
