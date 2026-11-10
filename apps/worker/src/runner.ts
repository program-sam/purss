import { jobPayloadSchemas } from "@purss/domain";
import type { FailureReason, JobKind, LeasedJob } from "@purss/domain";
import { isEngineError, redactText } from "@purss/freshrss";
import type { EngineErrorKind } from "@purss/freshrss";
import { InternalApiError, KNOWN_KINDS } from "./internal-api.ts";
import type { InternalApi } from "./internal-api.ts";
import type { Logger } from "./log.ts";

/** Thrown by handlers when they stopped early because the signal fired (lease lost or worker draining). */
export class JobAborted extends Error {
  constructor() {
    super("The job was interrupted.");
    this.name = "JobAborted";
  }
}

/** A failure a handler wants reported exactly as classified. `message` must already be safe to store. */
export class JobFailure extends Error {
  readonly retryable: boolean;
  readonly reason: FailureReason;
  constructor(message: string, retryable: boolean, reason: FailureReason = "other") {
    super(message);
    this.name = "JobFailure";
    this.retryable = retryable;
    this.reason = reason;
  }
}

export type HandlerArgs<K extends JobKind = JobKind> = {
  job: LeasedJob;
  payload: ReturnType<(typeof jobPayloadSchemas)[K]["parse"]>;
  signal: AbortSignal;
};
/** A handler returns this when its last API call already recorded the job's outcome, so no completion is sent. */
export const SETTLED: unique symbol = Symbol("settled");
export type JobHandler = (args: HandlerArgs) => Promise<Record<string, unknown> | typeof SETTLED>;
export type Handlers = Partial<Record<JobKind, JobHandler>>;

export type RunnerOptions = {
  api: InternalApi;
  handlers: Handlers;
  log: Logger;
  concurrency: number;
  pollIntervalMs: number;
  maxBackoffMs: number;
  drainTimeoutMs: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Kinds this process will lease. Defaults to the kinds that have a handler. */
  kinds?: readonly JobKind[];
};

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Exponential backoff with full jitter, for the lease loop. */
export class Backoff {
  #failures = 0;
  readonly #base: number;
  readonly #max: number;
  readonly #random: () => number;
  constructor(base: number, max: number, random: () => number = Math.random) {
    this.#base = base;
    this.#max = max;
    this.#random = random;
  }
  next(): number {
    this.#failures += 1;
    const ceiling = Math.min(this.#max, this.#base * 2 ** (this.#failures - 1));
    return Math.max(this.#base, Math.floor(this.#random() * ceiling));
  }
  reset(): void {
    this.#failures = 0;
  }
  get failures(): number {
    return this.#failures;
  }
}

/** Serialises work per key (one engine user must never be synced by two jobs at once). */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.#tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

type Running = { job: LeasedJob; abort: (reason: "lease_lost" | "shutdown") => void; done: Promise<void> };

export class Worker {
  readonly #o: RunnerOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #kinds: readonly JobKind[];
  readonly #running = new Map<string, Running>();
  readonly #stopping = new AbortController();
  #slotWaiter: (() => void) | null = null;
  #loop: Promise<void> | null = null;
  #hardStopped = false;

  constructor(opts: RunnerOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? abortableSleep;
    this.#random = opts.random ?? Math.random;
    this.#kinds = opts.kinds ?? (Object.keys(opts.handlers) as JobKind[]);
  }

  get inFlight(): number {
    return this.#running.size;
  }

  /** Runs the lease loop until `drain()` is called. */
  run(): Promise<void> {
    this.#loop = this.#leaseLoop();
    return this.#loop;
  }

  async #leaseLoop(): Promise<void> {
    const backoff = new Backoff(this.#o.pollIntervalMs, this.#o.maxBackoffMs, this.#random);
    const stop = this.#stopping.signal;
    this.#o.log("info", "worker started", { concurrency: this.#o.concurrency, kinds: this.#kinds.join(",") });
    while (!stop.aborted) {
      const free = this.#o.concurrency - this.#running.size;
      if (free <= 0) {
        await new Promise<void>((resolve) => {
          this.#slotWaiter = resolve;
          stop.addEventListener("abort", () => resolve(), { once: true });
        });
        this.#slotWaiter = null;
        continue;
      }
      let jobs: LeasedJob[];
      try {
        // Not cancelled on shutdown: a lease that succeeded server-side must be picked up (and drained), not orphaned.
        jobs = await this.#o.api.lease(this.#kinds, free);
        backoff.reset();
      } catch (e) {
        if (stop.aborted) break;
        const delay = backoff.next();
        this.#o.log("warn", "could not lease jobs; backing off", { error: describe(e), retryInMs: delay, consecutiveFailures: backoff.failures });
        await this.#sleep(delay, stop);
        continue;
      }
      for (const job of jobs) this.#start(job);
      if (jobs.length < free && !stop.aborted) await this.#sleep(this.#o.pollIntervalMs, stop);
    }
    this.#o.log("info", "worker stopped leasing", { inFlight: this.#running.size });
  }

  /**
   * Stop leasing, let running jobs finish for up to `drainTimeoutMs`, then interrupt what is left. Interrupted jobs are
   * reported back as retryable so the API can hand them out again right away instead of waiting for the lease to expire.
   */
  async drain(): Promise<void> {
    this.#stopping.abort();
    this.#slotWaiter?.();
    const finished = async () => {
      await this.#loop;
      await Promise.all([...this.#running.values()].map((r) => r.done));
    };
    const budget = new AbortController();
    const timedOut = await Promise.race([
      finished().then(() => {
        budget.abort();
        return false;
      }),
      this.#sleep(this.#o.drainTimeoutMs, budget.signal).then(() => !budget.signal.aborted),
    ]);
    if (timedOut) {
      this.#hardStopped = true;
      this.#o.log("warn", "drain timeout; interrupting running jobs", { jobs: this.#running.size });
      for (const r of this.#running.values()) r.abort("shutdown");
      await finished();
    }
  }

  #start(job: LeasedJob): void {
    const controller = new AbortController();
    let abortReason: "lease_lost" | "shutdown" | null = null;
    const abort = (reason: "lease_lost" | "shutdown") => {
      if (abortReason === null) {
        abortReason = reason;
        controller.abort();
      }
    };
    const done = this.#execute(job, controller, () => abortReason, abort).finally(() => {
      this.#running.delete(job.id);
      this.#slotWaiter?.();
    });
    this.#running.set(job.id, { job, abort, done });
    if (this.#hardStopped) abort("shutdown");
  }

  async #execute(
    job: LeasedJob,
    controller: AbortController,
    reason: () => "lease_lost" | "shutdown" | null,
    abort: (r: "lease_lost" | "shutdown") => void,
  ): Promise<void> {
    const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, string | number | boolean | null> = {}) =>
      this.#o.log(level, msg, { jobId: job.id, kind: job.kind, attempt: job.attempts, ...extra });
    const heartbeat = this.#startHeartbeat(job, abort, log);
    const startedAt = this.#now();
    try {
      const handler = KNOWN_KINDS.has(job.kind) ? this.#o.handlers[job.kind] : undefined;
      if (!handler) throw new JobFailure(`This worker cannot run jobs of kind "${String(job.kind).slice(0, 60)}".`, false);
      const schema = jobPayloadSchemas[job.kind];
      const parsed = schema.safeParse(job.payload);
      if (!parsed.success) throw new JobFailure("The job payload did not match its contract.", false);
      log("info", "job started");
      const result = await handler({ job, payload: parsed.data as never, signal: controller.signal });
      if (reason() === "lease_lost") return void log("warn", "lease lost while running; result discarded");
      if (result === SETTLED) return void log("info", "job settled by the API", { ms: this.#now() - startedAt });
      if (reason() === "shutdown") throw new JobAborted();
      await this.#o.api.complete(job.id, job.leaseId, result);
      log("info", "job completed", { ms: this.#now() - startedAt });
    } catch (e) {
      await this.#reportFailure(job, e, reason(), log);
    } finally {
      heartbeat.stop();
    }
  }

  async #reportFailure(
    job: LeasedJob,
    e: unknown,
    reason: "lease_lost" | "shutdown" | null,
    log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, string | number | boolean | null>) => void,
  ): Promise<void> {
    if (reason === "lease_lost" || (e instanceof InternalApiError && e.kind === "lease_lost")) {
      return log("warn", "lease lost; not reporting an outcome");
    }
    const outcome: Classified = reason === "shutdown" || e instanceof JobAborted
      ? { error: "The worker stopped before this job finished; it will run again.", retryable: true, reason: "other" }
      : classify(e);
    log(outcome.retryable ? "warn" : "error", "job failed", { error: outcome.error, retryable: outcome.retryable });
    try {
      await this.#o.api.fail(job.id, job.leaseId, outcome.error, outcome.retryable, outcome.reason);
    } catch (reportError) {
      // The lease will expire and the API will re-queue the job; nothing else is safe to do.
      log("warn", "could not report job failure", { error: describe(reportError) });
    }
  }

  #startHeartbeat(
    job: LeasedJob,
    abort: (r: "lease_lost" | "shutdown") => void,
    log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, string | number | boolean | null>) => void,
  ): { stop(): void } {
    const ttl = Math.max(1000, Date.parse(job.leaseExpiresAt) - this.#now());
    const interval = Math.min(30_000, Math.max(250, Math.floor((Number.isFinite(ttl) ? ttl : 60_000) / 3)));
    let expiresAt = Number.isFinite(ttl) ? this.#now() + ttl : this.#now() + 60_000;
    let stopped = false;
    const ac = new AbortController();
    const loop = async () => {
      while (!stopped) {
        await this.#sleep(interval, ac.signal);
        if (stopped) return;
        try {
          const r = await this.#o.api.heartbeat(job.id, job.leaseId, ac.signal);
          const next = r.leaseExpiresAt ? Date.parse(r.leaseExpiresAt) : NaN;
          expiresAt = Number.isFinite(next) ? next : this.#now() + ttl;
        } catch (e) {
          if (stopped) return;
          if (e instanceof InternalApiError && e.kind === "lease_lost") {
            log("warn", "heartbeat says the lease is gone");
            return abort("lease_lost");
          }
          // Transient trouble: keep trying until the lease would have expired on the server anyway.
          if (this.#now() >= expiresAt) {
            log("warn", "could not renew the lease before it expired");
            return abort("lease_lost");
          }
          log("warn", "heartbeat failed; will retry", { error: describe(e) });
        }
      }
    };
    void loop();
    return {
      stop() {
        stopped = true;
        ac.abort();
      },
    };
  }
}

export type Classified = { error: string; retryable: boolean; reason: FailureReason };

const ENGINE_REASONS: Partial<Record<EngineErrorKind, FailureReason>> = {
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  api_disabled: "unavailable",
  network: "unavailable",
  timeout: "unavailable",
  exec: "unavailable",
};

/** Maps any error to a stored, redacted message, a retry decision, and a reason the product can word for a person. */
export function classify(e: unknown): Classified {
  if (e instanceof JobFailure) return { error: redactText(e.message), retryable: e.retryable, reason: e.reason };
  if (isEngineError(e)) return { error: redactText(e.message), retryable: e.retryable, reason: e.reason ?? ENGINE_REASONS[e.kind] ?? "other" };
  if (e instanceof InternalApiError) {
    if (e.status === 413) return { error: "The product API refused a request as too large; this will not succeed on retry.", retryable: false, reason: "too_large" };
    if (e.kind === "bad_request") return { error: "The product API rejected what the worker sent; this will not succeed on retry.", retryable: false, reason: "other" };
    if (e.kind === "not_found") return { error: "The product API does not know the record this job refers to.", retryable: false, reason: "other" };
    if (e.kind === "auth") return { error: "The product API rejected the worker's service token.", retryable: true, reason: "other" };
    return { error: redactText(e.message), retryable: e.retryable, reason: "other" };
  }
  return { error: "The worker hit an unexpected error; details are in the worker log.", retryable: true, reason: "other" };
}

export function describe(e: unknown): string {
  if (e instanceof Error) return redactText(`${e.name}: ${e.message}`);
  return "unknown error";
}
