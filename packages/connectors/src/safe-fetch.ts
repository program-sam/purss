import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import { pipeline, Writable } from "node:stream";
import type { Transform } from "node:stream";
import { classifyAddress, hostnameVerdict, isBlockedPort } from "./addresses.ts";
import { parseContentType } from "./content-type.ts";
import { redactUrl } from "./privacy.ts";

/*
 * safeFetch: the only way product code fetches a URL that a user, a feed or a page
 * supplied. Every hop is validated, the connection is bound to the validated
 * address, redirects are followed here (never by the HTTP stack), and time and
 * size are bounded in every phase including after decompression.
 */

export type FailureReason = "blocked" | "unreachable" | "toolarge" | "timeout" | "invalid" | "aborted";

export const USER_AGENT = "PURSS/0.1 (self-hosted feed reader)";
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const HARD_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_URL_LENGTH = 2048;

export type PhaseTimeouts = {
  /** DNS resolution of one hop. */
  resolveMs?: number;
  /** TCP (+TLS) connection of one hop. */
  connectMs?: number;
  /** Request sent until response headers arrive. */
  firstByteMs?: number;
  /** Longest silence while the body streams. */
  idleMs?: number;
};

export type Resolver = (hostname: string, signal?: AbortSignal) => Promise<string[]>;

export type SafeFetchOptions = {
  /** Cap on decompressed body bytes. Default 2 MiB, never above 32 MiB. */
  maxBytes?: number;
  /** Redirect hops followed. Default and ceiling 5. */
  maxRedirects?: number;
  /** Overall deadline for all hops. Default 20 s. */
  timeoutMs?: number;
  phaseTimeoutsMs?: PhaseTimeouts;
  signal?: AbortSignal;
  /** Extra request headers. Credential headers are sent to the first hop only and never forwarded on a redirect. */
  headers?: Record<string, string>;
  accept?: string;
  /**
   * TEST ONLY. In-process escape hatch letting a test reach a loopback server. It is a
   * function argument on purpose: no environment variable or configuration can set it.
   */
  testAllowAddress?: (ip: string) => boolean;
  /** In-process DNS resolver, for tests that simulate rebinding. Results are still validated. */
  resolver?: Resolver;
  /** TEST ONLY. Extra trusted certificate authority (PEM) for a local HTTPS test server. */
  testTlsCa?: string | Buffer;
  /**
   * Return the first `maxBytes` of an oversized body (flagged `truncated`) instead of failing.
   * For previews that only need the start of a document, such as a very long podcast feed.
   */
  allowPartial?: boolean;
  /**
   * Send a POST with this body instead of a GET, for a fixed service the operator configured (the push
   * relay). Same address, connection, time and size rules; a POST never follows a redirect.
   */
  post?: { body: string; contentType: string };
};

export type SafeFetchResponse = {
  /** Final URL after redirects, without fragment. */
  url: string;
  requestedUrl: string;
  redirects: string[];
  status: number;
  /** Lower-cased header names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Media type without parameters, lower-case ("" when absent). */
  mediaType: string;
  contentType: string | null;
  /** Decompressed body. */
  body: Buffer;
  bytes: number;
  /** True when the body was cut at `maxBytes` (only with `allowPartial`). */
  truncated: boolean;
  remoteAddress: string | null;
  fetchedAt: string;
};

export type SafeFetchFailure = {
  ok: false;
  reason: FailureReason;
  /** Plain-language message safe to show to a user. */
  message: string;
  /** Technical detail with the URL redacted, safe for logs. */
  detail: string;
};
export type SafeFetchResult = { ok: true; response: SafeFetchResponse } | SafeFetchFailure;

class StopReading extends Error {
  constructor() {
    super("stopped at the partial-read limit");
  }
}

class Failure extends Error {
  reason: FailureReason;
  userMessage: string;
  constructor(reason: FailureReason, userMessage: string, detail: string) {
    super(detail);
    this.reason = reason;
    this.userMessage = userMessage;
  }
}

export type ParsedTarget = { ok: true; url: URL } | { ok: false; reason: "invalid" | "blocked"; message: string };

/** Validate the syntactic parts of a fetch target: scheme, credentials, host, port. */
export function parseTarget(input: string): ParsedTarget {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: "invalid", message: "That address is too long." };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid", message: "That doesn't look like a valid web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid", message: "Only web addresses starting with http:// or https:// can be followed." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "invalid", message: "Addresses with a username or password in them aren't supported. Remove the login part of the address." };
  }
  url.hash = "";
  const verdict = hostnameVerdict(url.hostname);
  if (!verdict.ok) return { ok: false, reason: "blocked", message: verdict.message };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (isBlockedPort(port)) return { ok: false, reason: "blocked", message: "That address uses a port that isn't used for websites, so it can't be followed." };
  return { ok: true, url };
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type ResolveResult =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; reason: "blocked" | "unreachable" | "timeout" | "aborted"; message: string; detail: string };

const BLOCKED_MESSAGE = "That address points to a private or internal network, so it can't be followed.";

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function raceTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Failure("timeout", "Looking up that website took too long.", "dns timeout")), ms);
    if (signal) {
      onAbort = () => reject(new Failure("aborted", "The request was cancelled.", "aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Resolve a host name and validate every address. The caller must connect to one of
 * the returned addresses and nothing else. Used by safeFetch and the egress proxy.
 */
export async function resolveDestination(
  hostname: string,
  opts: { signal?: AbortSignal; resolver?: Resolver; testAllowAddress?: (ip: string) => boolean; timeoutMs?: number } = {},
): Promise<ResolveResult> {
  const host = stripBrackets(hostname.toLowerCase().replace(/\.$/, ""));
  const allow = opts.testAllowAddress;
  const check = (ip: string): { ok: true } | { ok: false; range: string } => {
    if (allow?.(ip)) return { ok: true };
    const v = classifyAddress(ip);
    return v.allowed ? { ok: true } : { ok: false, range: v.range };
  };
  if (isIP(host)) {
    const c = check(host);
    if (!c.ok) return { ok: false, reason: "blocked", message: BLOCKED_MESSAGE, detail: `address in ${c.range} range` };
    return { ok: true, addresses: [{ address: host, family: isIP(host) === 6 ? 6 : 4 }] };
  }
  const verdict = hostnameVerdict(host);
  if (!verdict.ok) return { ok: false, reason: "blocked", message: verdict.message, detail: "internal host name" };
  let raw: string[];
  try {
    const resolver = opts.resolver ?? (async (h: string) => (await dnsLookup(h, { all: true, verbatim: true })).map((r) => r.address));
    raw = await raceTimeout(resolver(host, opts.signal), opts.timeoutMs ?? 5000, opts.signal);
  } catch (error) {
    if (error instanceof Failure) {
      return { ok: false, reason: error.reason === "aborted" ? "aborted" : "timeout", message: error.userMessage, detail: error.message };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ok: false, reason: "unreachable", message: "We couldn't find that website. Check the spelling of the address.", detail: `dns ${code}` };
    }
    return { ok: false, reason: "unreachable", message: "We couldn't look up that website right now.", detail: `dns ${code ?? "error"}` };
  }
  const unique = [...new Set(raw.map((a) => a.replace(/%.*$/, "")))];
  if (unique.length === 0) {
    return { ok: false, reason: "unreachable", message: "We couldn't find that website. Check the spelling of the address.", detail: "dns empty answer" };
  }
  const addresses: ResolvedAddress[] = [];
  for (const ip of unique) {
    const c = check(ip);
    // One forbidden answer rejects the whole name: a mixed answer is how rebinding attacks start.
    if (!c.ok) return { ok: false, reason: "blocked", message: BLOCKED_MESSAGE, detail: `host resolves to ${c.range} range` };
    const family = isIP(ip);
    if (family === 0) return { ok: false, reason: "unreachable", message: "We couldn't look up that website right now.", detail: "dns returned a non-address" };
    addresses.push({ address: ip, family: family === 6 ? 6 : 4 });
  }
  return { ok: true, addresses };
}

/** A `lookup` function that can only ever answer with the already validated addresses. */
export function boundLookup(addresses: ResolvedAddress[]): LookupFunction {
  return ((_hostname: string, options: { family?: number | string; all?: boolean }, callback: (...args: unknown[]) => void) => {
    const wanted = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const list = addresses.filter((a) => wanted === 0 || a.family === wanted);
    if (list.length === 0) {
      const err = Object.assign(new Error("no validated address for family"), { code: "ENOTFOUND" });
      callback(err);
      return;
    }
    if (options.all) callback(null, list.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, list[0]!.address, list[0]!.family);
  }) as unknown as LookupFunction;
}

type HopOk = { kind: "final"; status: number; headers: Record<string, string>; body: Buffer; truncated: boolean; remoteAddress: string | null } | { kind: "redirect"; status: number; location: string };

type Ctx = {
  signal: AbortSignal;
  maxBytes: number;
  timeouts: Required<PhaseTimeouts>;
  testAllowAddress?: (ip: string) => boolean;
  resolver?: Resolver;
  tlsCa?: string | Buffer;
  allowPartial: boolean;
  headers: Record<string, string>;
  accept: string;
  post?: { body: string; contentType: string };
  fail: (f: Failure) => void;
};

const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

function joinHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function decoderFor(encoding: string, chunkSize: number) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip({ chunkSize });
    case "deflate":
      return createInflate({ chunkSize });
    case "br":
      return createBrotliDecompress({ chunkSize });
    default:
      return null;
  }
}

function mapNetworkError(error: unknown, url: string): Failure {
  if (error instanceof Failure) return error;
  const e = error as NodeJS.ErrnoException;
  const code = e.code ?? "";
  const where = redactUrl(url);
  if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SELF_SIGNED") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "ERR_SSL_WRONG_VERSION_NUMBER" || /certificate|ssl|tls/i.test(e.message ?? "")) {
    return new Failure("unreachable", "That website's secure connection (HTTPS certificate) isn't valid, so we can't safely read it.", `tls ${code || "error"} ${where}`);
  }
  if (code === "ETIMEDOUT") return new Failure("timeout", "That website took too long to answer.", `connect timeout ${where}`);
  if (code === "ECONNREFUSED") return new Failure("unreachable", "That website refused the connection.", `ECONNREFUSED ${where}`);
  if (code === "ENOTFOUND") return new Failure("unreachable", "We couldn't find that website. Check the spelling of the address.", `ENOTFOUND ${where}`);
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ERR_STREAM_PREMATURE_CLOSE") return new Failure("unreachable", "The connection to that website was interrupted.", `${code} ${where}`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new Failure("unreachable", "We couldn't reach that website.", `${code} ${where}`);
  if (code.startsWith("HPE_") || code.startsWith("Z_") || code === "ERR_BROTLI_DECOMPRESSION_FAILED" || code === "ERR_BROTLI_INVALID_PARAM") {
    return new Failure("invalid", "That website sent a response we couldn't read.", `${code} ${where}`);
  }
  return new Failure("unreachable", "We couldn't reach that website.", `${code || e.name || "error"} ${where}`);
}

function requestHop(url: URL, addresses: ResolvedAddress[], ctx: Ctx, first: boolean): Promise<HopOk> {
  return new Promise<HopOk>((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: ctx.accept,
      "accept-encoding": "gzip, deflate, br",
      host: url.host,
    };
    for (const [k, v] of Object.entries(ctx.headers)) {
      const name = k.toLowerCase();
      if (!first && CREDENTIAL_HEADERS.has(name)) continue;
      if (name === "host" || name === "accept-encoding" || name === "user-agent") continue;
      headers[name] = v;
    }
    if (ctx.post) {
      headers["content-type"] = ctx.post.contentType;
      headers["content-length"] = String(Buffer.byteLength(ctx.post.body));
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clear();
      ctx.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (f: Failure) => {
      finish(() => {
        req?.destroy();
        res?.destroy();
        reject(f);
      });
    };
    const arm = (ms: number, label: string) => {
      clear();
      timer = setTimeout(() => fail(new Failure("timeout", "That website took too long to answer.", `${label} timeout ${redactUrl(url.href)}`)), ms);
    };
    const onAbort = () => {
      const reason = ctx.signal.reason;
      fail(reason instanceof Failure ? reason : new Failure("aborted", "The request was cancelled.", "aborted"));
    };
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    try {
      req = lib.request({
        protocol: url.protocol,
        hostname: stripBrackets(url.hostname),
        port,
        path: `${url.pathname}${url.search}`,
        method: ctx.post ? "POST" : "GET",
        headers,
        agent: false,
        lookup: boundLookup(addresses),
        // Certificates are always verified; SNI follows the host name.
        servername: isIP(stripBrackets(url.hostname)) ? undefined : stripBrackets(url.hostname),
        ...(ctx.tlsCa ? { ca: ctx.tlsCa } : {}),
        maxHeaderSize: 32 * 1024,
      });
    } catch (error) {
      fail(mapNetworkError(error, url.href));
      return;
    }
    arm(ctx.timeouts.connectMs, "connect");
    const wire = req;
    wire.on("socket", (socket) => {
      const verify = () => {
        const remote = socket.remoteAddress;
        if (remote && !ctx.testAllowAddress?.(remote) && !classifyAddress(remote).allowed) {
          fail(new Failure("blocked", BLOCKED_MESSAGE, "connection landed on a forbidden address"));
        }
      };
      socket.once("connect", verify);
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => arm(ctx.timeouts.firstByteMs, "response"));
    });
    wire.on("error", (error) => fail(mapNetworkError(error, url.href)));
    wire.on("response", (incoming) => {
      res = incoming;
      const status = incoming.statusCode ?? 0;
      const rawHeaders = joinHeaders(incoming.headers);
      if (status >= 300 && status < 400 && rawHeaders.location) {
        incoming.resume();
        finish(() => {
          incoming.destroy();
          resolve({ kind: "redirect", status, location: rawHeaders.location! });
        });
        return;
      }
      const encodingHeader = (rawHeaders["content-encoding"] ?? "").toLowerCase();
      const encodings = encodingHeader
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "identity");
      if (encodings.length > 3) {
        fail(new Failure("invalid", "That website sent a response we couldn't read.", "too many content encodings"));
        return;
      }
      const declared = Number(rawHeaders["content-length"]);
      if (encodings.length === 0 && Number.isFinite(declared) && declared > ctx.maxBytes && !ctx.allowPartial) {
        fail(new Failure("toolarge", "That page or feed is larger than we're willing to download.", `declared length ${declared} exceeds limit`));
        return;
      }
      // Encodings are listed in the order applied, so undo them last-to-first.
      const decoders: Transform[] = [];
      for (const enc of [...encodings].reverse()) {
        const d = decoderFor(enc, 16 * 1024);
        if (!d) {
          fail(new Failure("invalid", "That website used a compression format we can't read.", `unsupported content-encoding ${enc.slice(0, 20)}`));
          return;
        }
        decoders.push(d);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const collector = new Writable({
        write(chunk: Buffer, _enc, cb) {
          if (total + chunk.length > ctx.maxBytes) {
            if (ctx.allowPartial) {
              const room = ctx.maxBytes - total;
              if (room > 0) chunks.push(chunk.subarray(0, room));
              total = ctx.maxBytes;
              truncated = true;
              cb(new StopReading());
              return;
            }
            cb(new Failure("toolarge", "That page or feed is larger than we're willing to download.", `body exceeded ${ctx.maxBytes} bytes after decoding`));
            return;
          }
          total += chunk.length;
          chunks.push(chunk);
          cb();
        },
      });
      arm(ctx.timeouts.idleMs, "idle");
      incoming.on("data", () => arm(ctx.timeouts.idleMs, "idle"));
      pipeline([incoming, ...decoders, collector], (error) => {
        if (error && !(error instanceof StopReading)) {
          fail(mapNetworkError(error, url.href));
          return;
        }
        finish(() => resolve({ kind: "final", status, headers: rawHeaders, body: Buffer.concat(chunks, total), truncated, remoteAddress: incoming.socket?.remoteAddress ?? null }));
      });
    });
    wire.end(ctx.post?.body);
  });
}

/**
 * Fetch a public URL safely. Never throws: every outcome is a result. HTTP error
 * statuses are returned as responses (ok: true) so callers can word them.
 */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = Math.min(Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES), HARD_MAX_BYTES);
  const maxRedirects = Math.min(Math.max(0, opts.maxRedirects ?? MAX_REDIRECTS), MAX_REDIRECTS);
  const totalMs = opts.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const ctx: Ctx = {
    signal: controller.signal,
    maxBytes,
    timeouts: {
      resolveMs: opts.phaseTimeoutsMs?.resolveMs ?? 5000,
      connectMs: opts.phaseTimeoutsMs?.connectMs ?? 8000,
      firstByteMs: opts.phaseTimeoutsMs?.firstByteMs ?? 10_000,
      idleMs: opts.phaseTimeoutsMs?.idleMs ?? 10_000,
    },
    testAllowAddress: opts.testAllowAddress,
    resolver: opts.resolver,
    tlsCa: opts.testTlsCa,
    allowPartial: opts.allowPartial === true,
    headers: opts.headers ?? {},
    accept: opts.accept ?? "*/*",
    post: opts.post,
    fail: (f) => controller.abort(f),
  };
  const total = setTimeout(() => ctx.fail(new Failure("timeout", "That website took too long to answer.", "overall timeout")), totalMs);
  const onCallerAbort = () => ctx.fail(new Failure("aborted", "The request was cancelled.", "aborted"));
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const requestedUrl = input;
  const redirects: string[] = [];
  const seen = new Set<string>();
  try {
    let current = input;
    for (let hop = 0; ; hop++) {
      const target = parseTarget(current);
      if (!target.ok) {
        throw new Failure(target.reason, target.message, `${target.reason}: ${redactUrl(current)}`);
      }
      const url = target.url;
      if (seen.has(url.href)) throw new Failure("invalid", "That address keeps redirecting in a loop.", "redirect loop");
      seen.add(url.href);
      const lookup = () => resolveDestination(url.hostname, { signal: ctx.signal, resolver: ctx.resolver, testAllowAddress: ctx.testAllowAddress, timeoutMs: ctx.timeouts.resolveMs });
      let resolved = await lookup();
      // A name that was not answered in time is asked once more: the resolver is usually still on the first question
      // or has the answer cached by then. The addresses that come back are checked exactly like the first answer's.
      if (!resolved.ok && resolved.reason === "timeout" && !ctx.signal.aborted) resolved = await lookup();
      if (!resolved.ok) throw new Failure(resolved.reason, resolved.message, `${resolved.detail}: ${redactUrl(url.href)}`);
      const result = await requestHop(url, resolved.addresses, ctx, hop === 0);
      if (result.kind === "final") {
        const contentType = result.headers["content-type"] ?? null;
        return {
          ok: true,
          response: {
            url: url.href,
            requestedUrl,
            redirects,
            status: result.status,
            headers: result.headers,
            mediaType: parseContentType(contentType).mediaType,
            contentType,
            body: result.body,
            bytes: result.body.length,
            truncated: result.truncated,
            remoteAddress: result.remoteAddress,
            fetchedAt: new Date().toISOString(),
          },
        };
      }
      // A redirected POST would send the body somewhere nobody configured.
      if (ctx.post) throw new Failure("invalid", "That service answered with a redirect, which isn't followed for a POST.", "redirect after POST refused");
      if (hop >= maxRedirects) throw new Failure("invalid", "That address redirects too many times.", `more than ${maxRedirects} redirects`);
      let next: URL;
      try {
        next = new URL(result.location, url);
      } catch {
        throw new Failure("invalid", "That website redirected us to an address that isn't valid.", "malformed redirect location");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Failure("blocked", "That website redirected us somewhere that isn't a web address.", `redirect to ${next.protocol} refused`);
      }
      redirects.push(url.href);
      current = next.href;
    }
  } catch (error) {
    const failure = error instanceof Failure ? error : mapNetworkError(error, input);
    const finalFailure = ctx.signal.aborted && ctx.signal.reason instanceof Failure ? (ctx.signal.reason as Failure) : failure;
    return { ok: false, reason: finalFailure.reason, message: finalFailure.userMessage, detail: finalFailure.message };
  } finally {
    clearTimeout(total);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}
