import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesMuted } from "../services/muted-match.ts";
import { linkKey, urlKey } from "../services/url-key.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export type Row = Record<string, unknown>;

/** Thin wrapper over node:sqlite with cached statements and explicit transactions. */
export class Database {
  readonly raw: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    // Migrations that (re)compute items.url_key call the same function the application uses.
    this.raw.function("purss_url_key", { deterministic: true }, (url) => urlKey(typeof url === "string" ? url : null));
    this.raw.function("purss_link_key", { deterministic: true }, (url) => (typeof url === "string" ? linkKey(url) : null));
    // Whether muted words match an item's title or summary (services/muted-match.ts): the match is made on the row a query looks at.
    this.raw.function("purss_muted", { deterministic: true }, (patterns, title, excerpt) => (matchesMuted(String(patterns), title, excerpt) ? 1 : 0));
  }

  #stmt(sql: string): StatementSync {
    let s = this.#statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  /**
   * Code inside `tx` runs in a transaction, and SQLite can end it from under the code (a full disk, I/O trouble, RAISE(ROLLBACK)). If an
   * inner error was swallowed, the code carries on, and every statement from there runs in autocommit and is kept, while the final
   * COMMIT fails: half of a unit of work lands. So once the transaction is gone, nothing in it may touch the database again.
   */
  #live(): void {
    if (this.#depth > 0 && !this.raw.isTransaction) {
      throw new Error("The database ended the transaction this was running in, so nothing more can be done in it. The work was undone.");
    }
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    this.#live();
    return this.#stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    this.#live();
    return this.#stmt(sql).all(...params) as T[];
  }

  /**
   * The connection's last inserted rowid can lie past 2^53 (the search index's own tables leave one),
   * and node:sqlite refuses to return such a value as a number, so it is read as a bigint. Callers use
   * `lastInsertRowid` only right after inserting into a table with ordinary rowids.
   */
  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    this.#live();
    const s = this.#stmt(sql);
    s.setReadBigInts(true);
    try {
      const r = s.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    } finally {
      s.setReadBigInts(false);
    }
  }

  exec(sql: string): void {
    this.#live();
    this.raw.exec(sql);
  }

  /** Whether a transaction is open. SQLite can end one itself (a full disk, I/O trouble, RAISE(ROLLBACK)) while code is still inside it. */
  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  /**
   * Run fn in a transaction (savepoint when nested). Throws roll back. When SQLite has ended the whole transaction already, there
   * is no savepoint to roll back to: the error that ended it is the one thrown, not a complaint about the missing savepoint.
   */
  tx<T>(fn: () => T): T {
    this.#live(); // a savepoint outside a transaction would quietly start a new one
    const outer = this.#depth === 0;
    const name = `sp${this.#depth}`;
    this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.#depth++;
    try {
      const out = fn();
      // Commit before giving up the level: if COMMIT itself fails (disk full, I/O), roll back below.
      this.raw.exec(outer ? "COMMIT" : `RELEASE ${name}`);
      this.#depth--;
      return out;
    } catch (err) {
      try {
        if (outer) { if (this.raw.isTransaction) this.raw.exec("ROLLBACK"); }
        else if (this.raw.isTransaction) this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      } finally {
        this.#depth--;
      }
      throw err;
    }
  }

  close(): void {
    this.#statements.clear();
    this.raw.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;

export function migrate(db: Database): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  const done = new Set(db.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.tx(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
    });
    applied++;
  }
  return applied;
}

export function openDatabase(file: string): Database {
  const db = new Database(file);
  migrate(db);
  return db;
}
