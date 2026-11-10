import { JOB_KINDS } from "@purss/domain";
import type { FailureReason, JobKind, LeasedJob, SyncBatch, AiJudgeInput } from "@purss/domain";

export type InternalApiErrorKind =
  | "lease_lost" // the job's lease is no longer ours (expired, re-leased, cancelled): stop working on it
  | "auth" // service token rejected
  | "not_found"
  | "bad_request"
  | "transient" // network, 429, 5xx
  | "protocol";

export class InternalApiError extends Error {
  readonly kind: InternalApiErrorKind;
  readonly status: number | null;
  constructor(kind: InternalApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "InternalApiError";
    this.kind = kind;
    this.status = status;
  }
  get retryable(): boolean {
    return this.kind === "transient";
  }
}

export type TokenProvider = { get(): string; invalidate(): void };

export type InternalApiOptions = {
  baseUrl: string;
  token: TokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Delays between retries of an idempotent call on a transient error. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type Checkpoint = { continuation: string | null; newestCrawlUsec: string | null; engineIdentity: string | null };
export type EngineUserRecord = { id: string; username: string; baseUrl: string };
/** The engine side of an account deletion (see apps/api/src/services/deletion.ts). */
export type EngineDeletionState = { engineAttemptedAt: string | null; engineRemovedAt: string | null; engineReviewAt: string | null };
export type DeletionLease = { jobId: string; leaseId: string };

const DEFAULT_RETRY_DELAYS = [250, 1000, 3000] as const;

export class InternalApi {
  readonly #base: string;
  readonly #token: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #retry: readonly number[];
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: InternalApiOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeout = opts.timeoutMs ?? 30_000;
    this.#retry = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    this.#sleep = opts.sleep ?? ((ms, signal) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    }));
  }

  async lease(kinds: readonly JobKind[], max: number, signal?: AbortSignal): Promise<LeasedJob[]> {
    const json = await this.#call("POST", "/internal/jobs/lease", { kinds, max }, { signal });
    const jobs = (json as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) throw new InternalApiError("protocol", "The API's lease response had no job list.");
    return jobs.map(toLeasedJob);
  }

  async heartbeat(jobId: string, leaseId: string, signal?: AbortSignal): Promise<{ leaseExpiresAt: string | null }> {
    const json = await this.#idempotent("POST", `/internal/jobs/${enc(jobId)}/heartbeat`, { leaseId }, signal);
    const at = (json as { leaseExpiresAt?: unknown } | null)?.leaseExpiresAt;
    return { leaseExpiresAt: typeof at === "string" ? at : null };
  }

  async complete(jobId: string, leaseId: string, result: Record<string, unknown>): Promise<void> {
    await this.#idempotent("POST", `/internal/jobs/${enc(jobId)}/complete`, { leaseId, result });
  }

  async fail(jobId: string, leaseId: string, error: string, retryable: boolean, reason?: FailureReason): Promise<void> {
    await this.#idempotent("POST", `/internal/jobs/${enc(jobId)}/fail`, { leaseId, error, retryable, ...(reason ? { reason } : {}) });
  }

  async submitBatch(engineUserId: string, batch: SyncBatch, signal?: AbortSignal): Promise<{ accepted: number; duplicates: number }> {
    const json = await this.#idempotent("POST", `/internal/sync/${enc(engineUserId)}/batch`, batch, signal);
    const o = json as { accepted?: unknown; duplicates?: unknown } | null;
    if (!o || typeof o.accepted !== "number" || typeof o.duplicates !== "number") throw new InternalApiError("protocol", "The API's batch response had an unexpected shape.");
    return { accepted: o.accepted, duplicates: o.duplicates };
  }

  async checkpoint(engineUserId: string, signal?: AbortSignal): Promise<Checkpoint> {
    const o = (await this.#idempotent("GET", `/internal/sync/${enc(engineUserId)}/checkpoint`, undefined, signal)) as Record<string, unknown> | null;
    if (!o) throw new InternalApiError("protocol", "The API's checkpoint response was empty.");
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    return { continuation: s(o.continuation), newestCrawlUsec: s(o.newestCrawlUsec), engineIdentity: s(o.engineIdentity) };
  }

  async engineUser(id: string, signal?: AbortSignal): Promise<EngineUserRecord> {
    const o = (await this.#idempotent("GET", `/internal/engine-users/${enc(id)}`, undefined, signal)) as Record<string, unknown> | null;
    if (!o || typeof o.id !== "string" || typeof o.username !== "string" || typeof o.baseUrl !== "string") {
      throw new InternalApiError("protocol", "The API's engine user response had an unexpected shape.");
    }
    return { id: o.id, username: o.username, baseUrl: o.baseUrl };
  }

  /** Where an account deletion stands on the engine side. Only the engine.delete_user job's lease may ask. */
  async deletionState(engineUserId: string, lease: DeletionLease, signal?: AbortSignal): Promise<EngineDeletionState> {
    return toDeletionState(await this.#idempotent("POST", `/internal/deletions/${enc(engineUserId)}`, lease, signal));
  }

  /** Recorded before the first delete-user call, so a later run knows an attempt happened. */
  async deletionAttempt(engineUserId: string, lease: DeletionLease, signal?: AbortSignal): Promise<EngineDeletionState> {
    return toDeletionState(await this.#idempotent("POST", `/internal/deletions/${enc(engineUserId)}/attempt`, lease, signal));
  }

  async deletionEngineRemoved(engineUserId: string, lease: DeletionLease, signal?: AbortSignal): Promise<EngineDeletionState> {
    return toDeletionState(await this.#idempotent("POST", `/internal/deletions/${enc(engineUserId)}/removed`, lease, signal));
  }

  /** Ends the job until an administrator confirms the engine user's data was removed. */
  async deletionReview(engineUserId: string, lease: DeletionLease, signal?: AbortSignal): Promise<EngineDeletionState> {
    return toDeletionState(await this.#idempotent("POST", `/internal/deletions/${enc(engineUserId)}/review`, lease, signal));
  }

  /** Finishes the deletion (and the job). Repeating it after the account is gone succeeds without doing anything. */
  async finalizeDeletion(engineUserId: string, lease: DeletionLease, signal?: AbortSignal): Promise<{ finalized: boolean }> {
    const o = (await this.#idempotent("POST", `/internal/deletions/${enc(engineUserId)}/finalize`, lease, signal)) as { finalized?: unknown } | null;
    if (!o || typeof o.finalized !== "boolean") throw new InternalApiError("protocol", "The API's finalize response had an unexpected shape.");
    return { finalized: o.finalized };
  }

  /** What a filter.judge job asks Jev (plan/36). Only the job's current lease may ask. */
  async filterInput(jobId: string, leaseId: string, signal?: AbortSignal): Promise<AiJudgeInput> {
    const o = (await this.#idempotent("POST", `/internal/filters/${enc(jobId)}/input`, { leaseId }, signal)) as Partial<AiJudgeInput> | null;
    if (!o || typeof o.model !== "string" || !Array.isArray(o.requests) || !(o.route === null || o.route === "server")) {
      throw new InternalApiError("protocol", "The API's filter input response had an unexpected shape.");
    }
    return { route: o.route, model: o.model, requests: o.requests };
  }

  /** Retries transient failures; used only where repeating the request is safe. */
  async #idempotent(method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#call(method, path, body, { signal });
      } catch (e) {
        const delay = this.#retry[attempt];
        if (!(e instanceof InternalApiError) || !e.retryable || delay === undefined || signal?.aborted) throw e;
        await this.#sleep(delay, signal);
        if (signal?.aborted) throw e;
      }
    }
  }

  async #call(method: "GET" | "POST", path: string, body: unknown, opts: { signal?: AbortSignal } = {}, retriedAuth = false): Promise<unknown> {
    const signals = [AbortSignal.timeout(this.#timeout)];
    if (opts.signal) signals.push(opts.signal);
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token.get()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.#fetch(this.#base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch {
      throw new InternalApiError("transient", "The product API could not be reached.");
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      this.#token.invalidate();
      if (!retriedAuth && res.status === 401) return this.#call(method, path, body, opts, true);
      throw new InternalApiError("auth", "The product API rejected the worker's service token.", res.status);
    }
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      // For job-bound calls these mean the lease is gone; callers that address other resources treat 404 as not found.
      const jobBound = path.startsWith("/internal/jobs/") || path.startsWith("/internal/deletions/") || path.includes("/batch");
      throw new InternalApiError(jobBound ? "lease_lost" : "not_found", `The product API answered ${res.status}.`, res.status);
    }
    if (res.status === 400 || res.status === 422) throw new InternalApiError("bad_request", `The product API rejected the request (${res.status}).`, res.status);
    if (res.status === 429 || res.status >= 500) throw new InternalApiError("transient", `The product API is unavailable (${res.status}).`, res.status);
    if (!res.ok) throw new InternalApiError("protocol", `The product API answered with an unexpected status (${res.status}).`, res.status);
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new InternalApiError("protocol", "The product API returned a response that is not valid JSON.");
    }
  }
}

const enc = encodeURIComponent;

function toDeletionState(raw: unknown): EngineDeletionState {
  const o = raw as Record<string, unknown> | null;
  const at = (v: unknown) => (typeof v === "string" ? v : null);
  if (!o || typeof o !== "object") throw new InternalApiError("protocol", "The API's deletion response had an unexpected shape.");
  return { engineAttemptedAt: at(o.engineAttemptedAt), engineRemovedAt: at(o.engineRemovedAt), engineReviewAt: at(o.engineReviewAt) };
}

function toLeasedJob(raw: unknown): LeasedJob {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.leaseId !== "string" || typeof o.leaseExpiresAt !== "string" || typeof o.attempts !== "number") {
    throw new InternalApiError("protocol", "A leased job had an unexpected shape.");
  }
  // Unknown kinds are surfaced to the runner, which fails them as non-retryable instead of dropping the lease.
  return { id: o.id, kind: o.kind as JobKind, payload: o.payload, leaseId: o.leaseId, leaseExpiresAt: o.leaseExpiresAt, attempts: o.attempts };
}

export const KNOWN_KINDS: ReadonlySet<string> = new Set(JOB_KINDS);
