import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { newId } from "@purss/domain";
import type { SyncEntry } from "@purss/domain";
import type { App, Principal } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createAccount } from "./auth/accounts.ts";
import type { PreparedPassword } from "./auth/passwords.ts";
import { nowIso } from "./http.ts";

/** A real database in a temp directory, without network listeners. */
export function makeTestApp(env: Record<string, string> = {}): { app: App; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-api-test-"));
  const config = loadConfig({ PURSS_DATA_DIR: dir, PURSS_DISK_RESERVE_BYTES: "0", ...env });
  const db = openDatabase(config.dbFile);
  const app: App = { db, config, events: new EventEmitter(), serviceToken: "test-token" };
  return { app, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** The password of accounts made with testPassword. */
export const TEST_PASSWORD = "correct horse battery staple";
// A hash of TEST_PASSWORD at a low scrypt cost, so tests that need many accounts don't spend a second each hashing.
const TEST_HASH = "scrypt$1024$8$1$GnuUuWPbHDqwnElYXKC--Q$Z2tIGr5IkvymvbvhZPH5ldSC4PYRS12snDfxGmvonko";
/** What createAccount needs to give an account TEST_PASSWORD. */
export function testPassword(): PreparedPassword {
  return { hash: TEST_HASH };
}

let addresses = 0;
/** A new address for a test account. */
export function testEmail(name = "tester"): string {
  return `${name}${++addresses}@example.test`;
}

export function makeOwner(app: App, opts: { allocationBytes?: number | null; admin?: boolean } = {}): Principal & { engineUserId: string } {
  const { accountId, workspaceId } = app.db.tx(() => createAccount(app, { email: testEmail(), emailConfirmed: false, displayName: null, admin: opts.admin ?? true, allocationBytes: opts.allocationBytes ?? null, grantedBy: null, password: testPassword() }));
  const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
  app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
  return { accountId, workspaceId, isAdmin: opts.admin ?? true, sessionId: "test-session", csrf: "x", authAt: nowIso(), engineUserId: eu.id };
}

/** Insert a followed source with an engine stream, as if engine.subscribe had completed. */
export function makeSource(app: App, p: Principal, title: string, streamId: string, extra: { kind?: string; isPrivate?: boolean; settled?: boolean } = {}): string {
  const id = newId("src");
  // Established by default: its first sync is over, so what it brings is New. `settled: false` is a source just followed.
  app.db.run(
    "INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, feed_url, is_private, engine_stream_id, health, created_at, subscribed_at, backlog_settled_at) VALUES (?, ?, ?, ?, ?, 'RSS feed', ?, ?, ?, 'ok', ?, ?, ?)",
    id, p.accountId, p.workspaceId, extra.kind ?? "feed", title, extra.isPrivate ? null : `https://example.org/${streamId}.xml`, extra.isPrivate ? 1 : 0, streamId, nowIso(), nowIso(), extra.settled === false ? null : nowIso(),
  );
  return id;
}

let counter = 0;
export function entry(streamId: string, over: Partial<SyncEntry> = {}): SyncEntry {
  counter++;
  return {
    externalId: `tag:google.com,2005:reader/item/${counter.toString(16).padStart(16, "0")}`,
    streamId,
    originalGuid: `https://example.org/post/${counter}`,
    url: `https://example.org/post/${counter}`,
    title: `Post number ${counter}`,
    author: "A. Writer",
    publishedAt: new Date(Date.UTC(2026, 9, 1) + counter * 3600_000).toISOString(),
    crawledAt: new Date(Date.UTC(2026, 9, 1) + counter * 3600_000 + 60_000).toISOString(),
    summaryHtml: `<p>Summary of post ${counter} about tidal flats and sediment.</p>`,
    contentHtml: null,
    imageUrl: null,
    enclosures: [],
    ...over,
  };
}

export function batch(entries: SyncEntry[], key = newId("bat"), engineIdentity = "engine-A") {
  return { leaseId: "lease", idempotencyKey: key, engineIdentity, entries, checkpoint: { continuation: null, newestCrawlUsec: null }, done: true };
}
