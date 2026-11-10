import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, cpSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../apps/api/src/config.ts";

/*
 * Consistent backup of the product database (plan/11): SQLite's online backup API copies a
 * transaction-consistent snapshot while the app keeps running. Never copy product.db by hand;
 * a live file without its write-ahead log can be missing committed data.
 *
 *   node scripts/backup.ts [--data-dir <dir>] [--out <dir>] [--include-secrets]
 *
 * Writes <out>/<timestamp>/product.db and manifest.json (sizes and SHA-256 of every file).
 * The secrets directory (service token, private source links) is copied only with
 * --include-secrets; such a backup must be protected like a password. The collection
 * engine's own data volume is not part of this backup and needs its own copy.
 */

export type BackupFile = { name: string; bytes: number; sha256: string };
export type BackupManifest = {
  format: "purss-backup";
  version: 1;
  createdAt: string;
  includesSecrets: boolean;
  migrations: string[];
  integrityCheck: string;
  counts: Record<string, number>;
  files: BackupFile[];
};
export type BackupOptions = { dataDir: string; dbFile?: string; outDir?: string; includeSecrets?: boolean; now?: Date };

export async function hashFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

function* walk(dir: string, base = dir): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield path.relative(base, full);
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const COUNT_TABLES = ["accounts", "sources", "items", "item_versions", "captures", "baskets", "basket_items", "collections", "publications"] as const;

export function describeDatabase(file: string): { integrity: string; migrations: string[]; counts: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
    const migrations = (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const counts: Record<string, number> = {};
    for (const t of COUNT_TABLES) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue; // older backups
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return { integrity, migrations, counts };
  } finally {
    db.close();
  }
}

export async function createBackup(opts: BackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  const dbFile = opts.dbFile ?? path.join(opts.dataDir, "product.db");
  if (!existsSync(dbFile)) throw new Error(`No database at ${dbFile}.`);
  const outDir = path.resolve(opts.outDir ?? path.join(opts.dataDir, "backups"));
  const now = opts.now ?? new Date();
  const dir = path.join(outDir, stamp(now));
  if (existsSync(dir)) throw new Error(`${dir} already exists; backups are never overwritten. Try again in a second.`);

  // A backup needs room for a full copy of the database (plus its log); check before starting.
  const need = statSync(dbFile).size + (existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const fs = statfsSync(outDir);
  if (fs.bavail * fs.bsize < need * 1.1 + 1024 * 1024) throw new Error("There isn't enough free disk space for a backup right now. Free some space or choose another --out directory.");

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = path.join(dir, "product.db");
  try {
    const source = new DatabaseSync(dbFile, { readOnly: true });
    try { await backup(source, copy); } finally { source.close(); }
    // The copy inherits the live database's write-ahead mode; make it one self-contained file instead.
    const single = new DatabaseSync(copy);
    try { single.exec("PRAGMA journal_mode = DELETE"); } finally { single.close(); }
    chmodSync(copy, 0o600);
    const info = describeDatabase(copy);
    if (info.integrity !== "ok") throw new Error(`The backup copy failed its integrity check (${info.integrity}).`);

    const files: BackupFile[] = [{ name: "product.db", bytes: statSync(copy).size, sha256: await hashFile(copy) }];
    const secretsDir = path.join(opts.dataDir, "secrets");
    if (opts.includeSecrets && existsSync(secretsDir)) {
      const target = path.join(dir, "secrets");
      cpSync(secretsDir, target, { recursive: true });
      for (const rel of walk(target)) {
        chmodSync(path.join(target, rel), 0o600);
        files.push({ name: ["secrets", ...rel.split(path.sep)].join("/"), bytes: statSync(path.join(target, rel)).size, sha256: await hashFile(path.join(target, rel)) });
      }
    }
    const manifest: BackupManifest = {
      format: "purss-backup", version: 1, createdAt: now.toISOString(), includesSecrets: !!opts.includeSecrets && existsSync(secretsDir),
      migrations: info.migrations, integrityCheck: info.integrity, counts: info.counts, files,
    };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    return { dir, manifest };
  } catch (err) {
    // Leave no half-written backup that could be mistaken for a good one.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function parseArgs(argv: string[]): { dataDir?: string; out?: string; includeSecrets: boolean } {
  const out: { dataDir?: string; out?: string; includeSecrets: boolean } = { includeSecrets: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--include-secrets") out.includeSecrets = true;
    else throw new Error(`Unknown option ${a}. Usage: node scripts/backup.ts [--data-dir <dir>] [--out <dir>] [--include-secrets]`);
  }
  return out;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = loadConfig();
    const dataDir = path.resolve(args.dataDir ?? config.dataDir);
    const { dir, manifest } = await createBackup({ dataDir, dbFile: args.dataDir ? undefined : config.dbFile, outDir: args.out, includeSecrets: args.includeSecrets });
    console.log(`Backup written to ${dir}`);
    console.log(`  database: ${manifest.files[0]!.bytes} bytes, integrity ${manifest.integrityCheck}, ${manifest.migrations.length} migrations`);
    console.log(`  contents: ${Object.entries(manifest.counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    if (manifest.includesSecrets) console.warn("WARNING: this backup contains the secrets directory (service token, private source links and Jev keys). Protect it like a password and keep it out of Git.");
    else console.log("  secrets: not included (use --include-secrets to add them). Private sources will show \"Reconnect required\" after a restore without them.");
    console.log("The collection engine's own data volume is not part of this backup.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
