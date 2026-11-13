import { createWriteStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
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

/**
 * `bodyLimit` above the default is accepted only from a signed-in caller, refused before anything is read.
 * `ownBody` leaves the body unread for the handler, which takes it itself (saveUpload, to disk).
 */
export type RouteOptions = { bodyLimit?: number; ownBody?: boolean };
export const DEFAULT_BODY_LIMIT = 1_000_000;
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

/**
 * A body must keep coming: no pause longer than `stallMs`, and at least `minRate` bytes a second after `rateAfterMs`;
 * and be done within `maxMs` (a body sent fast and then trickled would keep its average up, and its memory held, for minutes).
 */
export type UploadPace = { stallMs: number; minRate: number; rateAfterMs: number; maxMs?: number };
export const UPLOAD_PACE: UploadPace = { stallMs: 20_000, minRate: 32 * 1024, rateAfterMs: 30_000, maxMs: 120_000 };
/** Someone not signed in sends small forms that arrive at once: one still arriving after seconds is holding memory on purpose. */
export const SIGNED_OUT_PACE: UploadPace = { stallMs: 5_000, minRate: 32 * 1024, rateAfterMs: 30_000, maxMs: 10_000 };

/**
 * The body's chunks, refusing more than `limit` bytes (by the announced length before reading anything). Every body
 * must keep coming (UPLOAD_PACE): one that stalls or trickles would hold its connection and its memory indefinitely.
 */
async function* bodyChunks(req: IncomingMessage, limit: number, pace: UploadPace): AsyncGenerator<Buffer> {
  const tooLarge = () => new HttpError(413, "too_large", "That request is too large.");
  if (Number(req.headers["content-length"]) > limit) throw tooLarge();
  const started = Date.now();
  const tooSlow = () => new HttpError(408, "upload_stalled", "The upload stopped or was too slow. Please try again.");
  // Read by events rather than an async iterator: when the sender stalls, waiting stops without destroying the
  // connection, so the caller can still answer 408 (the server closes it after the answer, its body being unread).
  const queue: Buffer[] = [];
  let ended = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer) => { queue.push(chunk); req.pause(); wake?.(); };
  const onEnd = () => { ended = true; wake?.(); };
  const onError = (err: unknown) => { failure ??= err; wake?.(); };
  const onClose = () => { if (!ended && !req.complete) failure ??= Object.assign(new Error("aborted"), { code: "ECONNRESET" }); wake?.(); };
  req.on("data", onData);
  req.on("end", onEnd);
  req.on("error", onError);
  req.on("close", onClose);
  let size = 0;
  try {
    for (;;) {
      const chunk = queue.shift();
      if (chunk) {
        size += chunk.length;
        if (size > limit) throw tooLarge();
        const elapsed = Date.now() - started;
        if ((elapsed > pace.rateAfterMs && size / (elapsed / 1000) < pace.minRate) || (pace.maxMs !== undefined && elapsed > pace.maxMs)) throw tooSlow();
        yield chunk;
        if (!queue.length) req.resume();
        continue;
      }
      if (failure) throw failure;
      if (ended) return;
      const wait = pace.maxMs === undefined ? pace.stallMs : Math.min(pace.stallMs, Math.max(0, started + pace.maxMs - Date.now()));
      const stalled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(true); }, wait);
        wake = () => { clearTimeout(timer); wake = null; resolve(false); };
      });
      if (stalled) throw tooSlow();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // The sender went away mid-upload: routine, not a server fault to log.
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET") throw new HttpError(400, "upload_aborted", "The upload was cut off.");
    throw err;
  } finally {
    req.off("data", onData);
    req.off("end", onEnd);
    req.off("error", onError);
    req.off("close", onClose);
  }
}

/**
 * Public request bodies being read into memory right now, all together and per sender. Each is small, but many at
 * once add up (hundreds of slow 1 MB bodies would exhaust the API); past either limit, more are turned away until some
 * finish. Bodies must keep coming (bodyChunks), so none holds its share for long. A signed-in sender is its account,
 * with a quarter of the whole; anyone else is their network address (an IPv6 /64, which one machine usually has whole),
 * with a small share, since sign-in forms are small. The worker's internal listener isn't counted: it mustn't be turned
 * away by the public.
 */
export const BODIES_IN_MEMORY_LIMIT = 64 * 1024 * 1024;
export const BODIES_PER_ACCOUNT_LIMIT = 16 * 1024 * 1024;
export const BODIES_PER_ADDRESS_LIMIT = 1024 * 1024;
/** Bodies of routes that take at most this (sign-in and other forms) count in a budget of their own, so large ones can't crowd them out. */
export const SMALL_BODY_LIMIT = 64 * 1024;
export type BodySender = { key: string; share: number };
const bodiesInMemory = { small: 0, large: 0 };
const bodiesBySender = new Map<string, number>();

export const accountSender = (accountId: string): BodySender => ({ key: `account:${accountId}`, share: BODIES_PER_ACCOUNT_LIMIT });
export function addressSender(address: string): BodySender {
  const a = address.replace(/^::ffff:(?=\d+\.)/i, "").toLowerCase();
  if (!a.includes(":")) return { key: `address:${a}`, share: BODIES_PER_ADDRESS_LIMIT };
  // The first four groups of the full IPv6 address: its /64.
  const [head = "", tail = ""] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return { key: `address:${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`, share: BODIES_PER_ADDRESS_LIMIT };
}

export async function readBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT, pace = UPLOAD_PACE, from: BodySender | null = null): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  const pool = limit <= SMALL_BODY_LIMIT ? "small" : "large";
  try {
    for await (const chunk of bodyChunks(req, limit, pace)) {
      if (from !== null) {
        const mine = bodiesBySender.get(from.key) ?? 0;
        if (bodiesInMemory[pool] + chunk.length > BODIES_IN_MEMORY_LIMIT || mine + chunk.length > from.share) {
          throw new HttpError(503, "busy", "The server is busy. Please try again in a moment.", undefined, Date.now() + 5000);
        }
        bodiesInMemory[pool] += chunk.length;
        bodiesBySender.set(from.key, mine + chunk.length);
      }
      size += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    if (from !== null && size > 0) {
      bodiesInMemory[pool] -= size;
      const left = (bodiesBySender.get(from.key) ?? 0) - size;
      if (left > 0) bodiesBySender.set(from.key, left);
      else bodiesBySender.delete(from.key);
    }
  }
  if (size === 0) return undefined;
  // splice(0) lets the chunks go as soon as they're joined: a large body is held twice at most, never three times.
  const text = Buffer.concat(chunks.splice(0), size).toString("utf8");
  if (type.startsWith("application/json")) {
    try { return JSON.parse(text); } catch { throw badRequest("The request body isn't valid JSON."); }
  }
  return text;
}

/**
 * Writes the body to `file` (created 0600) as it arrives, so a large upload never sits in memory; returns its size.
 * A file that can't be written (a full disk, no permission) is an answer, never an unhandled stream error. `onProgress`
 * sees the size so far and may throw (an HttpError) to stop the upload.
 */
export async function saveUpload(req: IncomingMessage, file: string, limit: number, pace = UPLOAD_PACE, onProgress?: (size: number) => void): Promise<number> {
  let size = 0;
  async function* counted() {
    for await (const chunk of bodyChunks(req, limit, pace)) {
      size += chunk.length;
      onProgress?.(size);
      yield chunk;
    }
  }
  try {
    await pipeline(counted(), createWriteStream(file, { flags: "wx", mode: 0o600 }));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") throw new HttpError(507, "disk_reserve", "The server is low on disk space, so the file can't be stored. Nothing you kept was removed.");
    console.error("[api] an upload couldn't be stored:", code ?? (err instanceof Error ? err.message : "unknown error"));
    throw new HttpError(500, "upload_not_stored", "The server couldn't store the upload. Please try again later.");
  }
  return size;
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

/** Forgets a key's count, e.g. an account's sign-in tries after a correct password. */
export function clearRateLimit(key: string): void {
  limiter.delete(key);
}

export function rateLimit(key: string, max = 20, windowMs = 10 * 60_000): void {
  const state = consumeRateLimit(key, max, windowMs);
  if (!state.allowed) throw new HttpError(429, "slow_down", "Too many attempts. Please wait a few minutes and try again.", undefined, state.resetAt);
}

export const nowIso = () => new Date().toISOString();
export const addSeconds = (s: number, from = Date.now()) => new Date(from + s * 1000).toISOString();

const PRIVATE_PEER = /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)|^::1$|^f[cd]/i;

/**
 * Who may say who the visitor is (PURSS_TRUST_PROXY): nobody; any peer on a private network ("1"); or
 * only the named proxies, by address or host name, so other containers on a shared proxy network can't.
 */
export type TrustProxy = false | "private" | readonly string[];

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = raw?.trim() ?? "";
  if (v === "" || v === "0") return false;
  if (v === "1") return "private";
  return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const unmapped = (a: string) => a.replace(/^::ffff:/i, "").toLowerCase();
/** The addresses each named proxy resolves to, refreshed by watchTrustedProxies (containers get new ones on restart). */
const proxyAddresses = new Map<string, Set<string>>();

/** Looks up named proxies now and every 30 seconds; the returned function stops it. */
export function watchTrustedProxies(trust: TrustProxy): () => void {
  if (!Array.isArray(trust)) return () => {};
  const warned = new Set<string>();
  const refresh = async () => {
    const { lookup } = await import("node:dns/promises");
    for (const name of trust) {
      try {
        proxyAddresses.set(name, new Set((await lookup(name, { all: true })).map((r) => unmapped(r.address))));
      } catch {
        // Keep the last answer. Never found, every visitor would share the proxy's own address for rate limits: say so.
        if (!proxyAddresses.has(name) && !warned.has(name)) {
          warned.add(name);
          console.error(`[api] PURSS_TRUST_PROXY names "${name}", which doesn't resolve; until it does, visitors through it share one address for rate limits.`);
        }
      }
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

function trustedPeer(peer: string, trust: TrustProxy): boolean {
  if (trust === false) return false;
  if (trust === "private") return PRIVATE_PEER.test(peer);
  const p = unmapped(peer);
  return trust.some((t) => t === p || proxyAddresses.get(t)?.has(p) === true);
}

/**
 * The visitor's address for rate limits. Only when the connection comes from a trusted proxy is a
 * forwarded address used at all; a direct visitor can't spoof it. Then only the right-most X-Forwarded-For
 * hop counts: the trusted proxy appends the address it saw (nginx's `$proxy_add_x_forwarded_for`, which
 * Nginx Proxy Manager sets), so that hop is the proxy's own observation, while any hop to its left, and
 * X-Real-IP, are whatever the client sent when the proxy passes them on unchanged instead of overwriting them.
 */
export function clientAddress(raw: import("node:http").IncomingMessage, trustProxy: TrustProxy): string {
  const peer = raw.socket.remoteAddress ?? "unknown";
  if (!trustedPeer(peer, trustProxy)) return peer;
  const fwd = raw.headers["x-forwarded-for"];
  const hops = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) ?? peer;
}
