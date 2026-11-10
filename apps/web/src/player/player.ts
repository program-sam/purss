import type { ItemMedia, PlaybackPosition } from "@purss/domain";
import type { BackendState, PlayerBackend } from "./backend.ts";
import { IDLE_STATE } from "./backend.ts";
import type { LateStore } from "../lib/late-writes.ts";
import { RATES, SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS, resumePoint, shouldSave } from "./logic.ts";

/**
 * The player controller: what is playing, from where, at what speed, and keeping its position on
 * the server. It talks to a PlayerBackend only, so the same controller drives the web element
 * and the apps' native player (plan/25, plan/31).
 *
 * Positions played without a connection: every position is first kept on the device (`pending`,
 * with the time it was recorded) and removed once the server has it. What is still there is sent
 * again, with its recording time, when the connection is back (`sendPending`); the server keeps
 * whichever position was recorded last. Opening an item resumes from the newer of the server's
 * position and one kept here.
 */

export type PlayableItem = { id: string; title: string; sourceTitle: string; imageUrl: string | null; media: ItemMedia; playback: PlaybackPosition | null };

/** Where it plays from: the publisher's file, or a download on this device (the apps). The server keeps no media files. */
export type NowPlaying = { itemId: string; title: string; sourceTitle: string; imageUrl: string | null; kind: "audio" | "video"; from: "publisher" | "device" };

/** `sleepAt`: when the sleep timer pauses playback (ms since the epoch, this device's clock), or null. */
export type PlayerSnapshot = { now: NowPlaying | null; state: BackendState; rate: number; error: string | null; sleepAt: number | null };

/** A position recorded on this device that the server may not have yet. `recordedAt`: ISO time on this device. */
export type PendingPosition = { positionSeconds: number; durationSeconds: number | null; recordedAt: string };

export type PlayerDeps = {
  backend: PlayerBackend;
  /** PUT /api/items/:id/playback. `keepalive` is set when the page is going away; `recordedAt` when the position is sent late. */
  savePosition: (itemId: string, positionSeconds: number, durationSeconds: number | null, opts: { keepalive: boolean; recordedAt?: string }) => Promise<void>;
  /** Whether a failed save is worth sending again later (no connection, busy server); otherwise it is dropped. */
  worthRetrying?: (err: unknown) => boolean;
  /** A copy downloaded to this device (the apps): its address for the backend, or null. Played first, with or without a connection. */
  deviceCopy?: (itemId: string) => Promise<string | null>;
  /** Speed is a choice for this device. */
  rateStore?: { get(): number | null; set(rate: number): void };
  now?: () => number;
};

export class Player {
  readonly backend: PlayerBackend;
  #deps: PlayerDeps;
  #now: () => number;
  #listeners = new Set<() => void>();
  #current: NowPlaying | null = null;
  #rate: number;
  #error: string | null = null;
  #snapshot: PlayerSnapshot;
  #lastSaved: { at: number; position: number } | null = null;
  #wasPlaying = false;
  #opening = 0;
  #pending: LateStore<PendingPosition> | null = null;
  #sending: Promise<void> | null = null;
  #sleepAt: number | null = null;
  #sleepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PlayerDeps) {
    this.#deps = deps;
    this.backend = deps.backend;
    this.#now = deps.now ?? Date.now;
    const stored = deps.rateStore?.get() ?? null;
    this.#rate = stored !== null && (RATES as readonly number[]).includes(stored) ? stored : 1;
    this.#snapshot = { now: null, state: IDLE_STATE, rate: this.#rate, error: null, sleepAt: null };
    deps.backend.subscribe(() => this.#onBackend());
  }

  getSnapshot = (): PlayerSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit(): void {
    this.#snapshot = { now: this.#current, state: this.#current ? this.backend.state() : IDLE_STATE, rate: this.#rate, error: this.#error, sleepAt: this.#sleepAt };
    for (const l of this.#listeners) l();
  }

  #onBackend(): void {
    // Timers may run late in the background, so every report from the backend also checks the sleep timer.
    this.#checkSleep();
    const s = this.backend.state();
    if (this.#current && s.failed && !this.#error) {
      this.#error = this.#current.from === "device"
        ? "The download on this device couldn't be played. Remove it and download it again."
        : "The publisher's file couldn't be played here. It may have moved, or need the publisher's own app.";
    }
    // Pausing or reaching the end saves straight away; while playing, now and then.
    const stopped = this.#wasPlaying && !s.playing;
    this.#wasPlaying = s.playing;
    if (stopped) void this.flush();
    else if (s.playing) void this.#save(false, false);
    this.#emit();
  }

  /** Where positions not yet on the server are kept: this device's store for the signed-in account. Sends what it holds. */
  setPendingStore(store: LateStore<PendingPosition> | null): void {
    this.#pending = store;
    void this.sendPending();
  }

  /** Whether positions recorded here are still waiting for the server. */
  hasPending(): boolean {
    return !!this.#pending && Object.keys(this.#pending.all()).length > 0;
  }

  /** An item's position: the server's, or one recorded on this device after it and not sent yet. */
  positionFor(itemId: string, server: PlaybackPosition | null): PlaybackPosition | null {
    const local = this.#pending?.all()[itemId];
    if (!local) return server;
    if (server && Date.parse(server.updatedAt) >= Date.parse(local.recordedAt)) return server;
    return { positionSeconds: local.positionSeconds, durationSeconds: local.durationSeconds ?? server?.durationSeconds ?? null, updatedAt: local.recordedAt };
  }

  /** Send the positions recorded here that the server doesn't have yet, oldest first; stops at the first that can't be sent. */
  sendPending(): Promise<void> {
    this.#sending ??= this.#sendPending().finally(() => { this.#sending = null; });
    return this.#sending;
  }

  async #sendPending(): Promise<void> {
    const store = this.#pending;
    if (!store) return;
    const waiting = Object.entries(store.all()).sort((a, b) => a[1].recordedAt.localeCompare(b[1].recordedAt));
    for (const [itemId, p] of waiting) {
      try {
        await this.#deps.savePosition(itemId, p.positionSeconds, p.durationSeconds, { keepalive: false, recordedAt: p.recordedAt });
        store.remove(itemId, p);
      } catch (err) {
        if (this.#deps.worthRetrying?.(err) ?? true) break;
        store.remove(itemId, p);
      }
    }
    this.#emit();
  }

  /** Is this item the one loaded in the player? */
  isCurrent(itemId: string): boolean {
    return this.#current?.itemId === itemId;
  }

  /** Load an item's media and play it from where it was left (on any device). */
  async open(item: PlayableItem, opts: { autoplay?: boolean } = {}): Promise<void> {
    if (this.#current?.itemId === item.id) { if (opts.autoplay !== false) await this.backend.play(); return; }
    await this.flush();
    const token = ++this.#opening;
    const local = (await this.#deps.deviceCopy?.(item.id).catch(() => null)) ?? null;
    if (token !== this.#opening) return;
    const from: NowPlaying["from"] = local ? "device" : "publisher";
    const url = local ?? item.media.url;
    this.#error = null;
    // A publisher's file only over a secure connection: the page's policy requires it, and the apps' native player follows suit.
    if (from === "publisher" && !/^https:\/\//i.test(url)) {
      this.#error = "The publisher doesn't offer this file over a secure connection, so it can't be played here.";
      this.#emit();
      return;
    }
    this.#current = { itemId: item.id, title: item.title, sourceTitle: item.sourceTitle, imageUrl: item.imageUrl, kind: item.media.kind, from };
    const playback = this.positionFor(item.id, item.playback);
    const startAt = resumePoint(playback);
    // Counted as saved where playback starts, so opening and closing without playing doesn't move the position back.
    this.#lastSaved = playback ? { at: this.#now(), position: startAt } : null;
    this.#wasPlaying = false;
    const artwork = item.imageUrl && /^https:\/\//.test(item.imageUrl) ? item.imageUrl : null;
    this.backend.load({ url, kind: item.media.kind, type: item.media.type, title: item.title, artist: item.sourceTitle, artwork }, { startAt, rate: this.#rate, autoplay: opts.autoplay !== false });
    this.#emit();
  }

  play(): Promise<void> { return this.backend.play(); }
  pause(): void { this.backend.pause(); }
  toggle(): void { if (this.backend.state().playing) this.pause(); else void this.play(); }
  seek(seconds: number): void { this.backend.seek(seconds); }
  skip(delta: number): void { this.backend.seek(this.backend.state().position + delta); }
  back(): void { this.skip(-SKIP_BACK_SECONDS); }
  forward(): void { this.skip(SKIP_FORWARD_SECONDS); }

  setRate(rate: number): void {
    this.#rate = rate;
    this.backend.setRate(rate);
    this.#deps.rateStore?.set(rate);
    this.#emit();
  }

  /**
   * Pause in `minutes` (counted on this device's clock, playing or not), or turn the timer off with null.
   * It carries over to the next episode and ends when the player closes.
   */
  setSleepTimer(minutes: number | null): void {
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#sleepTimer = null;
    this.#sleepAt = minutes === null ? null : this.#now() + minutes * 60_000;
    if (minutes !== null) this.#sleepTimer = setTimeout(() => this.#checkSleep(), minutes * 60_000);
    this.#emit();
  }

  #checkSleep(): void {
    if (this.#sleepAt === null || this.#now() < this.#sleepAt) return;
    this.setSleepTimer(null);
    // Always, so an episode still loading doesn't start playing afterwards (the backend drops its wish to play).
    this.pause();
  }

  /** Stop, keep the position, and empty the player. */
  async close(): Promise<void> {
    if (this.#sleepAt !== null) this.setSleepTimer(null);
    await this.flush();
    this.#opening++;
    this.#current = null;
    this.#error = null;
    this.backend.unload();
    this.#emit();
  }

  /** Save the position now if it changed (on pause, close, and when the page goes away). */
  flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    return this.#save(true, opts.keepalive ?? false);
  }

  async #save(force: boolean, keepalive: boolean): Promise<void> {
    const cur = this.#current;
    if (!cur) return;
    const s = this.backend.state();
    const position = s.ended && s.duration !== null ? s.duration : s.position;
    const now = this.#now();
    if (!shouldSave(this.#lastSaved, position, now, force)) return;
    this.#lastSaved = { at: now, position };
    // Kept on the device first, so the position survives a failed request, the app closing, or the page going away.
    const kept: PendingPosition = { positionSeconds: position, durationSeconds: s.duration, recordedAt: new Date(now).toISOString() };
    this.#pending?.put(cur.itemId, kept);
    try {
      await this.#deps.savePosition(cur.itemId, position, s.duration, { keepalive });
      this.#pending?.remove(cur.itemId, kept);
      // The connection works: send anything still waiting from before.
      if (this.hasPending()) void this.sendPending();
    } catch (err) {
      if (this.#deps.worthRetrying && !this.#deps.worthRetrying(err)) this.#pending?.remove(cur.itemId, kept);
      // Offline or signed out: playback goes on; the position is sent when the connection is back, or by a later save.
      this.#lastSaved = { at: now, position: Number.NEGATIVE_INFINITY };
    }
  }
}
