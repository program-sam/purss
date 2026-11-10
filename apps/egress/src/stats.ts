/** Rolling counters of proxy decisions over the last hour, in one-minute buckets. */

const BUCKET_MS = 60_000;
const BUCKETS = 60;

export class RollingCounter {
  #counts = new Map<number, number>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(n = 1): void {
    const bucket = Math.floor(this.#now() / BUCKET_MS);
    this.#counts.set(bucket, (this.#counts.get(bucket) ?? 0) + n);
    this.#prune(bucket);
  }

  /** Total over the last hour. */
  lastHour(): number {
    const current = Math.floor(this.#now() / BUCKET_MS);
    this.#prune(current);
    let total = 0;
    for (const [bucket, n] of this.#counts) if (bucket > current - BUCKETS) total += n;
    return total;
  }

  #prune(current: number): void {
    for (const bucket of this.#counts.keys()) if (bucket <= current - BUCKETS) this.#counts.delete(bucket);
  }
}

export class EgressStats {
  allowed: RollingCounter;
  blocked: RollingCounter;

  constructor(now: () => number = Date.now) {
    this.allowed = new RollingCounter(now);
    this.blocked = new RollingCounter(now);
  }

  snapshot(): { blockedLastHour: number; allowedLastHour: number } {
    return { blockedLastHour: this.blocked.lastHour(), allowedLastHour: this.allowed.lastHour() };
  }
}
