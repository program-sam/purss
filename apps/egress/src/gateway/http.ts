import http from "node:http";
import type { Logger } from "../proxy.ts";
import type { TrimService } from "./trim-service.ts";

/*
 * The engine-facing listener of the feed gateway. It serves GET /t/<signature>/<address>
 * (a big feed, trimmed) and nothing else: no product, worker, admin or control routes exist
 * here. A /t address is its own credential: the signature is made with the installation's
 * feed-trim key, and anything unsigned is a 404.
 */

const TRIM_PATH = /^\/t\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{1,4000})$/;

export function createGatewayServer(opts: { log?: Logger; trim?: TrimService | null } = {}): http.Server {
  const log = opts.log ?? (() => {});

  const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 2000 });
  server.maxConnections = 128;
  server.on("clientError", (_e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  const send = (res: http.ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) => {
    res.writeHead(status, { "content-length": Buffer.byteLength(body), connection: "close", ...headers });
    res.end(body);
  };

  server.on("request", (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const trimMatch = TRIM_PATH.exec(path);
    if (!trimMatch || !opts.trim) {
      send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found.\n");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { allow: "GET", "content-type": "text/plain; charset=utf-8" }, "Method not allowed.\n");
      return;
    }
    opts.trim
      .serve(trimMatch[2]!, trimMatch[1]!)
      .then((a) => send(res, a.status, a.headers, a.body))
      .catch(() => {
        log({ event: "gateway.error", route: "trim", status: 500 });
        send(res, 500, { "content-type": "text/plain; charset=utf-8" }, "Internal error.\n");
      });
  });
  return server;
}
