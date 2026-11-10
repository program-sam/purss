import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Clock = () => number;
export type Platform = "fcm" | "apns";
export type ApnsEnv = "production" | "sandbox";

export interface Device {
  key: string;
  platform: Platform;
  token: string;
  apnsEnv: ApnsEnv;
  createdAt: number;
  seenAt: number;
}

/** At most this many handles may point at one device token. */
const MAX_PER_TOKEN = 5;
const EXPIRY_MS = 180 * 86_400_000;

/**
 * Devices keyed by the SHA-256 of their handle. The handle itself is never stored, so a copy
 * of this file cannot be used to wake anything: it needs the handle, which only the app and
 * the PURSS it was given to hold.
 */
export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS devices (
        key TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('fcm', 'apns')),
        token TEXT NOT NULL,
        apns_env TEXT NOT NULL DEFAULT 'production' CHECK (apns_env IN ('production', 'sandbox')),
        created_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_token ON devices (platform, token);
      CREATE INDEX IF NOT EXISTS devices_seen ON devices (seen_at);
    `);
  }

  /** Adds the device or refreshes its seen time, then drops the oldest handles beyond five per token. */
  register(key: string, platform: Platform, token: string, now: number): void {
    this.#db.prepare(
      `INSERT INTO devices (key, platform, token, created_at, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET seen_at = excluded.seen_at`,
    ).run(key, platform, token, now, now);
    this.#db.prepare(
      `DELETE FROM devices WHERE platform = ? AND token = ? AND key NOT IN
         (SELECT key FROM devices WHERE platform = ? AND token = ? ORDER BY seen_at DESC, rowid DESC LIMIT ${MAX_PER_TOKEN})`,
    ).run(platform, token, platform, token);
  }

  get(key: string): Device | undefined {
    const row = this.#db.prepare("SELECT * FROM devices WHERE key = ?").get(key);
    if (!row) return undefined;
    return {
      key: String(row.key),
      platform: row.platform as Platform,
      token: String(row.token),
      apnsEnv: row.apns_env as ApnsEnv,
      createdAt: Number(row.created_at),
      seenAt: Number(row.seen_at),
    };
  }

  remove(key: string): void {
    this.#db.prepare("DELETE FROM devices WHERE key = ?").run(key);
  }

  touch(key: string, now: number): void {
    this.#db.prepare("UPDATE devices SET seen_at = ? WHERE key = ?").run(now, key);
  }

  setApnsEnv(key: string, env: ApnsEnv): void {
    this.#db.prepare("UPDATE devices SET apns_env = ? WHERE key = ?").run(env, key);
  }

  /** Deletes devices not seen for 180 days; returns how many. */
  expire(now: number): number {
    return Number(this.#db.prepare("DELETE FROM devices WHERE seen_at < ?").run(now - EXPIRY_MS).changes);
  }

  count(): number {
    return Number(this.#db.prepare("SELECT COUNT(*) AS n FROM devices").get()?.n ?? 0);
  }

  close(): void {
    this.#db.close();
  }
}
