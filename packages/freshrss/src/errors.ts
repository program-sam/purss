import type { FailureReason } from "@purss/domain";

/**
 * Errors raised by the FreshRSS boundary. `message` is always safe to show to an operator and to
 * store in a job record: it never contains credentials, URLs with credentials, or article content.
 */
export type EngineErrorKind =
  | "auth" // credentials rejected (401)
  | "api_disabled" // engine reachable but its API is switched off (503)
  | "bad_request" // engine refused the request as invalid (400)
  | "rate_limited" // 429
  | "unavailable" // 5xx or engine not ready
  | "network" // connection refused/reset/DNS
  | "timeout"
  | "protocol" // response did not have the documented shape
  | "rejected" // engine accepted the call but declined the operation (e.g. feed could not be read)
  | "cancelled" // caller aborted
  | "exec"; // fixed administrative command failed

const RETRYABLE: ReadonlySet<EngineErrorKind> = new Set(["rate_limited", "unavailable", "network", "timeout", "exec"]);

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  /** Why the engine could not follow a feed, when it said (quick-add only); the product words it for the person. */
  readonly reason: FailureReason | null;

  constructor(kind: EngineErrorKind, message: string, opts: { status?: number | null; retryable?: boolean; cause?: unknown; reason?: FailureReason } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "EngineError";
    this.kind = kind;
    this.retryable = opts.retryable ?? RETRYABLE.has(kind);
    this.status = opts.status ?? null;
    this.reason = opts.reason ?? null;
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}
