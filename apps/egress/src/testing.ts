import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { EgressConfig } from "./config.ts";

/* Test helpers for the egress service. Not imported by production code. */

export const TOKEN = "t".repeat(48);
export const allowLoopback = (ip: string): boolean => ip === "127.0.0.1";

export type ConfigOverrides = Omit<Partial<EgressConfig>, "limits"> & { limits?: Partial<EgressConfig["limits"]> };

export function makeConfig(over: ConfigOverrides = {}): EgressConfig {
  return {
    proxy: { host: "127.0.0.1", port: 0 },
    gateway: { host: "127.0.0.1", port: 0 },
    control: { host: "127.0.0.1", port: 0 },
    bridge: null,
    dataDir: "/nonexistent",
    serviceToken: TOKEN,
    gatewayDbPath: ":memory:",
    internalDestinations: [],
    ...over,
    limits: {
      maxConnections: 64,
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      requestTimeoutMs: 10_000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxRequestBodyBytes: 1024 * 1024,
      maxTunnelBytes: 8 * 1024 * 1024,
      maxTunnelMs: 10_000,
      ...over.limits,
    },
  };
}

export type Upstream = { port: number; requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[]; close: () => Promise<void> };

export async function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  const sockets = new Set<net.Socket>();
  const api: Upstream = { port: 0, requests: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    api.requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers });
    handler(req, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.port = (server.address() as AddressInfo).port;
  api.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return api;
}

export type ProxyReply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; error?: string };

/** Send an absolute-form request to the proxy, as a client configured to use it would. */
export function viaProxy(proxyPort: number, target: string, opts: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<ProxyReply> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: opts.method ?? "GET", path: target, headers: { ...(/^https?:\/\//.test(target) ? { host: new URL(target).host } : {}), ...opts.headers }, agent: false, timeout: opts.timeoutMs ?? 8000 });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), error: e.message }));
      res.on("aborted", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), error: "aborted" }));
    });
    req.on("timeout", () => req.destroy(new Error("test timeout")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    req.end();
  });
}

/** Raw CONNECT; resolves with the status line and the live socket. */
export function connectVia(proxyPort: number, authority: string): Promise<{ status: number; socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.subarray(0, end).toString())?.[1] ?? 0);
      resolve({ status, socket, rest: buf.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(5000, () => reject(new Error("connect timeout")));
  });
}

export async function startEcho(): Promise<{ port: number; connections: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const state = { port: 0, connections: 0, close: async () => {} };
  const server = net.createServer((s) => {
    state.connections++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    s.on("data", (d) => s.write(d));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

export type ControlReply = { status: number; json: any };

/** `connect`: the address to connect to (default loopback); `host`: the Host header to send (default loopback on `port`). */
export function control(port: number, method: string, path: string, opts: { body?: unknown; token?: string | null; host?: string; connect?: string } = {}): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: opts.connect ?? "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export type GatewayReply = { status: number; headers: http.IncomingHttpHeaders; body: string };

export function gatewayGet(port: number, path: string, opts: { user?: string; pass?: string; headers?: Record<string, string>; method?: string } = {}): Promise<GatewayReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.user !== undefined) headers.authorization = `Basic ${Buffer.from(`${opts.user}:${opts.pass ?? ""}`).toString("base64")}`;
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
