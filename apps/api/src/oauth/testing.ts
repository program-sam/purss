import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setClientFetchForTests } from "./clients.ts";

/*
 * Test support for the OAuth server (plan/33): a local HTTPS server that plays the assistant's
 * side (its client metadata documents), reached through safeFetch's in-process test hooks, so the
 * real fetch path with its address, size, time and redirect rules is what runs. Host names in
 * CLIENT_HOSTS resolve to 127.0.0.1 only through the resolver given here. Needs openssl to make a
 * throwaway certificate.
 */

export const CLIENT_HOSTS = ["assistant.example", "other.example"] as const;
// RFC 7636 appendix B.
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

export type ClientSite = {
  /** https://assistant.example:<port> */
  origin: (host?: (typeof CLIENT_HOSTS)[number]) => string;
  /** Answer a path with a handler; replaces an earlier one. */
  route: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
  /** Serve a metadata document whose client_id is its own URL; returns that URL. */
  document: (path: string, doc: Record<string, unknown>, headers?: Record<string, string>) => string;
  hits: (path: string) => number;
  close: () => Promise<void>;
};

export async function startClientSite(): Promise<ClientSite> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-oauth-tls-"));
  let key: Buffer;
  let cert: Buffer;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2",
      "-subj", "/CN=assistant.example", "-addext", `subjectAltName=${CLIENT_HOSTS.map((h) => `DNS:${h}`).join(",")}`], { stdio: "ignore" });
    key = readFileSync(path.join(dir, "k.pem"));
    cert = readFileSync(path.join(dir, "c.pem"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  const counts = new Map<string, number>();
  const server = https.createServer({ key, cert }, (req, res) => {
    const p = new URL(req.url ?? "/", "https://x").pathname;
    counts.set(p, (counts.get(p) ?? 0) + 1);
    const h = routes.get(p);
    if (h) h(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  setClientFetchForTests({
    resolver: async (host) => ((CLIENT_HOSTS as readonly string[]).includes(host) ? ["127.0.0.1"] : ["10.0.0.7"]),
    testAllowAddress: (ip) => ip === "127.0.0.1",
    testTlsCa: cert,
  });
  const origin = (host: string = CLIENT_HOSTS[0]) => `https://${host}:${port}`;
  return {
    origin,
    route: (p, handler) => { routes.set(p, handler); },
    document: (p, doc, headers = {}) => {
      const id = `${origin()}${p}`;
      routes.set(p, (_req, res) => {
        const body = JSON.stringify({ client_id: id, ...doc });
        res.writeHead(200, { "content-type": "application/json", ...headers }).end(body);
      });
      return id;
    },
    hits: (p) => counts.get(p) ?? 0,
    close: () => new Promise<void>((resolve) => {
      setClientFetchForTests({});
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
