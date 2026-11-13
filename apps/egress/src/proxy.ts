import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { boundLookup, classifyAddress, isBlockedPort, redactUrl, resolveDestination } from "@purss/connectors";
import type { Resolver } from "@purss/connectors";
import type { EgressConfig, InternalDestination } from "./config.ts";
import type { EgressStats } from "./stats.ts";

/*
 * Forward proxy for the feed engine. FreshRSS is configured to use it for every
 * fetch (its global cURL options), so product-grade address rules apply to the
 * engine too: each request, and each redirect hop the client follows (arriving here
 * as a new request), is resolved and validated, and the outgoing connection is bound
 * to the validated address. Only plain GET/HEAD in absolute form and CONNECT tunnels
 * are served. Nothing else about the listener is reachable.
 */

export type LogEvent = Record<string, string | number | boolean | null>;
export type Logger = (event: LogEvent) => void;

export type ProxyDeps = {
  config: Pick<EgressConfig, "internalDestinations" | "limits">;
  stats: EgressStats;
  log?: Logger;
  /** TEST ONLY: in-process allowance for local upstream servers. Never read from config or env. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY: in-process resolver. Answers are validated like real DNS answers. */
  resolver?: Resolver;
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding"]);

function plain(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${message}\n`;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body), connection: "close", ...extra });
  res.end(body);
}

function rawResponse(socket: Duplex, status: number, text: string, message: string): void {
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function findInternal(list: InternalDestination[], host: string, port: number): InternalDestination | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.find((d) => d.host === h && d.port === port);
}

function logPath(url: URL): string {
  return redactUrl(`${url.protocol}//${url.host}${url.pathname}${url.search}`).replace(/^https?:\/\/[^/]+/, "");
}

export function createProxyServer(deps: ProxyDeps): http.Server {
  const { config, stats } = deps;
  const log: Logger = deps.log ?? (() => {});
  const limits = config.limits;

  const deny = (reason: string, fields: LogEvent): void => {
    stats.blocked.add();
    log({ event: "proxy.deny", reason, ...fields });
  };

  /** Policy decision for one destination. Returns the validated connect target or a refusal. */
  async function decide(host: string, port: number, tunnel: boolean): Promise<
    | { ok: true; addresses: { address: string; family: 4 | 6 }[]; internal: boolean }
    | { ok: false; status: 403 | 502 | 504; reason: string; message: string }
  > {
    const internal = findInternal(config.internalDestinations, host, port);
    if (internal) {
      if (tunnel) return { ok: false, status: 403, reason: "internal-tunnel", message: "Internal destinations can't be tunnelled." };
      const family = net.isIP(internal.connectHost) === 6 ? 6 : 4;
      return { ok: true, addresses: [{ address: internal.connectHost, family }], internal: true };
    }
    if (isBlockedPort(port)) return { ok: false, status: 403, reason: "port", message: "Blocked by egress policy: that port is not used for websites." };
    const resolved = await resolveDestination(host, { resolver: deps.resolver, testAllowAddress: deps.testAllowAddress, timeoutMs: 5000 });
    if (!resolved.ok) {
      if (resolved.reason === "blocked") return { ok: false, status: 403, reason: "address", message: "Blocked by egress policy: private or internal destination." };
      return { ok: false, status: resolved.reason === "timeout" ? 504 : 502, reason: `dns-${resolved.reason}`, message: "The destination could not be found." };
    }
    return { ok: true, addresses: resolved.addresses, internal: false };
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: limits.requestTimeoutMs, headersTimeout: Math.min(20_000, limits.requestTimeoutMs), keepAliveTimeout: 1000 });
  server.maxConnections = limits.maxConnections;

  server.on("clientError", (_err, socket) => {
    if (socket.writable) rawResponse(socket, 400, "Bad Request", "Bad request.");
    else socket.destroy();
  });

  server.on("request", (req, res) => {
    void handleRequest(req, res).catch(() => plain(res, 500, "Proxy error."));
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const target = req.url ?? "";
    if (!/^http:\/\//i.test(target)) {
      // Origin-form requests would be addressed to this proxy itself; there is nothing to serve.
      deny("not-absolute-form", { method: req.method ?? "", note: /^https:\/\//i.test(target) ? "https needs CONNECT" : "origin-form" });
      plain(res, /^https:\/\//i.test(target) ? 400 : 404, /^https:\/\//i.test(target) ? "Use CONNECT for https." : "Not found.");
      return;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      deny("bad-url", { method: req.method ?? "" });
      plain(res, 400, "Bad request.");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const method = req.method ?? "GET";
    const fields: LogEvent = { method, host: url.hostname, port, path: logPath(url) };
    if (url.username || url.password) {
      deny("credentials-in-url", fields);
      plain(res, 400, "Credentials in the address are not accepted here; send an Authorization header.");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      deny("method", fields);
      plain(res, 405, "Only GET and HEAD are allowed.", { allow: "GET, HEAD" });
      return;
    }
    if ((req.headers["content-length"] && req.headers["content-length"] !== "0") || req.headers["transfer-encoding"]) {
      deny("request-body", fields);
      plain(res, 400, "Requests with a body are not allowed.");
      return;
    }
    const decision = await decide(url.hostname, port, false);
    if (!decision.ok) {
      if (decision.status === 403) deny(decision.reason, fields);
      else log({ event: "proxy.error", reason: decision.reason, ...fields });
      plain(res, decision.status, decision.message);
      return;
    }
    stats.allowed.add();

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (HOP_BY_HOP.has(name) || name.startsWith("proxy-") || name === "host" || v === undefined) continue;
      headers[name] = v;
    }
    headers.host = url.host;
    headers.connection = "close";
    let bytes = 0;
    let done = false;
    const finish = (status: number, note?: string) => {
      if (done) return;
      done = true;
      log({ event: "proxy.done", ...fields, status, bytes, ms: Date.now() - started, ...(note ? { note } : {}), internal: decision.internal });
    };

    const upstream = http.request({
      host: decision.addresses[0]!.address,
      port: decision.internal ? config.internalDestinations.find((d) => d.host === url.hostname.toLowerCase() && d.port === port)!.connectPort : port,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      lookup: boundLookup(decision.addresses),
      timeout: limits.connectTimeoutMs,
    });
    const overall = setTimeout(() => upstream.destroy(new Error("overall timeout")), limits.requestTimeoutMs);
    res.on("close", () => {
      // The client went away before the response finished: stop the upstream transfer too.
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on("socket", (socket) => {
      socket.once("connect", () => {
        const remote = socket.remoteAddress;
        if (!decision.internal && remote && !deps.testAllowAddress?.(remote) && !classifyAddress(remote).allowed) {
          deny("connected-address", fields);
          upstream.destroy(new Error("forbidden address"));
        }
      });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("connect timeout")));
    upstream.on("error", (error) => {
      clearTimeout(overall);
      const timedOut = /timeout/.test(error.message);
      if (!res.headersSent) plain(res, timedOut ? 504 : 502, timedOut ? "The destination took too long to answer." : "The destination could not be reached.");
      else res.destroy();
      finish(timedOut ? 504 : 502, timedOut ? "timeout" : "unreachable");
    });
    upstream.on("response", (upRes) => {
      upstream.setTimeout(0); // the connect/response-start timer ends here; body stalls use idleTimeoutMs
      const declared = Number(upRes.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
        upRes.destroy();
        upstream.destroy();
        clearTimeout(overall);
        plain(res, 502, "The response is larger than the limit.");
        finish(502, "oversize");
        return;
      }
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        const name = k.toLowerCase();
        if (v === undefined || HOP_BY_HOP.has(name)) continue;
        out[name] = v;
      }
      out.connection = "close";
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.setTimeout(limits.idleTimeoutMs, () => {
        upRes.destroy(new Error("idle timeout"));
        res.destroy();
        finish(upRes.statusCode ?? 504, "idle-timeout");
      });
      upRes.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limits.maxResponseBytes) {
          upRes.destroy();
          res.destroy();
          clearTimeout(overall);
          finish(upRes.statusCode ?? 502, "oversize");
          return;
        }
        if (!res.write(chunk)) {
          upRes.pause();
          res.once("drain", () => upRes.resume());
        }
      });
      upRes.on("end", () => {
        clearTimeout(overall);
        res.end();
        finish(upRes.statusCode ?? 200);
      });
      upRes.on("error", () => {
        clearTimeout(overall);
        res.destroy();
        finish(502, "upstream-error");
      });
    });
    upstream.end();
  }

  server.on("connect", (req, duplex: Duplex, head: Buffer) => {
    const clientSocket = duplex as net.Socket;
    // From the moment it's accepted: a client resetting while it's refused (or before the tunnel's own handlers are
    // attached) must not be an unhandled error that stops the proxy.
    clientSocket.on("error", () => clientSocket.destroy());
    void handleConnect(req, clientSocket, head).catch(() => {
      if (clientSocket.writable) rawResponse(clientSocket, 502, "Bad Gateway", "Proxy error.");
      else clientSocket.destroy();
    });
  });

  async function handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const started = Date.now();
    let host = "";
    let port = 0;
    const authority = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!authority || Number(authority[2]) < 1 || Number(authority[2]) > 65535) {
      deny("bad-connect-target", { method: "CONNECT" });
      rawResponse(clientSocket, 400, "Bad Request", "CONNECT needs host:port.");
      return;
    }
    host = authority[1]!.replace(/^\[|\]$/g, "").toLowerCase();
    port = Number(authority[2]);
    const fields: LogEvent = { method: "CONNECT", host, port };
    const decision = await decide(host, port, true);
    if (!decision.ok) {
      if (decision.status === 403) deny(decision.reason, fields);
      else log({ event: "proxy.error", reason: decision.reason, ...fields });
      rawResponse(clientSocket, decision.status, decision.status === 403 ? "Forbidden" : decision.status === 504 ? "Gateway Timeout" : "Bad Gateway", decision.message);
      return;
    }
    stats.allowed.add();
    let up = 0;
    let down = 0;
    let closed = false;
    const upstream = net.connect({ host, port, lookup: boundLookup(decision.addresses), autoSelectFamily: true, timeout: limits.connectTimeoutMs });
    const close = (status: number, note?: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(lifetime);
      upstream.destroy();
      clientSocket.destroy();
      log({ event: "proxy.done", ...fields, status, up, down, ms: Date.now() - started, ...(note ? { note } : {}) });
    };
    const lifetime = setTimeout(() => close(504, "tunnel-lifetime"), limits.maxTunnelMs);
    upstream.once("connect", () => {
      const remote = upstream.remoteAddress;
      if (remote && !deps.testAllowAddress?.(remote) && !classifyAddress(remote).allowed) {
        deny("connected-address", fields);
        rawResponse(clientSocket, 403, "Forbidden", "Blocked by egress policy: private or internal destination.");
        close(403, "connected-address");
        return;
      }
      upstream.setTimeout(limits.idleTimeoutMs);
      clientSocket.setTimeout(limits.idleTimeoutMs);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
        up += head.length;
      }
      clientSocket.on("data", (chunk: Buffer) => {
        up += chunk.length;
        if (up + down > limits.maxTunnelBytes) return close(502, "tunnel-bytes");
        if (!upstream.write(chunk)) {
          clientSocket.pause();
          upstream.once("drain", () => clientSocket.resume());
        }
      });
      upstream.on("data", (chunk: Buffer) => {
        down += chunk.length;
        if (up + down > limits.maxTunnelBytes) return close(502, "tunnel-bytes");
        if (!clientSocket.write(chunk)) {
          upstream.pause();
          clientSocket.once("drain", () => upstream.resume());
        }
      });
      upstream.on("end", () => close(200));
      clientSocket.on("end", () => close(200));
    });
    upstream.on("timeout", () => close(504, "timeout"));
    clientSocket.on("timeout", () => close(504, "idle-timeout"));
    upstream.on("error", () => {
      if (!closed && !upstream.remoteAddress) rawResponse(clientSocket, 502, "Bad Gateway", "The destination could not be reached.");
      close(502, "unreachable");
    });
    clientSocket.on("error", () => close(499, "client-error"));
    clientSocket.on("close", () => close(499, "client-closed"));
  }

  return server;
}
