import http from "node:http";
import type { Logger } from "../proxy.ts";
import { FEED_ID } from "./service.ts";
import type { GatewayService } from "./service.ts";

/*
 * The engine-facing listener of the private feed gateway. It serves GET /feeds/<id>
 * and nothing else: no product, worker, admin or control routes exist here, and the
 * acknowledgement route lives only on the service-authenticated control listener.
 * Authentication is HTTP Basic (user name = feed id, password = revocable secret), the
 * form cURL, and therefore FreshRSS, can send.
 */

const FEED_PATH = /^\/feeds\/([A-Za-z0-9_-]{8,64})$/;
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 60_000;

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function createGatewayServer(service: GatewayService, opts: { log?: Logger; now?: () => number } = {}): http.Server {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();

  const server = http.createServer({ maxHeaderSize: 8 * 1024, headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 2000 });
  server.maxConnections = 128;
  server.on("clientError", (_e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  const send = (res: http.ServerResponse, status: number, headers: Record<string, string>, body: string) => {
    res.writeHead(status, { "content-length": Buffer.byteLength(body), connection: "close", ...headers });
    res.end(body);
  };

  server.on("request", (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "").split("?")[0] ?? "";
    const match = FEED_PATH.exec(path);
    if (!match) {
      send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found.\n");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { allow: "GET", "content-type": "text/plain; charset=utf-8" }, "Method not allowed.\n");
      return;
    }
    const feedId = match[1]!;
    const key = `${req.socket.remoteAddress ?? ""}|${feedId}`;
    const t = now();
    const f = failures.get(key);
    if (f && f.resetAt > t && f.count >= FAIL_LIMIT) {
      send(res, 429, { "retry-after": String(Math.ceil((f.resetAt - t) / 1000)), "content-type": "text/plain; charset=utf-8" }, "Too many failed attempts. Try again later.\n");
      return;
    }
    const creds = parseBasic(req.headers.authorization);
    if (!creds || !service.authenticate(feedId, creds.user, creds.pass)) {
      const entry = f && f.resetAt > t ? f : { count: 0, resetAt: t + FAIL_WINDOW_MS };
      entry.count++;
      failures.set(key, entry);
      if (failures.size > 2000) for (const [k, v] of failures) if (v.resetAt <= t) failures.delete(k);
      log({ event: "gateway.deny", feed: feedId, status: 401 });
      send(res, 401, { "www-authenticate": 'Basic realm="feed", charset="UTF-8"', "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Authentication required.\n");
      return;
    }
    failures.delete(key);
    const ifNone = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : null;
    service
      .serve(feedId, ifNone)
      .then((r) => {
        log({ event: "gateway.serve", feed: feedId, status: r.status, ms: Date.now() - started });
        send(res, r.status, r.headers, r.body);
      })
      .catch(() => {
        log({ event: "gateway.error", feed: feedId, status: 500 });
        send(res, 500, { "content-type": "text/plain; charset=utf-8" }, "Internal error.\n");
      });
  });
  return server;
}
