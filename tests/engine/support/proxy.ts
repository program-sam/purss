import { request as httpRequest, createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A recording HTTP forward proxy used as the engine's egress in contract tests. It only forwards to hosts on its
 * allowlist and refuses everything else (CONNECT included), which is enough to prove that the engine sends every feed
 * fetch through the configured proxy. It is test infrastructure: the product's real proxy is apps/egress.
 */
export class TestProxy {
  readonly seen: Array<{ method: string; url: string; allowed: boolean; at: number }> = [];
  readonly allow: Set<string>;
  #server: Server | null = null;
  port = 0;

  constructor(allowedHostPorts: Iterable<string>) {
    this.allow = new Set(allowedHostPorts);
  }

  async start(port = 0): Promise<void> {
    const server = createServer((req, res) => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        res.writeHead(400);
        return void res.end("proxy requests must use an absolute URI");
      }
      const allowed = this.allow.has(target.host);
      this.seen.push({ method: req.method ?? "GET", url: `${target.protocol}//${target.host}${target.pathname}`, allowed, at: Date.now() });
      if (!allowed || target.protocol !== "http:") {
        res.writeHead(403, { "content-type": "text/plain" });
        return void res.end("blocked by test proxy");
      }
      const upstream = httpRequest({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, "x-purss-test-proxy": "1" } }, (u) => {
        res.writeHead(u.statusCode ?? 502, u.headers);
        u.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    server.on("connect", (req, socket) => {
      this.seen.push({ method: "CONNECT", url: req.url ?? "", allowed: false, at: Date.now() });
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    this.#server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  }

  get running(): boolean {
    return this.#server !== null;
  }
}
