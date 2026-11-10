import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseBridgeDescriptor } from "@purss/connectors";
import type { App } from "../app.ts";
import { ensureDir, readSecret } from "../secrets.ts";

/** The same address in a form that doesn't depend on the host's case, a fragment or a trailing slash. */
export function canonicalFeedKey(href: string): string {
  const u = new URL(href);
  const path = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** A bridged source's descriptor (`bridge:telegram/durov`, plan/41) when it names a catalogued service and key, else null. */
export function bridgeAddress(value: string | null | undefined): string | null {
  return value && parseBridgeDescriptor(value) ? value.trim() : null;
}

const KEY_FILE = "feed-key";
/** What is hashed, so that a change to it (the workspace was added to it) is noticed and every key is made again. */
const SCHEME = "purss feed key v2: workspace and canonical address";
/** The database remembers which key made its keys, as a fingerprint that says nothing about the key. */
const FINGERPRINT_ROW = "feed_key_check";
/** A whole key is 32 random bytes in base64url. */
const MIN_KEY_CHARS = 40;

const keys = new WeakMap<App, string>();

/** Write a file whole or not at all: a crash leaves the old file or the new one, never half of one. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${text}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * The key, made once and kept in the secrets folder. A missing or damaged file is made again (with a new key); what that does to the
 * keys already in the database is dealt with by `keyFor`, which compares the key with the fingerprint the database remembers.
 */
function readOrMakeKey(app: App): string {
  const existing = readSecret(app.config.secretsDir, KEY_FILE);
  if (existing && existing.length >= MIN_KEY_CHARS) return existing;
  ensureDir(app.config.secretsDir);
  const fresh = randomBytes(32).toString("base64url");
  writeAtomically(path.join(app.config.secretsDir, KEY_FILE), fresh);
  return fresh;
}

const fingerprintOf = (key: string): string => createHmac("sha256", key).update("fingerprint of the key that makes private feed keys").digest("hex");

const hash = (key: string, workspaceId: string, canonical: string): string => createHmac("sha256", key).update(`${SCHEME}\n${workspaceId}\n${canonical}`).digest("hex");

/**
 * The key for this process. The first time it is asked for, it is checked against the fingerprint stored in the database. When
 * they differ the key file was lost, damaged or replaced (or the keys were made by an older scheme): every private source's key is
 * made again from its link file, and a source with no link file keeps none. That is said in the log, unless the database
 * had no fingerprint yet, which is the first run.
 */
function keyFor(app: App): string {
  const cached = keys.get(app);
  if (cached) return cached;
  const key = readOrMakeKey(app);
  const fingerprint = fingerprintOf(key);
  const stored = app.db.get<{ value: string }>("SELECT value FROM installation WHERE key = ?", FINGERPRINT_ROW)?.value ?? null;
  if (stored !== fingerprint) {
    if (stored !== null) {
      console.warn("[api] secrets/feed-key is not the key the private feed keys were made with (it was lost, damaged or replaced); making every private source's key again from its link file");
    }
    app.db.tx(() => {
      for (const s of app.db.all<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM sources WHERE is_private = 1")) {
        const link = readSecret(app.config.secretsDir, `source-urls/${s.id}`);
        let made: string | null = null;
        if (link) { try { made = hash(key, s.workspace_id, canonicalFeedKey(link)); } catch { made = null; } }
        app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", made, s.id);
      }
      app.db.run("INSERT INTO installation (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", FINGERPRINT_ROW, fingerprint);
    });
  }
  keys.set(app, key);
  return key;
}

/**
 * A keyed hash (HMAC-SHA-256, key from the secrets folder) of a feed address and the workspace that follows it: how a private
 * source, which has no address in the database, is found again when the same link is looked up or listed a second time. The
 * workspace is part of it, so two accounts following the same link have unrelated keys. Nobody holding only the database can use
 * it to test a guessed link. Null for text that is no address.
 */
export function privateFeedKey(app: App, workspaceId: string, feedUrl: string): string | null {
  let canonical: string;
  try { canonical = canonicalFeedKey(feedUrl); } catch { return null; }
  return hash(keyFor(app), workspaceId, canonical);
}

