import { generateKeyPairSync, createHash, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApns } from "./apns.ts";
import { createFcm } from "./fcm.ts";
import type { Provider } from "./provider.ts";
import { createRelay } from "./server.ts";
import { Store } from "./store.ts";

/* Test helpers: fake push services on loopback, a relay wired to them, and a small HTTP client. */

export interface Reply {
  status: number;
  body?: unknown;
}

export interface FakeFcm {
  url: string;
  messages: unknown[];
  tokenRequests: number;
  /** Replies used (in order) instead of success for the next sends. */
  replies: Reply[];
  /** Makes every access token handed out so far invalid, so the next send gets a 401. */
  revokeTokens(): void;
  /** Problems found in what the relay sent. */
  problems: string[];
  close(): Promise<void>;
}

export interface ApnsCall {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

export interface FakeApns {
  url: string;
  calls: ApnsCall[];
  /** Decides each reply; default is 200. */
  reply: (call: ApnsCall, n: number) => Reply;
  problems: string[];
  close(): Promise<void>;
}

export const SERVICE_ACCOUNT = { project: "test-project", email: "relay@test-project.iam.example" };
export const APNS = { keyId: "KEYID12345", teamId: "TEAMID1234", topic: "app.purss" };

export function tempDir(): { dir: string; remove(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-relay-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function listen(server: http.Server | http2.Http2Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: Buffer; signature: Buffer } | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString()),
      claims: JSON.parse(Buffer.from(parts[1]!, "base64url").toString()),
      signed: Buffer.from(`${parts[0]}.${parts[1]}`),
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return null;
  }
}

/** Fake Google OAuth token endpoint and FCM v1 endpoint on one server. */
export async function startFakeFcm(publicKey: KeyObject): Promise<FakeFcm & { tokenUri: string }> {
  const valid = new Set<string>();
  const fake = { messages: [] as unknown[], tokenRequests: 0, replies: [] as Reply[], problems: [] as string[] } as FakeFcm & { tokenUri: string };
  let tokenUri = "";
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/token") {
      fake.tokenRequests += 1;
      const form = new URLSearchParams(body);
      const jwt = decodeJwt(form.get("assertion") ?? "");
      const ok = form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && jwt !== null
        && jwt.header.alg === "RS256"
        && verify("RSA-SHA256", jwt.signed, publicKey, jwt.signature)
        && jwt.claims.iss === SERVICE_ACCOUNT.email && jwt.claims.aud === tokenUri
        && jwt.claims.scope === "https://www.googleapis.com/auth/firebase.messaging"
        && Number(jwt.claims.exp) - Number(jwt.claims.iat) === 3600;
      if (!ok) { fake.problems.push("bad assertion"); return json(400, { error: "invalid_grant" }); }
      const access = `access-${fake.tokenRequests}`;
      valid.add(access);
      return json(200, { access_token: access, expires_in: 3600, token_type: "Bearer" });
    }
    if (req.method === "POST" && req.url === `/v1/projects/${SERVICE_ACCOUNT.project}/messages:send`) {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization))?.[1];
      if (!bearer || !valid.has(bearer)) return json(401, { error: { status: "UNAUTHENTICATED" } });
      fake.messages.push(JSON.parse(body));
      const reply = fake.replies.shift();
      return json(reply?.status ?? 200, reply?.body ?? { name: "projects/test-project/messages/1" });
    }
    json(404, {});
  });
  const port = await listen(server);
  tokenUri = `http://127.0.0.1:${port}/token`;
  fake.url = `http://127.0.0.1:${port}`;
  fake.tokenUri = tokenUri;
  fake.revokeTokens = () => valid.clear();
  fake.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

/** Fake APNs over cleartext HTTP/2 that checks the provider token's signature. */
export async function startFakeApns(publicKey: KeyObject): Promise<FakeApns> {
  const fake: FakeApns = { url: "", calls: [], reply: () => ({ status: 200 }), problems: [], close: async () => {} };
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
    session.on("stream", (stream, headers) => onStream(stream, headers));
  });
  const onStream = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const call: ApnsCall = { path: String(headers[":path"]), headers, body: Buffer.concat(chunks).toString("utf8") };
      fake.calls.push(call);
      const jwt = decodeJwt(String(headers.authorization).replace(/^bearer /, ""));
      const authentic = jwt !== null && jwt.header.alg === "ES256" && jwt.header.kid === APNS.keyId && jwt.claims.iss === APNS.teamId
        && verify("sha256", jwt.signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, jwt.signature);
      if (!authentic) fake.problems.push("bad provider token");
      const reply = fake.reply(call, fake.calls.length);
      stream.respond({ ":status": reply.status, "content-type": "application/json" });
      stream.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  };
  const port = await listen(server);
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise((resolve) => { for (const s of sessions) s.destroy(); server.close(() => resolve()); });
  return fake;
}

export interface Harness {
  base: string;
  store: Store;
  dir: string;
  /** Mutable clock: advance with `clock.now += ms`. */
  clock: { now: number };
  counts: Record<string, number>;
  logs: string[];
  fcm?: FakeFcm;
  apns?: FakeApns;
  sandbox?: FakeApns;
  stop(): Promise<void>;
}

/** A relay on 127.0.0.1:0 with a temp data directory, wired to whichever fakes are asked for. */
export async function startHarness(options: { fcm?: boolean; apns?: boolean; sandbox?: boolean; trustProxy?: boolean } = {}): Promise<Harness> {
  const temp = tempDir();
  const clock = { now: Date.now() };
  const providers: { fcm?: Provider; apns?: Provider } = {};
  const logs: string[] = [];
  const log = (event: { event: string }) => logs.push(JSON.stringify(event));
  const harness = { base: "", dir: temp.dir, clock, counts: {}, logs } as Harness;
  const now = () => clock.now;

  if (options.fcm) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fake = await startFakeFcm(publicKey);
    const credentials = path.join(temp.dir, "fcm.json");
    writeFileSync(credentials, JSON.stringify({
      project_id: SERVICE_ACCOUNT.project, client_email: SERVICE_ACCOUNT.email, token_uri: fake.tokenUri,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }));
    harness.fcm = fake;
    providers.fcm = createFcm({ credentials, url: fake.url }, now, log);
  }
  if (options.apns) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const key = path.join(temp.dir, "apns.p8");
    writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }));
    harness.apns = await startFakeApns(publicKey);
    if (options.sandbox) harness.sandbox = await startFakeApns(publicKey);
    providers.apns = createApns({ key, keyId: APNS.keyId, teamId: APNS.teamId, topic: APNS.topic, url: harness.apns.url, sandboxUrl: harness.sandbox?.url ?? "" }, now, log);
  }

  harness.store = new Store(path.join(temp.dir, "relay.db"));
  const server = createRelay({
    store: harness.store, providers, clock: now, config: { trustProxy: options.trustProxy ?? false },
    secret: Buffer.alloc(32, 7), log,
    count: (outcome) => { harness.counts[outcome] = (harness.counts[outcome] ?? 0) + 1; },
  });
  const port = await listen(server);
  harness.base = `http://127.0.0.1:${port}`;
  harness.stop = async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    providers.fcm?.close();
    providers.apns?.close();
    harness.store.close();
    await harness.fcm?.close();
    await harness.apns?.close();
    await harness.sandbox?.close();
    temp.remove();
  };
  return harness;
}

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

/** Plain HTTP client (fetch would refuse to send some of the headers these tests need). */
export function call(base: string, method: string, pathname: string, options: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...options.headers };
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const FCM_TOKEN = "fcm-token-AAAAAAAAAAAAAAAAAAAA:bbbb_cccc";
export const APNS_TOKEN = "ab".repeat(32);
export const SCOPE = "scope_AAAAAAAAAAAAAAAAAAAAAA";
