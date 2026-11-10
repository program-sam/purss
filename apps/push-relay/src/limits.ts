import type { Clock } from "./store.ts";

/** Keys a bucket keeps at most; past it, fully refilled keys go first, then the longest unused. */
export const MAX_KEYS = 50_000;

/** In-memory token buckets keyed by string. Nothing is persisted; a restart refills everything. */
export class Buckets {
  #entries = new Map<string, { tokens: number; at: number }>();
  #nextPrune = 0;
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #clock: Clock;
  readonly #maxKeys: number;

  /** `capacity` requests at once, refilled at `refillPerSecond`; at most `maxKeys` keys in memory. */
  constructor(capacity: number, refillPerSecond: number, clock: Clock, maxKeys = MAX_KEYS) {
    this.#capacity = capacity;
    this.#perMs = refillPerSecond / 1000;
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  /** Takes one token. Returns 0 when allowed, otherwise the whole seconds to wait. */
  take(key: string): number {
    const now = this.#clock();
    this.#prune(now);
    const entry = this.#entries.get(key) ?? { tokens: this.#capacity, at: now };
    entry.tokens = Math.min(this.#capacity, entry.tokens + Math.max(0, now - entry.at) * this.#perMs);
    entry.at = now;
    // Re-inserted so the map's order is least recently used first.
    this.#entries.delete(key);
    this.#evict(now, this.#maxKeys - 1);
    this.#entries.set(key, entry);
    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - entry.tokens) / this.#perMs / 1000));
  }

  /** How many keys are held now. */
  get size(): number { return this.#entries.size; }

  /** Forgets keys that have refilled completely; they behave like new keys anyway. */
  #prune(now: number, force = false): void {
    if (!force && (this.#entries.size < 1000 || now < this.#nextPrune)) return;
    this.#nextPrune = now + 60_000;
    for (const [key, entry] of this.#entries) {
      if (entry.tokens + (now - entry.at) * this.#perMs >= this.#capacity) this.#entries.delete(key);
    }
  }

  /**
   * Over the cap (many addresses at once): refilled keys first, then the least recently used. An evicted key
   * starts full again, so a flood of fresh addresses can only make limits more generous for the oldest keys;
   * the global budgets bound what that is worth.
   */
  #evict(now: number, room: number): void {
    if (this.#entries.size <= room) return;
    this.#prune(now, true);
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= room) break;
      this.#entries.delete(key);
    }
  }
}
