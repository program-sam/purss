import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LIMITS } from "./types.ts";
import type { FeedState, GapRecord, GatewayAdapter, GatewayLimits, Health, RefreshResult, ServeResult, StagedEntry } from "./types.ts";
import { boundEntry, serializeFeed, serializeItem } from "./rss.ts";

/*
 * Private feed gateway core: feeds, revocable credentials, bounded staging with
 * acknowledgement, coverage-gap records, health, and RSS serving. State lives in the
 * egress process's own SQLite file (never the product database). Staged entries are
 * released only by an authenticated acknowledgement (or a recorded bound), never
 * because a response was served.
 */

export const FEED_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  feed_id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  title TEXT NOT NULL,
  site_url TEXT,
  description TEXT,
  params_json TEXT NOT NULL DEFAULT 'null',
  limits_json TEXT NOT NULL,
  cursor TEXT,
  cred_hash TEXT,
  cred_rotated_at INTEGER,
  prev_hash TEXT,
  prev_valid_until INTEGER,
  cred_revoked_at INTEGER,
  grant_state TEXT NOT NULL DEFAULT 'active',
  health_status TEXT NOT NULL DEFAULT 'ok',
  health_code TEXT,
  health_message TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_delivery_at INTEGER,
  retry_after_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS staged (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL REFERENCES feeds(feed_id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  limited INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  published_at TEXT,
  staged_at INTEGER NOT NULL,
  UNIQUE (feed_id, guid)
) STRICT;
CREATE INDEX IF NOT EXISTS staged_by_feed ON staged (feed_id, seq);
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT NOT NULL REFERENCES feeds(feed_id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_published TEXT,
  last_published TEXT,
  note TEXT
) STRICT;
`;

type FeedRow = {
  feed_id: string;
  adapter: string;
  title: string;
  site_url: string | null;
  description: string | null;
  params_json: string;
  limits_json: string;
  cursor: string | null;
  cred_hash: string | null;
  cred_rotated_at: number | null;
  prev_hash: string | null;
  prev_valid_until: number | null;
  cred_revoked_at: number | null;
  grant_state: string;
  health_status: string;
  health_code: string | null;
  health_message: string | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_delivery_at: number | null;
  retry_after_at: number | null;
  created_at: number;
};

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const hex = (value: string): string => sha256(value).toString("hex");
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const DUMMY = sha256("purss-gateway-dummy-credential");

export type UpsertFeed = {
  feedId: string;
  adapter: string;
  title: string;
  siteUrl?: string | null;
  description?: string | null;
  params?: unknown;
  limits?: Partial<GatewayLimits>;
};

export class GatewayError extends Error {
  code: "bad_request" | "not_found" | "unknown_adapter";
  constructor(code: "bad_request" | "not_found" | "unknown_adapter", message: string) {
    super(message);
    this.code = code;
  }
}

export type GatewayOptions = {
  db?: DatabaseSync;
  /** Path to the SQLite file, or ":memory:". Ignored when `db` is given. */
  path?: string;
  adapters?: readonly GatewayAdapter[];
  now?: () => number;
  /** Provider call budget per refresh. */
  refreshTimeoutMs?: number;
};

export class GatewayService {
  readonly db: DatabaseSync;
  #adapters = new Map<string, GatewayAdapter>();
  #now: () => number;
  #refreshTimeoutMs: number;
  #inflight = new Map<string, Promise<void>>();

  constructor(opts: GatewayOptions = {}) {
    this.db = opts.db ?? new DatabaseSync(opts.path ?? ":memory:");
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if ((opts.path ?? ":memory:") !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    for (const a of opts.adapters ?? []) this.#adapters.set(a.id, a);
    this.#now = opts.now ?? Date.now;
    this.#refreshTimeoutMs = opts.refreshTimeoutMs ?? 20_000;
  }

  close(): void {
    this.db.close();
  }

  adapterIds(): string[] {
    return [...this.#adapters.keys()];
  }

  // ---------- helpers ----------

  #tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #row(feedId: string): FeedRow | undefined {
    return this.db.prepare("SELECT * FROM feeds WHERE feed_id = ?").get(feedId) as FeedRow | undefined;
  }

  #limits(row: FeedRow): GatewayLimits {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(row.limits_json) as Partial<GatewayLimits>) };
  }

  #totals(feedId: string): { n: number; bytes: number; oldest: number | null; maxSeq: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, MIN(staged_at) AS oldest, COALESCE(MAX(seq),0) AS max_seq FROM staged WHERE feed_id = ?").get(feedId) as { n: number; bytes: number; oldest: number | null; max_seq: number };
    return { n: r.n, bytes: r.bytes, oldest: r.oldest, maxSeq: r.max_seq };
  }

  #recordGap(feedId: string, reason: GapRecord["reason"], rows: { published_at: string | null }[], note: string | null): void {
    const dates = rows.map((r) => r.published_at).filter((d): d is string => Boolean(d)).sort();
    this.db.prepare("INSERT INTO gaps (feed_id, at, reason, count, first_published, last_published, note) VALUES (?,?,?,?,?,?,?)").run(feedId, this.#now(), reason, rows.length, dates[0] ?? null, dates.at(-1) ?? null, note);
  }

  #health(row: FeedRow): Health {
    return {
      status: row.health_status as Health["status"],
      code: row.health_code,
      message: row.health_message,
      lastRefreshAttemptAt: iso(row.last_attempt_at),
      lastProviderSuccessAt: iso(row.last_success_at),
      lastDeliveryAt: iso(row.last_delivery_at),
    };
  }

  #setHealth(feedId: string, status: Health["status"], code: string | null, message: string | null): void {
    this.db.prepare("UPDATE feeds SET health_status = ?, health_code = ?, health_message = ? WHERE feed_id = ?").run(status, code, message, feedId);
  }

  // ---------- feed lifecycle ----------

  upsertFeed(input: UpsertFeed): FeedState {
    if (!FEED_ID.test(input.feedId)) throw new GatewayError("bad_request", "Feed ids are 8 to 64 letters, digits, - or _.");
    if (!this.#adapters.has(input.adapter)) throw new GatewayError("unknown_adapter", `No connector named "${input.adapter}" is available in this installation.`);
    const title = (input.title ?? "").trim();
    if (!title || title.length > 300) throw new GatewayError("bad_request", "A feed needs a title of up to 300 characters.");
    const limits: GatewayLimits = { ...DEFAULT_LIMITS };
    for (const [k, v] of Object.entries(input.limits ?? {})) {
      if (!(k in DEFAULT_LIMITS)) throw new GatewayError("bad_request", `Unknown limit "${k.slice(0, 40)}".`);
      limits[k as keyof GatewayLimits] = v as number;
    }
    for (const [k, v] of Object.entries(limits)) {
      if (!Number.isFinite(v) || v < 1) throw new GatewayError("bad_request", `Limit ${k} must be a positive number.`);
    }
    if (limits.maxEntries > 5000 || limits.maxBytes > 64 * 1024 * 1024 || limits.maxResponseBytes > 8 * 1024 * 1024 || limits.maxItemsPerResponse > 500) {
      throw new GatewayError("bad_request", "A limit is above the gateway's hard ceiling.");
    }
    this.#tx(() => {
      const existing = this.#row(input.feedId);
      if (existing && existing.adapter !== input.adapter) throw new GatewayError("bad_request", "A feed cannot change its connector; create a new feed instead.");
      if (existing) {
        this.db
          .prepare("UPDATE feeds SET title = ?, site_url = ?, description = ?, params_json = ?, limits_json = ? WHERE feed_id = ?")
          .run(title, input.siteUrl ?? null, input.description ?? null, JSON.stringify(input.params ?? null), JSON.stringify(limits), input.feedId);
      } else {
        this.db
          .prepare("INSERT INTO feeds (feed_id, adapter, title, site_url, description, params_json, limits_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(input.feedId, input.adapter, title, input.siteUrl ?? null, input.description ?? null, JSON.stringify(input.params ?? null), JSON.stringify(limits), this.#now());
      }
    });
    this.#sweep(input.feedId);
    return this.state(input.feedId)!;
  }

  deleteFeed(feedId: string): boolean {
    return this.db.prepare("DELETE FROM feeds WHERE feed_id = ?").run(feedId).changes > 0;
  }

  state(feedId: string): FeedState | null {
    const row = this.#row(feedId);
    if (!row) return null;
    const totals = this.#totals(feedId);
    const gaps = this.db.prepare("SELECT * FROM gaps WHERE feed_id = ? ORDER BY id DESC LIMIT 50").all(feedId) as { id: number; at: number; reason: GapRecord["reason"]; count: number; first_published: string | null; last_published: string | null; note: string | null }[];
    const now = this.#now();
    const active = row.cred_hash !== null && row.cred_revoked_at === null;
    return {
      feedId,
      adapter: row.adapter,
      title: row.title,
      grant: row.grant_state === "lost" ? "lost" : "active",
      credential: {
        status: active ? "active" : row.cred_revoked_at !== null ? "revoked" : "none",
        rotatedAt: iso(row.cred_rotated_at),
        previousValidUntil: row.prev_hash && row.prev_valid_until && row.prev_valid_until > now ? iso(row.prev_valid_until) : null,
      },
      staged: { entries: totals.n, bytes: totals.bytes, oldestStagedAt: iso(totals.oldest) },
      health: this.#health(row),
      gaps: gaps.map((g) => ({ id: g.id, at: iso(g.at)!, reason: g.reason, count: g.count, firstPublishedAt: g.first_published, lastPublishedAt: g.last_published, note: g.note })),
    };
  }

  summary(): { feeds: number; stagedEntries: number; adapters: string[] } {
    const f = this.db.prepare("SELECT COUNT(*) AS n FROM feeds").get() as { n: number };
    const s = this.db.prepare("SELECT COUNT(*) AS n FROM staged").get() as { n: number };
    return { feeds: f.n, stagedEntries: s.n, adapters: this.adapterIds() };
  }

  // ---------- credentials ----------

  /**
   * Issue (or rotate) the feed's credential. The secret is returned once and only its
   * hash is stored. A grace period keeps the previous secret valid so the engine can
   * be reconfigured without a gap.
   */
  issueCredential(feedId: string, opts: { graceSeconds?: number } = {}): { username: string; secret: string; rotatedAt: string } {
    const row = this.#row(feedId);
    if (!row) throw new GatewayError("not_found", "No such feed.");
    if (row.grant_state === "lost") throw new GatewayError("bad_request", "This source's permission was removed; reconnect it before issuing a new credential.");
    const grant = Math.max(0, Math.min(opts.graceSeconds ?? 0, 7 * 86_400));
    const secret = `purssg_${randomBytes(32).toString("base64url")}`;
    const now = this.#now();
    const keepPrevious = grant > 0 && row.cred_hash !== null && row.cred_revoked_at === null;
    this.db
      .prepare("UPDATE feeds SET cred_hash = ?, cred_rotated_at = ?, cred_revoked_at = NULL, prev_hash = ?, prev_valid_until = ? WHERE feed_id = ?")
      .run(hex(secret), now, keepPrevious ? row.cred_hash : null, keepPrevious ? now + grant * 1000 : null, feedId);
    return { username: feedId, secret, rotatedAt: new Date(now).toISOString() };
  }

  revokeCredential(feedId: string): boolean {
    const r = this.db.prepare("UPDATE feeds SET cred_hash = NULL, prev_hash = NULL, prev_valid_until = NULL, cred_revoked_at = ? WHERE feed_id = ?").run(this.#now(), feedId);
    return r.changes > 0;
  }

  /**
   * Constant-time check of Basic credentials: the user name must be the feed id and the
   * password a live secret for that feed. Unknown feeds cost the same as wrong secrets.
   */
  authenticate(feedId: string, username: string, password: string): boolean {
    const row = FEED_ID.test(feedId) ? this.#row(feedId) : undefined;
    const given = sha256(password);
    const userOk = timingSafeEqual(sha256(username), sha256(feedId));
    let match = false;
    const candidates: Buffer[] = [];
    if (row && row.cred_hash && row.cred_revoked_at === null) candidates.push(Buffer.from(row.cred_hash, "hex"));
    if (row && row.prev_hash && row.prev_valid_until && row.prev_valid_until > this.#now()) candidates.push(Buffer.from(row.prev_hash, "hex"));
    if (candidates.length === 0) candidates.push(DUMMY);
    for (const c of candidates) {
      if (timingSafeEqual(given, c) && row) match = true;
    }
    return match && userOk;
  }

  // ---------- staging ----------

  #sweep(feedId: string): void {
    const row = this.#row(feedId);
    if (!row) return;
    const limits = this.#limits(row);
    this.#tx(() => {
      const cutoff = this.#now() - limits.maxAgeSeconds * 1000;
      const old = this.db.prepare("SELECT seq, published_at FROM staged WHERE feed_id = ? AND staged_at < ?").all(feedId, cutoff) as { seq: number; published_at: string | null }[];
      if (old.length) {
        this.db.prepare("DELETE FROM staged WHERE feed_id = ? AND staged_at < ?").run(feedId, cutoff);
        this.#recordGap(feedId, "age", old, "Entries were not acknowledged in time and were released.");
      }
      // Limits may have been lowered below what is staged.
      for (const [reason, over] of [
        ["entries", () => this.#totals(feedId).n > limits.maxEntries],
        ["bytes", () => this.#totals(feedId).bytes > limits.maxBytes],
      ] as const) {
        const released: { published_at: string | null }[] = [];
        while (over()) {
          const oldest = this.db.prepare("SELECT seq, published_at FROM staged WHERE feed_id = ? ORDER BY seq ASC LIMIT 1").get(feedId) as { seq: number; published_at: string | null } | undefined;
          if (!oldest) break;
          this.db.prepare("DELETE FROM staged WHERE seq = ?").run(oldest.seq);
          released.push(oldest);
        }
        if (released.length) this.#recordGap(feedId, reason, released, "Staging limits were reduced below the entries waiting.");
      }
    });
  }

  /** Release entries the product has durably committed. Idempotent. */
  ack(feedId: string, guids: string[]): number {
    if (!this.#row(feedId)) throw new GatewayError("not_found", "No such feed.");
    if (!Array.isArray(guids) || guids.length > 500 || guids.some((g) => typeof g !== "string" || g.length === 0 || g.length > 500)) {
      throw new GatewayError("bad_request", "Acknowledge up to 500 entry ids at a time.");
    }
    return this.#tx(() => {
      let released = 0;
      const del = this.db.prepare("DELETE FROM staged WHERE feed_id = ? AND guid = ?");
      for (const g of guids) released += Number(del.run(feedId, g).changes);
      return released;
    });
  }

  clearGaps(feedId: string, ids: number[]): number {
    if (!this.#row(feedId)) throw new GatewayError("not_found", "No such feed.");
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((i) => !Number.isInteger(i))) throw new GatewayError("bad_request", "Clear up to 200 gap ids at a time.");
    let n = 0;
    const del = this.db.prepare("DELETE FROM gaps WHERE feed_id = ? AND id = ?");
    for (const id of ids) n += Number(del.run(feedId, id).changes);
    return n;
  }

  /** Confirmed loss of authorization (user disconnect, invalid_grant, expiry, policy end). */
  markGrantLost(feedId: string, code: string, message = "Permission for this source was removed."): void {
    if (!this.#row(feedId)) throw new GatewayError("not_found", "No such feed.");
    this.#tx(() => {
      this.db.prepare("DELETE FROM staged WHERE feed_id = ?").run(feedId);
      this.db
        .prepare("UPDATE feeds SET grant_state = 'lost', cursor = NULL, params_json = 'null', cred_hash = NULL, prev_hash = NULL, prev_valid_until = NULL, cred_revoked_at = ?, health_status = 'permission_removed', health_code = ?, health_message = ? WHERE feed_id = ?")
        .run(this.#now(), code, message, feedId);
    });
  }

  // ---------- refresh ----------

  async #refresh(feedId: string): Promise<void> {
    const row = this.#row(feedId);
    if (!row || row.grant_state === "lost") return;
    const limits = this.#limits(row);
    const now = this.#now();
    if (row.retry_after_at && now < row.retry_after_at) return;
    if (row.last_attempt_at && now - row.last_attempt_at < limits.minRefreshSeconds * 1000) return;
    const adapter = this.#adapters.get(row.adapter);
    if (!adapter) {
      this.db.prepare("UPDATE feeds SET last_attempt_at = ? WHERE feed_id = ?").run(now, feedId);
      this.#setHealth(feedId, "error", "adapter_unavailable", "This source's connector is not available in this installation.");
      return;
    }
    const totals = this.#totals(feedId);
    // Room is counted in worst-case entries so a batch can never overflow the byte bound.
    const free = Math.min(limits.maxEntries - totals.n, Math.floor((limits.maxBytes - totals.bytes) / limits.maxEntryBytes), 200);
    if (free <= 0) {
      // Backpressure: do not ask the provider for more than there is room to stage.
      this.db.prepare("UPDATE feeds SET last_attempt_at = ? WHERE feed_id = ?").run(now, feedId);
      this.#setHealth(feedId, "degraded", "staging_full", "Waiting for the product to catch up before collecting more.");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#refreshTimeoutMs);
    let result: RefreshResult;
    try {
      result = await adapter.refresh({ feedId, params: JSON.parse(row.params_json) as unknown, cursor: row.cursor, limit: free, signal: controller.signal });
    } catch {
      result = { kind: "temporary", code: "provider_error", message: "The connector failed while collecting updates." };
    } finally {
      clearTimeout(timer);
    }
    const after = this.#now();
    // The feed may have been deleted or disconnected while the provider call was in flight.
    const current = this.#row(feedId);
    if (!current || current.grant_state === "lost") return;
    switch (result.kind) {
      case "ok": {
        const ok = result;
        const valid = Array.isArray(result.entries) && result.entries.length <= free && result.entries.every((e) => e && typeof e.guid === "string" && e.guid.length > 0 && typeof e.title === "string");
        if (!valid) {
          this.db.prepare("UPDATE feeds SET last_attempt_at = ? WHERE feed_id = ?").run(after, feedId);
          this.#setHealth(feedId, "error", "adapter_invalid", "The connector returned entries that break the gateway contract; nothing was staged.");
          return;
        }
        this.#tx(() => {
          const insert = this.db.prepare("INSERT OR IGNORE INTO staged (feed_id, guid, entry_json, limited, bytes, published_at, staged_at) VALUES (?,?,?,?,?,?,?)");
          for (const e of ok.entries) {
            const { entry, limited } = boundEntry(e, limits);
            const json = JSON.stringify(entry);
            insert.run(feedId, entry.guid, json, limited ? 1 : 0, Buffer.byteLength(json), entry.publishedAt, after);
          }
          // The cursor advances in the same transaction as the staged entries.
          this.db.prepare("UPDATE feeds SET cursor = ?, last_attempt_at = ?, last_success_at = ?, retry_after_at = NULL, health_status = 'ok', health_code = NULL, health_message = NULL WHERE feed_id = ?").run(ok.nextCursor, after, after, feedId);
          if (ok.coverageGap) this.#recordGap(feedId, "provider", [], ok.coverageGap.note.slice(0, 500));
        });
        return;
      }
      case "temporary": {
        const retry = Math.max(result.retryAfterSeconds ?? limits.minRefreshSeconds, limits.minRefreshSeconds);
        const hasStaged = this.#totals(feedId).n > 0;
        this.db.prepare("UPDATE feeds SET last_attempt_at = ?, retry_after_at = ?, health_status = ?, health_code = ?, health_message = ? WHERE feed_id = ?").run(after, after + retry * 1000, hasStaged ? "degraded" : "error", result.code, result.message.slice(0, 300), feedId);
        return;
      }
      case "grant_lost":
        this.markGrantLost(feedId, result.code, result.message.slice(0, 300));
        return;
    }
  }

  async #ensureFresh(feedId: string): Promise<void> {
    const existing = this.#inflight.get(feedId);
    if (existing) return existing;
    const run = this.#refresh(feedId).finally(() => this.#inflight.delete(feedId));
    this.#inflight.set(feedId, run);
    return run;
  }

  // ---------- serving ----------

  async serve(feedId: string, ifNoneMatch?: string | null): Promise<ServeResult> {
    const text = (status: number, message: string, headers: Record<string, string> = {}): ServeResult => ({ status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }, body: `${message}\n` });
    let row = this.#row(feedId);
    if (!row) return text(404, "Not found.");
    if (row.grant_state === "lost") return text(403, "Access to this source was removed.");
    this.#sweep(feedId);
    await this.#ensureFresh(feedId);
    row = this.#row(feedId);
    if (!row) return text(404, "Not found.");
    if (row.grant_state === "lost") return text(403, "Access to this source was removed.");
    const limits = this.#limits(row);
    const rows = this.db.prepare("SELECT seq, entry_json, limited, bytes FROM staged WHERE feed_id = ? ORDER BY seq DESC LIMIT ?").all(feedId, limits.maxItemsPerResponse) as { seq: number; entry_json: string; limited: number; bytes: number }[];
    const window: typeof rows = [];
    let size = 0;
    for (const r of rows) {
      if (size + r.bytes > limits.maxResponseBytes && window.length > 0) break;
      window.push(r);
      size += r.bytes;
    }
    if (window.length === 0 && (row.health_status === "error" || row.health_status === "degraded")) {
      // A known upstream failure with nothing to deliver is reported, never served as an empty success.
      const wait = Math.max(1, Math.ceil(((row.retry_after_at ?? this.#now() + 60_000) - this.#now()) / 1000));
      return text(503, "This source is temporarily unavailable.", { "retry-after": String(Math.min(wait, 3600)) });
    }
    const etag = `"${createHash("sha256").update(`${feedId}|${row.health_status}|${row.health_code ?? ""}|${window.map((w) => w.seq).join(",")}`).digest("hex").slice(0, 32)}"`;
    const baseHeaders = { etag, "cache-control": "private, max-age=0, must-revalidate", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (ifNoneMatch && ifNoneMatch === etag && row.health_status === "ok") return { status: 304, headers: baseHeaders, body: "" };
    const items = window.map((w) => serializeItem(JSON.parse(w.entry_json) as StagedEntry, w.limited === 1));
    const body = serializeFeed({ title: row.title, siteUrl: row.site_url, description: row.description }, items, new Date(this.#now()));
    if (window.length > 0) this.db.prepare("UPDATE feeds SET last_delivery_at = ? WHERE feed_id = ?").run(this.#now(), feedId);
    return { status: 200, headers: { ...baseHeaders, "content-type": "application/rss+xml; charset=utf-8" }, body };
  }
}
