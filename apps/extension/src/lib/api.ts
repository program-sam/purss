import type { BasketDTO, BrowserCaptureResult, ConnectInfo, ConnectTokenResult, ManualKeepResult, UrlLookup } from "@purss/domain";

/*
 * Talking to the PURSS. Every request goes only to the PURSS the person connected, with the
 * device token as a bearer header (plan/24); the extension sends no cookies and talks to nobody else.
 */

export type Connection = {
  origin: string;
  name: string;
  token: string;
  deviceId: string;
  deviceName: string;
  /** What this PURSS supports, from /api/connect/info when connecting. */
  browserCapture: boolean;
};

/** A failure with a message to show. `code` "device_signed_out" means the token no longer works. */
export class WorkspaceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const signedOut = (err: unknown): boolean => err instanceof WorkspaceError && err.code === "device_signed_out";

type Fetch = typeof fetch;

async function request<T>(fetchImpl: Fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, credentials: "omit", cache: "no-store" });
  } catch {
    throw new WorkspaceError(0, "offline", "Couldn't reach your PURSS. Check your connection, or that the PURSS is running.");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.status === 401) throw new WorkspaceError(401, "device_signed_out", e?.message ?? "This extension isn't connected to your PURSS any more. Connect it again.");
    if (res.status === 413) throw new WorkspaceError(413, "too_large", "This page's text is too large to keep.");
    throw new WorkspaceError(res.status, e?.code ?? "failed", e?.message ?? `The PURSS answered with an error (${res.status}).`);
  }
  return body as T;
}

/** Check that an origin is a PURSS and what it supports. Needs no sign-in. */
export async function fetchInfo(origin: string, fetchImpl: Fetch = fetch): Promise<ConnectInfo> {
  const info = await request<ConnectInfo>(fetchImpl, `${origin}/api/connect/info`, { method: "GET" }).catch((err) => {
    if (err instanceof WorkspaceError && err.status !== 0) throw new WorkspaceError(err.status, "not_workspace", "There's no PURSS at that address, or it's too old for this extension.");
    throw err;
  });
  if (info?.service !== "purss" || typeof info.origin !== "string") throw new WorkspaceError(0, "not_workspace", "There's no PURSS at that address.");
  if (info.origin !== origin) throw new WorkspaceError(0, "other_origin", `This PURSS's address is ${info.origin}. Enter that address instead.`);
  return info;
}

/** Exchange a one-time code and the PKCE verifier for the device token. */
export function exchangeCode(origin: string, p: { code: string; verifier: string; redirectUri?: string }, fetchImpl: Fetch = fetch): Promise<ConnectTokenResult> {
  return request(fetchImpl, `${origin}/api/connect/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "extension", code: p.code, codeVerifier: p.verifier, ...(p.redirectUri ? { redirectUri: p.redirectUri } : {}) }),
  });
}

/** A client for one connected PURSS. */
export function workspace(conn: Pick<Connection, "origin" | "token">, fetchImpl: Fetch = fetch) {
  const call = <T>(method: string, path: string, body?: unknown) => request<T>(fetchImpl, `${conn.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${conn.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    lookup: (url: string) => call<UrlLookup>("GET", `/api/items/lookup?${new URLSearchParams({ url })}`),
    baskets: () => call<BasketDTO[]>("GET", "/api/baskets"),
    keep: (p: { url: string; basketId: string; title?: string }) => call<ManualKeepResult>("POST", "/api/items/manual", p),
    keepWithText: (p: { url: string; basketId: string; title?: string; html: string }) => call<BrowserCaptureResult>("POST", "/api/items/browser-capture", p),
    /** Disconnect this extension (its own "sign out"). */
    disconnect: () => call<{ ok: true }>("DELETE", "/api/connect/device"),
  };
}
export type Workspace = ReturnType<typeof workspace>;
