import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError, type FcmConfig } from "./config.ts";
import { base64url, SEND_TIMEOUT_MS, type LogEvent, type Provider, type SendOutcome } from "./provider.ts";
import type { Clock } from "./store.ts";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

interface Credentials {
  projectId: string;
  clientEmail: string;
  tokenUri: string;
  key: KeyObject;
}

function loadCredentials(file: string): Credentials {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`FCM credentials ${file} cannot be read as JSON: ${(error as Error).message}`);
  }
  const field = (name: string): string => {
    const value = json?.[name];
    if (typeof value !== "string" || !value) throw new ConfigError(`FCM credentials ${file} lack "${name}"`);
    return value;
  };
  const projectId = field("project_id");
  const clientEmail = field("client_email");
  const tokenUri = field("token_uri");
  let key: KeyObject;
  try {
    key = createPrivateKey(field("private_key"));
  } catch {
    throw new ConfigError(`FCM credentials ${file} hold an unreadable private_key`);
  }
  return { projectId, clientEmail, tokenUri, key };
}

/** FCM HTTP v1 through a service account: a signed JWT is traded for a short-lived access token. */
export function createFcm(config: FcmConfig, clock: Clock, log: (event: LogEvent) => void = () => {}): Provider {
  const credentials = loadCredentials(config.credentials);
  let cached: { value: string; expiresAt: number } | null = null;
  let pending: Promise<string | null> | null = null;

  async function fetchAccessToken(): Promise<string | null> {
    const iat = Math.floor(clock() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({ iss: credentials.clientEmail, scope: SCOPE, aud: credentials.tokenUri, iat, exp: iat + 3600 }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), credentials.key);
    const assertion = `${header}.${claims}.${base64url(signature)}`;
    try {
      const response = await fetch(credentials.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
      if (!response.ok || typeof body?.access_token !== "string") {
        log({ event: "fcm.auth_failed", status: response.status });
        return null;
      }
      const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
      cached = { value: body.access_token, expiresAt: clock() + Math.max(0, lifetime - 60) * 1000 };
      return cached.value;
    } catch {
      log({ event: "fcm.auth_failed", status: 0 });
      return null;
    }
  }

  function accessToken(): Promise<string | null> {
    if (cached && clock() < cached.expiresAt) return Promise.resolve(cached.value);
    pending ??= fetchAccessToken().finally(() => { pending = null; });
    return pending;
  }

  async function post(token: string, bearer: string): Promise<{ status: number; body: unknown } | null> {
    try {
      const response = await fetch(`${config.url.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          message: { token, data: { purss: "1" }, android: { priority: "HIGH", ttl: "86400s", collapse_key: "purss" } },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return null;
    }
  }

  function unregistered(body: unknown): boolean {
    const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
    return Array.isArray(details) && details.some((d) => (d as { errorCode?: unknown } | null)?.errorCode === "UNREGISTERED");
  }

  return {
    async send(token): Promise<SendOutcome> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const bearer = await accessToken();
        if (!bearer) return { status: "transient" };
        const result = await post(token, bearer);
        if (!result) {
          log({ event: "fcm.unreachable" });
          return { status: "transient" };
        }
        if (result.status === 401 && attempt === 0) {
          cached = null;
          continue;
        }
        if (result.status === 200) return { status: "ok" };
        if (result.status === 404 || unregistered(result.body)) return { status: "gone" };
        log({ event: "fcm.rejected", status: result.status });
        return { status: "transient" };
      }
      return { status: "transient" };
    },
    close() {},
  };
}
