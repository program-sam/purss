import type { ApiError as ApiErrorBody } from "@purss/domain";
import { noteAnswer } from "../offline/status.ts";
import { platform } from "../platform/index.ts";
import { OFFLINE_HEADER } from "../sw/protocol.ts";

/** An error from the product API, carrying the plain-language message to show the user. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

let csrfToken: string | null = null;
/** Called when the server says the session ended or the page's CSRF token is stale. */
let onSessionLost: (() => void) | null = null;
let refreshCsrf: (() => Promise<string | null>) | null = null;

export function setCsrf(token: string | null): void { csrfToken = token; }
export function configureClient(opts: { onSessionLost: () => void; refreshCsrf: () => Promise<string | null> }): void {
  onSessionLost = opts.onSessionLost;
  refreshCsrf = opts.refreshCsrf;
}

/** Asked before the person signs out: "stay" stops the sign-out (changes that were not sent are being dealt with first). */
let beforeSignOut: (() => Promise<"go" | "stay">) | null = null;
export function setSignOutGate(gate: (() => Promise<"go" | "stay">) | null): void { beforeSignOut = gate; }

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Let the request finish after the page is closed (small bodies only, e.g. a playback position). */
  keepalive?: boolean;
  /** Only PURSS's own answer will do: a copy saved on this device counts as no answer. */
  live?: boolean;
};

function url(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try { body = (await res.json()) as Partial<ApiErrorBody>; } catch { /* not JSON */ }
  const e = body?.error;
  const retryHeader = res.headers.get("retry-after");
  const retryAfterSeconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
  if (e?.message) return new ApiError(res.status, e.code ?? "error", e.message, retryAfterSeconds);
  return new ApiError(res.status, "error", res.status >= 500 ? "Something went wrong on our side. Nothing was changed; please try again." : "That didn't work. Please try again.");
}

/** Typed JSON request. Mutations carry the CSRF header; a stale token is refreshed and retried once. */
export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const method = opts.method ?? "GET";
  if (method === "POST" && path === "/api/auth/logout" && !retried && beforeSignOut && (await beforeSignOut()) === "stay") {
    throw new ApiError(0, "stay_signed_in", "You are still signed in: some changes haven't been sent yet.");
  }
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-purss-csrf"] = csrfToken;
  let res: Response;
  try {
    res = await platform.transport.fetch(url(path, opts.query), {
      method, headers, signal: opts.signal, keepalive: opts.keepalive,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "Can't reach PURSS right now. Check your connection and try again.");
  }
  noteAnswer(res.headers);
  if (opts.live && res.headers.get(OFFLINE_HEADER) !== null) throw new ApiError(0, "offline", "Can't reach PURSS right now. Check your connection and try again.");
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const err = await parseError(res);
  if (err.code === "csrf" && !retried && refreshCsrf) {
    const fresh = await refreshCsrf();
    if (fresh) { csrfToken = fresh; return api<T>(path, opts, true); }
  }
  // A browser session that ended, or (in the apps) a device that was disconnected.
  if (err.code === "signed_out" || err.code === "device_signed_out" || (err.status === 401 && err.code === "unauthorized")) onSessionLost?.();
  throw err;
}

export const get = <T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal) => api<T>(path, { query, signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body ?? {} });
export const del = <T>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", body });

/** Message for any thrown value, never a stack or technical detail. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}
