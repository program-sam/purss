import { DatabaseSync } from "node:sqlite";

/*
 * The bridge fetch log (plan/41): one row per answer the router gave, so the administrator can see
 * which bridged services and sources keep failing and decide whether another backend is needed.
 * No account is recorded, only the public service and key. Rows older than 30 days are dropped,
 * and the table never holds more than MAX_ROWS.
 */

export type FetchOutcome = "ok" | "empty" | "timeout" | "too_large" | "parse_error" | "no_ids" | "unreachable" | `http_${number}`;
export type FetchPhase = "backend" | "parse" | "identity";

export type FetchRecord = {
  service: string;
  key: string;
  backend: string;
  phase: FetchPhase;
  outcome: FetchOutcome;
  entries: number;
  ms: number;
  /** Answered from the router's cache or back-off, without asking the backend. */
  cached: boolean;
};

export type ServiceSummary = {
  service: string;
  attempts: number;
  ok: number;
  empty: number;
  failed: number;
  cachedAnswers: number;
};

export type FailingKey = { service: string; key: string; outcome: string; phase: string; failingSince: string; lastOkAt: string | null; attempts: number };

export type BridgeLogSummary = { days: number; services: ServiceSummary[]; failing: FailingKey[] };

const KEEP_MS = 30 * 86_400_000;
const MAX_ROWS = 200_000;
const PRUNE_EVERY = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bridge_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  backend TEXT NOT NULL,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  entries INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  cached INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS bridge_fetches_at ON bridge_fetches (at);
CREATE INDEX IF NOT EXISTS bridge_fetches_key ON bridge_fetches (service, key, cached, at);
`;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const isGood = (outcome: string) => outcome === "ok" || outcome === "empty";

export class BridgeLog {
  readonly db: DatabaseSync;
  #now: () => number;
  #sincePrune = 0;

  constructor(opts: { path?: string; now?: () => number } = {}) {
    const path = opts.path ?? ":memory:";
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.#now = opts.now ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  record(r: FetchRecord): void {
    this.db.prepare("INSERT INTO bridge_fetches (at, service, key, backend, phase, outcome, entries, ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.#now(), r.service, r.key, r.backend, r.phase, r.outcome, r.entries, Math.round(r.ms), r.cached ? 1 : 0);
    if (++this.#sincePrune >= PRUNE_EVERY) this.prune();
  }

  prune(): void {
    this.#sincePrune = 0;
    this.db.prepare("DELETE FROM bridge_fetches WHERE at < ?").run(this.#now() - KEEP_MS);
    this.db.prepare("DELETE FROM bridge_fetches WHERE id <= (SELECT id FROM bridge_fetches ORDER BY id DESC LIMIT 1 OFFSET ?)").run(MAX_ROWS);
  }

  /** Per service over the last `days`, and the keys whose latest backend answer was a failure. */
  summary(days = 7): BridgeLogSummary {
    const since = this.#now() - days * 86_400_000;
    const services = this.db.prepare(
      `SELECT service,
         SUM(cached = 0) AS attempts,
         SUM(cached = 0 AND outcome = 'ok') AS ok,
         SUM(cached = 0 AND outcome = 'empty') AS empty,
         SUM(cached = 0 AND outcome NOT IN ('ok', 'empty')) AS failed,
         SUM(cached = 1) AS cachedAnswers
       FROM bridge_fetches WHERE at >= ? GROUP BY service ORDER BY service`,
    ).all(since) as ServiceSummary[];

    const latest = this.db.prepare(
      `SELECT f.service, f.key, f.outcome, f.phase FROM bridge_fetches f
       JOIN (SELECT service, key, MAX(id) AS id FROM bridge_fetches WHERE cached = 0 AND at >= ? GROUP BY service, key) l ON l.id = f.id`,
    ).all(since) as { service: string; key: string; outcome: string; phase: string }[];
    const failing: FailingKey[] = [];
    for (const row of latest) {
      if (isGood(row.outcome)) continue;
      const lastOk = this.db.prepare(
        "SELECT MAX(at) AS at FROM bridge_fetches WHERE service = ? AND key = ? AND cached = 0 AND outcome IN ('ok', 'empty')",
      ).get(row.service, row.key) as { at: number | null };
      const streak = this.db.prepare(
        "SELECT MIN(at) AS since, COUNT(*) AS n FROM bridge_fetches WHERE service = ? AND key = ? AND cached = 0 AND at > ?",
      ).get(row.service, row.key, lastOk.at ?? 0) as { since: number; n: number };
      failing.push({ service: row.service, key: row.key, outcome: row.outcome, phase: row.phase, failingSince: iso(streak.since)!, lastOkAt: iso(lastOk.at), attempts: streak.n });
    }
    failing.sort((a, b) => a.failingSince.localeCompare(b.failingSince));
    return { days, services, failing: failing.slice(0, 200) };
  }
}
