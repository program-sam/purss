import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

/** A plain-language error that is safe to show to the user. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields sent alongside code and message (see ApiError in @purss/domain). */
  readonly details: Record<string, string> | undefined;
  /** When a refused request may succeed (ms since epoch), sent as Retry-After. */
  readonly retryAt: number | null;
  constructor(status: number, code: string, message: string, details?: Record<string, string>, retryAt: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAt = retryAt;
  }
}

export const notFound = (what = "That") => new HttpError(404, "not_found", `${what} doesn't exist or isn't yours.`);
export const badRequest = (message: string, code = "invalid") => new HttpError(400, code, message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

export type Req = {
  raw: IncomingMessage;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  cookies: Record<string, string>;
  body: unknown;
};

export type Handler<C> = (req: Req, ctx: C, res: ServerResponse) => Promise<unknown> | unknown;

export type RouteOptions = { bodyLimit?: number };
type Route<C> = { method: string; pattern: string; parts: string[]; handler: Handler<C>; options: RouteOptions };
export type RouteMatch<C> = { handler: Handler<C>; params: Record<string, string>; options: RouteOptions; pattern: string };

/**
 * The segments of a path in its one canonical spelling, or null when it has another: no empty segment
 * (`//`, a trailing `/`) and no encoded slash. Dot segments are already resolved by URL parsing. A
 * route answers only its canonical path, so anything that decides by path (the device-token gate) and
 * the router can never disagree about which route a request reaches.
 */
export function canonicalSegments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  return parts.every((p) => p !== "" && !/%2f|%5c/i.test(p)) ? parts : null;
}

export class Router<C> {
  #routes: Route<C>[] = [];

  on(method: string, pattern: string, handler: Handler<C>, options: RouteOptions = {}): this {
    const parts = canonicalSegments(pattern);
    if (!parts) throw new Error(`Route pattern not in canonical form: ${pattern}`);
    this.#routes.push({ method, pattern, parts, handler, options });
    return this;
  }
  get(p: string, h: Handler<C>, o?: RouteOptions) { return this.on("GET", p, h, o); }
  post(p: string, h: Handler<C>, o?: RouteOptions) { return this.on("POST", p, h, o); }
  put(p: string, h: Handler<C>, o?: RouteOptions) { return this.on("PUT", p, h, o); }
  patch(p: string, h: Handler<C>, o?: RouteOptions) { return this.on("PATCH", p, h, o); }
  delete(p: string, h: Handler<C>, o?: RouteOptions) { return this.on("DELETE", p, h, o); }

  /** The route for a request, matched on the canonical path only (see canonicalSegments); `pattern` is the route as registered. */
  match(method: string, path: string): RouteMatch<C> | "method" | null {
    const parts = canonicalSegments(path);
    if (!parts) return null;
    let methodMismatch = false;
    for (const r of this.#routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i]!;
        const v = parts[i]!;
        if (p.startsWith(":")) {
          try { params[p.slice(1)] = decodeURIComponent(v); } catch { ok = false; break; }
        } else if (p !== v) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method) { methodMismatch = true; continue; }
      return { handler: r.handler, params, options: r.options, pattern: r.pattern };
    }
    return methodMismatch ? "method" : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "That request is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (type.startsWith("application/json")) {
    try { return JSON.parse(text); } catch { throw badRequest("The request body isn't valid JSON."); }
  }
  return text;
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join(".")})` : "";
    throw badRequest(`Some details aren't valid${where}.`);
  }
  return r.data;
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function setCookie(res: ServerResponse, name: string, value: string, opts: { maxAge?: number; secure: boolean; httpOnly?: boolean; path?: string }): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, "SameSite=Lax"];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = res.getHeader("set-cookie");
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader("set-cookie", [...list, parts.join("; ")]);
}

const limiter = new Map<string, { n: number; reset: number }>();
/** In-memory fixed-window limiter (per process), e.g. per address for sign-in or per account for discovery. */
export function consumeRateLimit(key: string, max = 20, windowMs = 10 * 60_000): { allowed: boolean; resetAt: number; remaining: number } {
  const now = Date.now();
  if (limiter.size > 10_000) for (const [k, v] of limiter) if (v.reset < now) limiter.delete(k);
  const e = limiter.get(key);
  if (!e || e.reset <= now) {
    const resetAt = now + windowMs;
    limiter.set(key, { n: 1, reset: resetAt });
    return { allowed: true, resetAt, remaining: max - 1 };
  }
  e.n++;
  return { allowed: e.n <= max, resetAt: e.reset, remaining: max - e.n };
}

export function rateLimit(key: string, max = 20, windowMs = 10 * 60_000): void {
  const state = consumeRateLimit(key, max, windowMs);
  if (!state.allowed) throw new HttpError(429, "slow_down", "Too many attempts. Please wait a few minutes and try again.", undefined, state.resetAt);
}

export const nowIso = () => new Date().toISOString();
export const addSeconds = (s: number, from = Date.now()) => new Date(from + s * 1000).toISOString();

const PRIVATE_PEER = /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)|^::1$|^f[cd]/i;

/**
 * The visitor's address for rate limits. Only when the app is configured to sit behind a reverse
 * proxy, and the connection comes from a private address, is a forwarded address used at all; a
 * direct visitor can't spoof it. Then only the right-most X-Forwarded-For hop counts: the trusted proxy
 * appends the address it saw (nginx's `$proxy_add_x_forwarded_for`, which Nginx Proxy Manager sets),
 * so that hop is the proxy's own observation, while any hop to its left, and X-Real-IP, are whatever
 * the client sent when the proxy passes them on unchanged instead of overwriting them.
 */
export function clientAddress(raw: import("node:http").IncomingMessage, trustProxy: boolean): string {
  const peer = raw.socket.remoteAddress ?? "unknown";
  if (!trustProxy || !PRIVATE_PEER.test(peer)) return peer;
  const fwd = raw.headers["x-forwarded-for"];
  const hops = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) ?? peer;
}
