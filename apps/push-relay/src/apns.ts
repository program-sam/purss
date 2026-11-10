import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import http2, { type ClientHttp2Session } from "node:http2";
import { ConfigError, type ApnsConfig } from "./config.ts";
import { base64url, SEND_TIMEOUT_MS, type LogEvent, type Provider, type SendOutcome } from "./provider.ts";
import type { ApnsEnv, Clock } from "./store.ts";

/** Apple wants a provider token reused for 20 to 60 minutes. */
const JWT_LIFETIME_MS = 30 * 60_000;

/** The neutral text shown if the app's notification extension cannot fetch the real one. */
const PAYLOAD = JSON.stringify({
  aps: { alert: { title: "PURSS", body: "You have something new in your PURSS." }, "mutable-content": 1, sound: "default" },
});

type Attempt = "ok" | "gone" | "bad_token" | "transient";

/** APNs token-based provider over one reused HTTP/2 session per server. */
export function createApns(config: ApnsConfig, clock: Clock, log: (event: LogEvent) => void = () => {}): Provider {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(config.key));
  } catch (error) {
    throw new ConfigError(`APNs key ${config.key} cannot be read as a PEM private key: ${(error as Error).message}`);
  }
  if (key.asymmetricKeyType !== "ec") throw new ConfigError(`APNs key ${config.key} is not an EC (P-256) key`);

  let jwt: { value: string; at: number } | null = null;
  const sessions = new Map<string, ClientHttp2Session>();

  function providerToken(): string {
    if (jwt && clock() - jwt.at < JWT_LIFETIME_MS) return jwt.value;
    const now = clock();
    const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
    const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
    jwt = { value: `${header}.${claims}.${base64url(signature)}`, at: now };
    return jwt.value;
  }

  function session(base: string): ClientHttp2Session {
    const open = sessions.get(base);
    if (open && !open.closed && !open.destroyed) return open;
    const fresh = http2.connect(base);
    fresh.on("error", () => {});
    fresh.on("close", () => { if (sessions.get(base) === fresh) sessions.delete(base); });
    fresh.unref();
    sessions.set(base, fresh);
    return fresh;
  }

  function request(base: string, token: string, bearer: string): Promise<{ status: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const client = session(base);
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => { done(() => reject(new Error("timeout"))); stream?.close(); client.destroy(); }, SEND_TIMEOUT_MS);
      let stream: http2.ClientHttp2Stream | undefined;
      try {
        stream = client.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${bearer}`,
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(clock() / 1000) + 86_400),
          "content-type": "application/json",
        });
      } catch (error) {
        done(() => reject(error));
        return;
      }
      let status = 0;
      const chunks: Buffer[] = [];
      stream.on("response", (headers) => { status = Number(headers[":status"]); });
      stream.on("data", (chunk: Buffer) => { if (chunks.length < 16) chunks.push(chunk); });
      stream.on("end", () => {
        let reason = "";
        try { reason = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: unknown }).reason ?? ""); } catch { /* empty body */ }
        done(() => resolve({ status, reason }));
      });
      stream.on("error", (error) => done(() => reject(error)));
      stream.on("close", () => done(() => reject(new Error("stream closed"))));
      stream.end(PAYLOAD);
    });
  }

  async function attempt(base: string, token: string): Promise<Attempt> {
    for (let round = 0; round < 2; round += 1) {
      let result;
      try {
        result = await request(base, token, providerToken());
      } catch {
        log({ event: "apns.unreachable" });
        return "transient";
      }
      if (result.status === 200) return "ok";
      if (result.status === 410) return "gone";
      if (result.status === 400 && result.reason === "BadDeviceToken") return "bad_token";
      if (result.status === 403 && result.reason === "ExpiredProviderToken" && round === 0) {
        jwt = null;
        continue;
      }
      log({ event: "apns.rejected", status: result.status, reason: result.reason });
      return "transient";
    }
    return "transient";
  }

  return {
    async send(token: string, env: ApnsEnv): Promise<SendOutcome> {
      const first = await attempt(env === "sandbox" && config.sandboxUrl ? config.sandboxUrl : config.url, token);
      if (first === "ok") return { status: "ok" };
      if (first === "gone") return { status: "gone" };
      if (first === "transient") return { status: "transient" };
      // Rejected as a bad token: it may be a development build whose token belongs to the sandbox.
      if (env === "production" && config.sandboxUrl) {
        const second = await attempt(config.sandboxUrl, token);
        if (second === "ok") return { status: "ok", env: "sandbox" };
        if (second === "transient") return { status: "transient" };
      }
      return { status: "gone" };
    },
    close() {
      for (const client of sessions.values()) client.destroy();
      sessions.clear();
    },
  };
}
