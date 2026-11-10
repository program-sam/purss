import http from "node:http";
import type { Logger } from "../proxy.ts";
import type { BridgeRouter } from "./router.ts";

/*
 * The bridge router's listener. It serves GET /b/<service>/<key>/<signature> and nothing else; the
 * signature is the authorisation (an address only the worker and the API can make), so a public
 * feed that redirects the engine here gets the same 404 as any other unknown address. Logs carry
 * the service and status, never the key's signature.
 */

const ROUTE = /^\/b\/([a-z0-9]{2,20})\/([^/]{1,300})\/([A-Za-z0-9_-]{43})$/;

export function createBridgeServer(router: BridgeRouter, opts: { log?: Logger } = {}): http.Server {
  const log = opts.log ?? (() => {});
  const server = http.createServer({ maxHeaderSize: 8 * 1024, headersTimeout: 10_000, requestTimeout: 120_000, keepAliveTimeout: 2000 });
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
    const m = ROUTE.exec((req.url ?? "").split("?")[0] ?? "");
    if (!m) return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found.\n");
    if (req.method !== "GET") return send(res, 405, { allow: "GET", "content-type": "text/plain; charset=utf-8" }, "Method not allowed.\n");
    router
      .serve(m[1]!, m[2]!, m[3]!)
      .then((a) => {
        log({ event: "bridge.serve", service: m[1]!, status: a.status, ms: Date.now() - started });
        send(res, a.status, a.headers, a.body);
      })
      .catch(() => {
        log({ event: "bridge.error", service: m[1]!, status: 500 });
        send(res, 500, { "content-type": "text/plain; charset=utf-8" }, "Internal error.\n");
      });
  });
  return server;
}
