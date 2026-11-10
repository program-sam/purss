import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SafeFetchResult } from "./safe-fetch.ts";

/*
 * Test helpers shared by the connector tests. Not exported from the package index.
 * Everything binds to 127.0.0.1 and is reached through the in-process
 * `testAllowAddress` allowance of the fetch layer.
 */

export const allowLoopback = (ip: string): boolean => ip === "127.0.0.1";

export type TestServer = {
  url: string;
  origin: string;
  port: number;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[];
  close: () => Promise<void>;
};

export async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, server: TestServer) => void): Promise<TestServer> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    api.requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers });
    handler(req, res, api);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const api: TestServer = {
    url: `http://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    port,
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  return api;
}

export function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(body);
}

/** A canned successful safeFetch result, for tests that stub the fetch layer. */
export function fakeResponse(url: string, body: string | Buffer, contentType: string, status = 200, extra: { redirects?: string[] } = {}): SafeFetchResult {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    ok: true,
    response: {
      url,
      requestedUrl: url,
      redirects: extra.redirects ?? [],
      status,
      headers: { "content-type": contentType },
      mediaType: contentType.split(";")[0]!.trim().toLowerCase(),
      contentType,
      body: buf,
      bytes: buf.length,
      truncated: false,
      remoteAddress: "93.184.216.34",
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function fakeFailure(reason: "blocked" | "unreachable" | "toolarge" | "timeout" | "invalid" | "aborted", message = "failure"): SafeFetchResult {
  return { ok: false, reason, message, detail: `${reason} (test)` };
}
