import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { BridgeLog } from "./bridge/log.ts";
import type { Logger } from "./proxy.ts";
import type { EgressStats } from "./stats.ts";

/*
 * Control listener: bound to loopback or one private address, service-token authenticated. It reports egress
 * health and the bridge's fetch summary to the API. It is a separate port from the engine-facing proxy and
 * gateway listeners on purpose: engine access can never read either.
 */

function tokenMatches(expected: string, header: string | undefined): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const given = createHash("sha256").update(m?.[1] ?? "").digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(given, want) && Boolean(m);
}

/** The Host header values a listener on loopback accepts. */
export const loopbackHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

export type ControlDeps = {
  token: string;
  stats: EgressStats;
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
    try {
      handle(req, res);
    } catch {
      log({ event: "control.error" });
      error(res, 500, "internal", "Internal error.");
    }
  });

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
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

    if (path === "/status" && method === "GET") return reply(res, 200, { status: "ok", ...deps.stats.snapshot() });
    if (path === "/bridge/summary" && method === "GET") {
      if (!deps.bridgeLog) return error(res, 404, "not_found", "The bridge isn't running on this installation.");
      const days = Number(url.searchParams.get("days") ?? 7);
      return reply(res, 200, deps.bridgeLog.summary(Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7));
    }
    return error(res, 404, "not_found", "No such route.");
  }
  return server;
}
