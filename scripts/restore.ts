import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { copyFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../apps/api/src/config.ts";
import { openDatabase } from "../apps/api/src/db/database.ts";
import { reindex } from "../apps/api/src/services/items.ts";
import { reconcile } from "../apps/api/src/services/storage.ts";
import type { App } from "../apps/api/src/app.ts";
import { describeDatabase, hashFile } from "./backup.ts";
import type { BackupManifest } from "./backup.ts";

/*
 * Restore a backup made by scripts/backup.ts into a fresh data directory (plan/11):
 * verify every file against the manifest, check the database (integrity and foreign keys),
 * apply any newer migrations, rebuild the full-text index, and report what came back.
 * A non-empty target is refused unless --force; with --force the existing database is
 * renamed aside, never deleted.
 *
 *   node scripts/restore.ts <backup-dir> --data-dir <target> [--force] [--skip-secrets]
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/api/src/db/migrations");

export type RestoreOptions = { backupDir: string; dataDir: string; force?: boolean; skipSecrets?: boolean; now?: Date };
export type RestoreReport = {
  dataDir: string;
  backupCreatedAt: string;
  integrity: string;
  foreignKeyProblems: number;
  migrationsApplied: number;
  searchEntriesRebuilt: number;
  counts: Record<string, number>;
  usageDifferences: { accountId: string; differenceBytes: number }[];
  secretsRestored: boolean;
  replaced: string[];
};

function readManifest(backupDir: string): BackupManifest {
  const file = path.join(backupDir, "manifest.json");
  if (!existsSync(file)) throw new Error(`${backupDir} isn't a backup folder (no manifest.json).`);
  const m = JSON.parse(readFileSync(file, "utf8")) as BackupManifest;
  if (m.format !== "purss-backup" || m.version !== 1 || !Array.isArray(m.files)) throw new Error("That backup was made by an unknown or newer version and can't be read here.");
  return m;
}

/**
 * The only files a backup holds (scripts/backup.ts): the database and secrets. A backup made when the server
 * still saved media files also lists them by account and id; the server keeps none now, so they are never
 * read or restored.
 */
const BACKUP_NAME = /^(product\.db|media\/acc_[0-9a-z]{26}\/med_[0-9a-z]{26}|secrets\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/;

/**
 * Refuse a manifest that names anything but a file a backup can hold, in its plain relative form, so a
 * tampered manifest can't make restore read outside the backup or write outside the data folder.
 */
function checkNames(manifest: BackupManifest, backupDir: string, dataDir: string): void {
  for (const f of manifest.files) {
    const name = typeof f?.name === "string" ? f.name : "";
    const parts = name.split("/");
    const plain = BACKUP_NAME.test(name) && parts.every((s) => s !== "." && s !== "..") && path.posix.normalize(name) === name;
    const inside = (base: string) => { const to = path.resolve(base, ...parts); return to.startsWith(base + path.sep); };
    if (!plain || !inside(backupDir) || !inside(dataDir)) throw new Error(`The backup's manifest lists ${JSON.stringify(name)}, which isn't a file this backup can hold, so nothing was restored.`);
  }
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const backupDir = path.resolve(opts.backupDir);
  const dataDir = path.resolve(opts.dataDir);
  const manifest = readManifest(backupDir);
  checkNames(manifest, backupDir, dataDir);

  // 1. The backup must be intact and from a compatible version.
  const wanted = manifest.files.filter((f) => !f.name.startsWith("media/"));
  for (const f of wanted) {
    const file = path.join(backupDir, ...f.name.split("/"));
    if (!existsSync(file) || (await hashFile(file)) !== f.sha256) throw new Error(`The backup is damaged: ${f.name} doesn't match its checksum.`);
  }
  const known = new Set(readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{3}_.+\.sql$/.test(n)));
  const unknown = manifest.migrations.filter((m) => !known.has(m));
  if (unknown.length) throw new Error(`The backup was made by a newer version (it has ${unknown[0]}). Update this installation before restoring it.`);

  // 2. The target must be empty, or --force moves the old database aside.
  const targetDb = path.join(dataDir, "product.db");
  const occupied = existsSync(dataDir) && readdirSync(dataDir).length > 0;
  if (occupied && !opts.force) throw new Error(`${dataDir} isn't empty. Restore into a new, empty folder, or pass --force to move the existing database aside and replace it.`);
  const dbBytes = statSync(path.join(backupDir, "product.db")).size;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fs = statfsSync(dataDir);
  if (fs.bavail * fs.bsize < dbBytes * 1.2 + 1024 * 1024) throw new Error("There isn't enough free disk space to restore this backup.");

  const suffix = `.replaced-${(opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const replaced: string[] = [];
  const moveAside = (name: string) => {
    const from = path.join(dataDir, name);
    if (!existsSync(from)) return;
    renameSync(from, from + suffix);
    replaced.push(name + suffix);
  };
  const created: string[] = [];
  const rollback = () => {
    for (const c of created) rmSync(c, { recursive: true, force: true });
    for (const side of [`${targetDb}-wal`, `${targetDb}-shm`]) rmSync(side, { force: true }); // left by opening a log-mode file
    for (const r of replaced) renameSync(path.join(dataDir, r), path.join(dataDir, r.slice(0, -suffix.length)));
  };

  try {
    for (const n of ["product.db", "product.db-wal", "product.db-shm"]) moveAside(n);
    copyFileSync(path.join(backupDir, "product.db"), targetDb);
    created.push(targetDb);
    chmodSync(targetDb, 0o600);

    // 3. Verify the restored file before anything opens it for writing.
    const info = describeDatabase(targetDb);
    if (info.integrity !== "ok") throw new Error(`The restored database failed its integrity check (${info.integrity}).`);
    const check = new DatabaseSync(targetDb, { readOnly: true });
    let fkProblems = 0;
    try { fkProblems = check.prepare("PRAGMA foreign_key_check").all().length; } finally { check.close(); }
    if (fkProblems) throw new Error(`The restored database has ${fkProblems} broken references, so it wasn't kept.`);

    // 4. Secrets come back only if the backup holds them (and you don't skip them).
    let secretsRestored = false;
    if (manifest.includesSecrets && !opts.skipSecrets && existsSync(path.join(backupDir, "secrets"))) {
      moveAside("secrets");
      cpSync(path.join(backupDir, "secrets"), path.join(dataDir, "secrets"), { recursive: true });
      created.push(path.join(dataDir, "secrets"));
      secretsRestored = true;
    }

    // 5. Apply newer migrations, rebuild the search index, and recheck the storage ledger.
    const db = openDatabase(targetDb);
    try {
      const applied = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations")!.n - info.migrations.length;
      const app: App = { db, config: loadConfig({ PURSS_DATA_DIR: dataDir }), events: new EventEmitter(), serviceToken: "" };
      db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')"); // the index is derived; rebuild it from the items
      const items = db.all<{ id: string }>("SELECT id FROM items ORDER BY seq");
      for (const it of items) reindex(app, it.id);
      const usageDifferences = db.all<{ id: string }>("SELECT id FROM accounts").map((a) => ({ accountId: a.id, differenceBytes: reconcile(app, a.id).difference })).filter((d) => d.differenceBytes !== 0);
      return {
        dataDir, backupCreatedAt: manifest.createdAt, integrity: info.integrity, foreignKeyProblems: 0, migrationsApplied: applied,
        searchEntriesRebuilt: items.length, counts: describeDatabase(targetDb).counts, usageDifferences, secretsRestored, replaced,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    rollback();
    throw err;
  }
}

function parseArgs(argv: string[]): RestoreOptions {
  let backupDir: string | undefined;
  let dataDir: string | undefined;
  let force = false;
  let skipSecrets = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--data-dir") dataDir = argv[++i];
    else if (a === "--force") force = true;
    else if (a === "--skip-secrets") skipSecrets = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}.`);
    else backupDir = a;
  }
  if (!backupDir || !dataDir) throw new Error("Usage: node scripts/restore.ts <backup-dir> --data-dir <target> [--force] [--skip-secrets]");
  return { backupDir, dataDir, force, skipSecrets };
}

if (import.meta.main) {
  try {
    const r = await restoreBackup(parseArgs(process.argv.slice(2)));
    console.log(`Restored into ${r.dataDir} (backup from ${r.backupCreatedAt}).`);
    console.log(`  integrity: ${r.integrity}; migrations applied on top: ${r.migrationsApplied}; search entries rebuilt: ${r.searchEntriesRebuilt}`);
    console.log(`  contents: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    if (r.usageDifferences.length) console.warn(`  WARNING: ${r.usageDifferences.length} account(s) have a storage ledger that differs from their objects. Run: node apps/api/src/cli.ts reconcile-usage`);
    if (r.replaced.length) console.log(`  moved aside (not deleted): ${r.replaced.join(", ")}`);
    console.log(r.secretsRestored ? "  secrets restored from the backup." : "  secrets were not restored: the app will create a new service token, and private sources will need reconnecting.");
    console.log("Next: start the app against this data directory, then restore or re-provision the collection engine; its first sync is reconciled against what you have (Review queue).");
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
