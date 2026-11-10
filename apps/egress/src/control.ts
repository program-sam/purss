import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { BridgeLog } from "./bridge/log.ts";
import { GatewayError } from "./gateway/service.ts";
import type { GatewayService, UpsertFeed } from "./gateway/service.ts";
import type { Logger } from "./proxy.ts";
import type { EgressStats } from "./stats.ts";

/*
 * Control listener: bound to loopback or one private address, service-token authenticated. It reports egress
 * health to the API and carries the gateway's management routes, including the
 * acknowledgement the product sends after it has durably committed items. It is a
 * separate port from the engine-facing proxy and gateway listeners on purpose: engine
 * access can never acknowledge, create, rotate or delete anything.
 */

const MAX_BODY = 64 * 1024;
const FEED = "([A-Za-z0-9_-]{8,64})";

function tokenMatches(expected: string, header: string | undefined): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const given = createHash("sha256").update(m?.[1] ?? "").digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(given, want) && Boolean(m);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new GatewayError("bad_request", "Send application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new GatewayError("bad_request", "That request is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new GatewayError("bad_request", "That request isn't valid JSON.");
  }
}

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("bad_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}

/** The Host header values a listener on loopback accepts. */
export const loopbackHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

export type ControlDeps = {
  token: string;
  stats: EgressStats;
  gateway: GatewayService;
  /** The bridge fetch log, when the bridge router runs. */
  bridgeLog?: BridgeLog | null;
  log?: Logger;
  /** Allowed Host header values, lower-case; defaults to the loopback names on the listening port. */
  allowedHosts?: (port: number) => string[];
};

export function createControlServer(deps: ControlDeps): http.Server {
  const log = deps.log ?? (() => {});
  const server = http.createServer({ maxHeaderSize: 8 * 1024, headersTimeout: 10_000, requestTimeout: 20_000, keepAliveTimeout: 2000 });
  server.maxConnections = 32;
  server.on("clientError", (_e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", connection: "close" });
    res.end(text);
  };
  const error = (res: http.ServerResponse, status: number, code: string, message: string) => reply(res, status, { error: { code, message } });

  server.on("request", (req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (e instanceof GatewayError) {
        const status = e.code === "not_found" ? 404 : 400;
        error(res, status, e.code, e.message);
      } else {
        log({ event: "control.error" });
        error(res, 500, "internal", "Internal error.");
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Guards against DNS rebinding from a browser page: only the listener's own address names are served.
    const port = (server.address() as { port: number } | null)?.port ?? 0;
    const hosts = (deps.allowedHosts ?? loopbackHosts)(port);
    if (!hosts.includes((req.headers.host ?? "").toLowerCase())) return error(res, 421, "bad_host", "Unexpected host name.");
    if (!tokenMatches(deps.token, req.headers.authorization)) {
      res.setHeader("www-authenticate", "Bearer");
      return error(res, 401, "unauthorized", "A valid service token is required.");
    }
    const url = new URL(req.url ?? "/", "http://control.invalid");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const gw = deps.gateway;
    let m: RegExpExecArray | null;

    if (path === "/status" && method === "GET") return reply(res, 200, { status: "ok", ...deps.stats.snapshot() });
    if (path === "/gateway/status" && method === "GET") return reply(res, 200, gw.summary());
    if (path === "/bridge/summary" && method === "GET") {
      if (!deps.bridgeLog) return error(res, 404, "not_found", "The bridge isn't running on this installation.");
      const days = Number(url.searchParams.get("days") ?? 7);
      return reply(res, 200, deps.bridgeLog.summary(Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7));
    }

    if ((m = new RegExp(`^/gateway/feeds/${FEED}$`).exec(path))) {
      const feedId = m[1]!;
      if (method === "PUT") {
        const b = obj(await readJson(req));
        const input: UpsertFeed = {
          feedId,
          adapter: String(b.adapter ?? ""),
          title: String(b.title ?? ""),
          siteUrl: typeof b.siteUrl === "string" ? b.siteUrl : null,
          description: typeof b.description === "string" ? b.description : null,
          params: b.params,
          limits: b.limits && typeof b.limits === "object" ? (b.limits as UpsertFeed["limits"]) : undefined,
        };
        return reply(res, 200, gw.upsertFeed(input));
      }
      if (method === "GET") {
        const state = gw.state(feedId);
        return state ? reply(res, 200, state) : error(res, 404, "not_found", "No such feed.");
      }
      if (method === "DELETE") return gw.deleteFeed(feedId) ? reply(res, 200, { deleted: true }) : error(res, 404, "not_found", "No such feed.");
    }
    if ((m = new RegExp(`^/gateway/feeds/${FEED}/credential$`).exec(path))) {
      const feedId = m[1]!;
      if (method === "POST") {
        const b = obj(await readJson(req));
        const grace = b.graceSeconds === undefined ? 0 : Number(b.graceSeconds);
        if (!Number.isFinite(grace) || grace < 0) throw new GatewayError("bad_request", "graceSeconds must be zero or more.");
        log({ event: "control.credential_issued", feed: feedId });
        return reply(res, 200, gw.issueCredential(feedId, { graceSeconds: grace }));
      }
      if (method === "DELETE") {
        log({ event: "control.credential_revoked", feed: feedId });
        return gw.revokeCredential(feedId) ? reply(res, 200, { revoked: true }) : error(res, 404, "not_found", "No such feed.");
      }
    }
    if ((m = new RegExp(`^/gateway/feeds/${FEED}/ack$`).exec(path)) && method === "POST") {
      const b = obj(await readJson(req));
      if (!Array.isArray(b.guids)) throw new GatewayError("bad_request", "guids must be a list.");
      return reply(res, 200, { released: gw.ack(m[1]!, b.guids as string[]) });
    }
    if ((m = new RegExp(`^/gateway/feeds/${FEED}/grant-lost$`).exec(path)) && method === "POST") {
      const b = obj(await readJson(req));
      const code = typeof b.code === "string" && /^[a-z_]{3,40}$/.test(b.code) ? b.code : "user_disconnect";
      gw.markGrantLost(m[1]!, code);
      log({ event: "control.grant_lost", feed: m[1]!, code });
      return reply(res, 200, gw.state(m[1]!));
    }
    if ((m = new RegExp(`^/gateway/feeds/${FEED}/gaps/clear$`).exec(path)) && method === "POST") {
      const b = obj(await readJson(req));
      return reply(res, 200, { cleared: gw.clearGaps(m[1]!, Array.isArray(b.ids) ? (b.ids as number[]) : []) });
    }
    return error(res, 404, "not_found", "No such route.");
  }
  return server;
}
