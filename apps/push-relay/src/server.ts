import { createHash, createHmac } from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Buckets } from "./limits.ts";
import type { LogEvent, Provider } from "./provider.ts";
import type { Clock, Platform, Store } from "./store.ts";

export interface RelayConfig {
  trustProxy: boolean;
}

export interface RelayDeps {
  store: Store;
  /** A platform without a provider is unavailable: notify answers 503. */
  providers: { fcm?: Provider; apns?: Provider };
  clock: Clock;
  config: RelayConfig;
  /** Key for the handle HMAC. */
  secret: Buffer;
  /** Called with an outcome name such as "register" or "notify_gone"; the only record kept of traffic. */
  count?: (outcome: string) => void;
  log?: (event: LogEvent) => void;
}

const MAX_BODY = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);
const TOKEN_FORMAT: Record<Platform, RegExp> = { fcm: /^[A-Za-z0-9_:\-]{20,512}$/, apns: /^[0-9a-fA-F]{64,200}$/ };
const SCOPE_FORMAT = /^[A-Za-z0-9_-]{22,64}$/;
const HANDLE_FORMAT = /^rh_[A-Za-z0-9_-]{43}$/;
const JSON_TYPE = /^application\/json\s*(;.*)?$/i;
const PRIVATE_PEER = /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)|^::1$|^f[cd]/i;
const TEN_MINUTES = 600;

/**
 * The peer address, or with a trusted reverse proxy in front, the client it reports. Only the right-most
 * X-Forwarded-For hop is used: the trusted proxy appends the address it saw (nginx's
 * `$proxy_add_x_forwarded_for`), while everything left of it, and X-Real-IP, may come from the client itself.
 */
export function clientAddress(raw: IncomingMessage, trustProxy: boolean): string {
  const peer = raw.socket.remoteAddress ?? "unknown";
  if (!trustProxy || !PRIVATE_PEER.test(peer)) return peer;
  const fwd = raw.headers["x-forwarded-for"];
  const hops = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) ?? peer;
}

/**
 * The key an address is limited by: an IPv4 address as it is (also when written IPv4-mapped), an IPv6
 * address by its /64, which one subscriber usually holds whole, so walking through it gains nothing.
 */
export function limitKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("%")[0]!.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

class Reject extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(String(status));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const invalid = () => new Reject(400, { error: "invalid" });
const slowDown = (seconds: number) => new Reject(429, { error: "slow_down" }, { "retry-after": String(seconds) });

/** The relay's HTTP server: register, unregister, notify and healthz. Listening is up to the caller. */
export function createRelay(deps: RelayDeps): Server {
  const { store, providers, clock, config, secret } = deps;
  const count = deps.count ?? (() => {});
  const registerLimit = new Buckets(30, 30 / TEN_MINUTES, clock);
  const unregisterLimit = new Buckets(60, 60 / TEN_MINUTES, clock);
  const senderLimit = new Buckets(600, 10, clock);
  const handleLimit = new Buckets(5, 1 / 60, clock);
  // At most 200 wakes a day per phone, however they are spread out.
  const handleDaily = new Buckets(200, 200 / 86_400, clock);
  // All registrations together, from any number of addresses: 300 at once, then 5 a second.
  const registerBudget = new Buckets(300, 5, clock, 1);

  const keyOf = (handle: string) => createHash("sha256").update(handle).digest("hex");
  const handleFor = (platform: Platform, token: string, scope: string) =>
    `rh_${createHmac("sha256", secret).update(`${platform}\n${token}\n${scope}`).digest("base64url")}`;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(text ? { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)) } : {}),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(text);
  }

  async function readJson(req: IncomingMessage, keys: string[]): Promise<Record<string, string>> {
    if (!JSON_TYPE.test(req.headers["content-type"] ?? "")) throw new Reject(415, { error: "invalid" });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    }
    if (size > MAX_BODY) throw new Reject(413, { error: "too_large" }, { connection: "close" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw invalid();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
    const object = parsed as Record<string, unknown>;
    const present = Object.keys(object);
    if (present.length !== keys.length || !keys.every((k) => typeof object[k] === "string")) throw invalid();
    return object as Record<string, string>;
  }

  function register(body: Record<string, string>): { handle: string } {
    const { platform, token, scope } = body as { platform: string; token: string; scope: string };
    if (platform !== "fcm" && platform !== "apns") throw invalid();
    if (!TOKEN_FORMAT[platform].test(token) || !SCOPE_FORMAT.test(scope)) throw invalid();
    const stored = platform === "apns" ? token.toLowerCase() : token;
    const handle = handleFor(platform, stored, scope);
    store.register(keyOf(handle), platform, stored, clock());
    count("register");
    return { handle };
  }

  async function notify(handle: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const key = keyOf(handle);
    const device = store.get(key);
    if (!device) {
      count("notify_unknown");
      return { status: 404, body: { error: "gone" } };
    }
    const provider = providers[device.platform];
    if (!provider) {
      count("notify_unavailable");
      return { status: 503, body: { error: "unavailable" } };
    }
    const wait = handleLimit.take(key) || handleDaily.take(key);
    if (wait) throw slowDown(wait);
    const outcome = await provider.send(device.token, device.apnsEnv);
    if (outcome.status === "ok") {
      store.touch(key, clock());
      if (outcome.env && outcome.env !== device.apnsEnv) store.setApnsEnv(key, outcome.env);
      count("notify_ok");
      return { status: 202, body: { ok: true } };
    }
    if (outcome.status === "gone") {
      store.remove(key);
      count("notify_gone");
      return { status: 404, body: { error: "gone" } };
    }
    count("notify_provider_failed");
    return { status: 502, body: { error: "provider" } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? "").split("?")[0];
    const origin = req.headers.origin;
    const corsAllowed = typeof origin === "string" && APP_ORIGINS.has(origin);
    const browserRoute = pathname === "/v1/register" || pathname === "/v1/unregister";
    const cors: Record<string, string> = browserRoute && corsAllowed ? { "access-control-allow-origin": origin, vary: "Origin" } : browserRoute ? { vary: "Origin" } : {};
    const known = browserRoute || pathname === "/v1/notify" || pathname === "/healthz";
    if (!known) return send(res, 404, { error: "not_found" });

    if (req.method === "OPTIONS" && browserRoute) {
      const preflight: Record<string, string> = corsAllowed && req.headers["access-control-request-method"] === "POST"
        ? { "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }
        : {};
      return send(res, 204, undefined, { ...cors, ...preflight });
    }
    if (pathname === "/healthz") {
      if (req.method !== "GET") return send(res, 405, { error: "method" }, { allow: "GET" });
      return send(res, 200, { ok: true, fcm: Boolean(providers.fcm), apns: Boolean(providers.apns) });
    }
    if (req.method !== "POST") return send(res, 405, { error: "method" }, { ...cors, allow: browserRoute ? "POST, OPTIONS" : "POST" });

    try {
      const address = limitKey(clientAddress(req, config.trustProxy));
      if (pathname === "/v1/register") {
        const wait = registerLimit.take(address) || registerBudget.take("all");
        if (wait) throw slowDown(wait);
        send(res, 200, register(await readJson(req, ["platform", "token", "scope"])), cors);
      } else if (pathname === "/v1/unregister") {
        const wait = unregisterLimit.take(address);
        if (wait) throw slowDown(wait);
        const body = await readJson(req, ["handle"]);
        if (!HANDLE_FORMAT.test(body.handle!)) throw invalid();
        store.remove(keyOf(body.handle!));
        count("unregister");
        send(res, 204, undefined, cors);
      } else {
        const wait = senderLimit.take(address);
        if (wait) throw slowDown(wait);
        const body = await readJson(req, ["handle"]);
        if (!HANDLE_FORMAT.test(body.handle!)) throw invalid();
        const result = await notify(body.handle!);
        send(res, result.status, result.body);
      }
    } catch (error) {
      if (error instanceof Reject) {
        if (error.status === 429) count("limited");
        else count("rejected");
        return send(res, error.status, error.body, { ...cors, ...error.headers });
      }
      throw error;
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      count("error");
      deps.log?.({ event: "relay.error" });
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.end();
    });
  });
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
