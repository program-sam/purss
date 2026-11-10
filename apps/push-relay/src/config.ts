import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {}

export interface FcmConfig {
  credentials: string;
  url: string;
}

export interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  url: string;
  /** Empty when the sandbox fallback is switched off. */
  sandboxUrl: string;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  secretFile: string;
  trustProxy: boolean;
  /** Null when the platform's credentials are not configured: that platform is unavailable. */
  fcm: FcmConfig | null;
  apns: ApnsConfig | null;
}

const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/push-relay");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const text = (name: string, fallback: string): string => env[name]?.trim() || fallback;
  const port = Number(text("PURSS_RELAY_PORT", "8950"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PURSS_RELAY_PORT must be a port number");
  const dataDir = path.resolve(text("PURSS_RELAY_DATA_DIR", DEFAULT_DATA_DIR));

  const fcmFile = env.PURSS_RELAY_FCM_CREDENTIALS?.trim();
  const fcm = fcmFile ? { credentials: fcmFile, url: text("PURSS_RELAY_FCM_URL", "https://fcm.googleapis.com") } : null;

  const apnsKey = env.PURSS_RELAY_APNS_KEY?.trim();
  const keyId = env.PURSS_RELAY_APNS_KEY_ID?.trim();
  const teamId = env.PURSS_RELAY_APNS_TEAM_ID?.trim();
  let apns: ApnsConfig | null = null;
  if (apnsKey || keyId || teamId) {
    if (!apnsKey || !keyId || !teamId) {
      throw new ConfigError("APNs needs PURSS_RELAY_APNS_KEY, PURSS_RELAY_APNS_KEY_ID and PURSS_RELAY_APNS_TEAM_ID together");
    }
    apns = {
      key: apnsKey,
      keyId,
      teamId,
      topic: text("PURSS_RELAY_APNS_TOPIC", "app.purss"),
      url: text("PURSS_RELAY_APNS_URL", "https://api.push.apple.com"),
      sandboxUrl: (env.PURSS_RELAY_APNS_SANDBOX_URL ?? "https://api.sandbox.push.apple.com").trim(),
    };
  }

  return {
    host: text("PURSS_RELAY_HOST", "127.0.0.1"),
    port,
    dataDir,
    secretFile: path.resolve(text("PURSS_RELAY_SECRET_FILE", path.join(dataDir, "handle-secret"))),
    trustProxy: env.PURSS_RELAY_TRUST_PROXY === "1",
    fcm,
    apns,
  };
}

/** Reads the handle secret, creating it (32 random bytes, mode 0600) on first start. */
export function loadHandleSecret(file: string): Buffer {
  try {
    return checkSecret(readFileSync(file), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(file, 0o600);
  return checkSecret(readFileSync(file), file);
}

function checkSecret(secret: Buffer, file: string): Buffer {
  if (secret.length < 32) throw new ConfigError(`${file} must hold at least 32 bytes`);
  return secret;
}
