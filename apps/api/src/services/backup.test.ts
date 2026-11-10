import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { seedLibrary } from "../features-testing.ts";
import { openDatabase } from "../db/database.ts";
import { loadConfig } from "../config.ts";
import { createBasket } from "./collections.ts";
import { listItems } from "./items.ts";
import { usedBytes } from "./storage.ts";
import { createBackup, hashFile } from "../../../../scripts/backup.ts";
import { restoreBackup } from "../../../../scripts/restore.ts";
import type { BackupManifest } from "../../../../scripts/backup.ts";

const scratch: string[] = [];
const tmp = (label: string) => { const d = mkdtempSync(path.join(os.tmpdir(), `purss-bk-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function source() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const lib = seedLibrary(app, p);
  createBasket(app, p, { name: "Empty one", captureMode: "text" });
  return { app, p, lib, cleanup };
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;

test("backup writes a consistent copy with a manifest, and no secrets unless asked", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const out = tmp("out");
  const { dir, manifest } = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T12:00:00.000Z") });
  assert.equal(dir, path.join(out, "20261103T120000Z"));
  assert.deepEqual(readdirSync(dir).sort(), ["manifest.json", "product.db"]);
  assert.equal(manifest.format, "purss-backup");
  assert.equal(manifest.integrityCheck, "ok");
  assert.equal(manifest.includesSecrets, false);
  assert.deepEqual(manifest.migrations, readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort());
  assert.deepEqual([manifest.counts.items, manifest.counts.baskets, manifest.counts.basket_items, manifest.counts.captures], [4, 3, 3, 1]);
  assert.equal(manifest.files[0]!.sha256, await hashFile(path.join(dir, "product.db")));
  assert.equal(manifest.files[0]!.bytes, statSync(path.join(dir, "product.db")).size);
  assert.equal(statSync(path.join(dir, "product.db")).mode & 0o077, 0, "owner-only permissions");
  assert.deepEqual(manifestOf(dir), manifest);
  assert.ok(!readFileSync(path.join(dir, "product.db")).includes("SUPERSECRETTOKEN123"), "private source addresses live in the secrets directory, not the database");

  // The copy contains data that was still only in the write-ahead log of the live database.
  const copy = new DatabaseSync(path.join(dir, "product.db"), { readOnly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 4);
  copy.close();

  // Never overwrites an existing backup.
  await assert.rejects(createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T12:00:00.000Z") }), /already exists/);

  const withSecrets = await createBackup({ dataDir: app.config.dataDir, outDir: out, includeSecrets: true, now: new Date("2026-11-03T12:00:01.000Z") });
  assert.equal(withSecrets.manifest.includesSecrets, true);
  const names = withSecrets.manifest.files.map((f) => f.name);
  assert.ok(names.includes("product.db") && names.some((n) => n.startsWith(path.join("secrets", "source-urls"))) && names.includes(path.join("secrets", "service-token")) === existsSync(path.join(app.config.secretsDir, "service-token")));
  for (const f of withSecrets.manifest.files.filter((f) => f.name.startsWith("secrets"))) assert.equal(statSync(path.join(withSecrets.dir, f.name)).mode & 0o077, 0, `${f.name} is owner-only`);
});

test("restore brings back everything into a fresh directory, rebuilds search and agrees with the storage ledger", async (t) => {
  const { app, p, lib, cleanup } = source();
  t.after(cleanup);
  app.db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')"); // a derived index lost or stale: restore must rebuild it
  const before = usedBytes(app, p.accountId);
  const { dir } = await createBackup({ dataDir: app.config.dataDir, outDir: tmp("out") });
  const target = path.join(tmp("target"), "data");
  const report = await restoreBackup({ backupDir: dir, dataDir: target });
  assert.equal(report.integrity, "ok");
  assert.equal(report.foreignKeyProblems, 0);
  assert.equal(report.searchEntriesRebuilt, 4);
  assert.deepEqual([report.counts.items, report.counts.baskets, report.counts.basket_items, report.counts.captures, report.counts.sources], [4, 3, 3, 1, 2]);
  assert.deepEqual(report.usageDifferences, []);
  assert.equal(report.secretsRestored, false);
  assert.deepEqual(readdirSync(target), ["product.db"], "no stray WAL files after a clean close");

  const db = openDatabase(path.join(target, "product.db"));
  const restored = { db, config: loadConfig({ PURSS_DATA_DIR: target }), events: app.events, serviceToken: "" };
  try {
    assert.equal(usedBytes(restored, p.accountId), before, "reference accounting survives the restore");
    const found = listItems(restored, p, { scope: "all", filter: "all", q: "readable sediment" });
    assert.equal(found.items[0]?.id, lib.pinnedOld.itemId, "captured text is searchable again");
    assert.equal(listItems(restored, p, { scope: "all", filter: "all", q: "corrected" }).items.length, 1);
    const pinned = db.get<{ title: string }>("SELECT v.title FROM basket_items b JOIN item_versions v ON v.id = b.version_id WHERE b.item_id = ?", lib.pinnedOld.itemId)!;
    assert.equal(pinned.title, "Tidal flats and sediment", "the kept version is the original");
  } finally { db.close(); }
});

test("restore refuses a non-empty target without --force, and with it moves the old database aside", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const { dir } = await createBackup({ dataDir: app.config.dataDir, outDir: tmp("out") });
  const target = tmp("occupied");
  writeFileSync(path.join(target, "product.db"), "an existing database");
  writeFileSync(path.join(target, "notes.txt"), "keep me");
  await assert.rejects(restoreBackup({ backupDir: dir, dataDir: target }), /isn't empty/);
  assert.equal(readFileSync(path.join(target, "product.db"), "utf8"), "an existing database");
  const stray = tmp("stray");
  writeFileSync(path.join(stray, "unrelated.txt"), "x");
  await assert.rejects(restoreBackup({ backupDir: dir, dataDir: stray }), /isn't empty/, "any content counts, not only a database");

  const report = await restoreBackup({ backupDir: dir, dataDir: target, force: true, now: new Date("2026-11-03T13:00:00.000Z") });
  assert.deepEqual(report.replaced, ["product.db.replaced-20261103T130000Z"]);
  assert.equal(readFileSync(path.join(target, "product.db.replaced-20261103T130000Z"), "utf8"), "an existing database", "moved aside, not deleted");
  assert.equal(readFileSync(path.join(target, "notes.txt"), "utf8"), "keep me");
  assert.equal(report.counts.items, 4);
});

test("a damaged backup, a backup from a newer version, or one with broken references is refused and leaves the target as it was", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const out = tmp("out");
  const good = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T10:00:00.000Z") });

  // Damaged: one byte flipped.
  const damaged = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T10:00:01.000Z") });
  const bytes = readFileSync(path.join(damaged.dir, "product.db"));
  bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0xff;
  writeFileSync(path.join(damaged.dir, "product.db"), bytes);
  const fresh = path.join(tmp("fresh"), "data");
  await assert.rejects(restoreBackup({ backupDir: damaged.dir, dataDir: fresh }), /damaged: product\.db doesn't match/);
  assert.equal(existsSync(fresh), false, "nothing was created");

  // Newer version: the manifest names a migration this app doesn't have.
  const newer = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T10:00:02.000Z") });
  const m = manifestOf(newer.dir);
  m.migrations.push("999_future.sql");
  writeFileSync(path.join(newer.dir, "manifest.json"), JSON.stringify(m));
  await assert.rejects(restoreBackup({ backupDir: newer.dir, dataDir: fresh }), /newer version/);

  // Broken references: a database that passes the page-level check but not the foreign-key check is not kept.
  app.db.exec("PRAGMA foreign_keys = OFF");
  app.db.run("INSERT INTO basket_items (basket_id, item_id, workspace_id, version_id, kept_at) VALUES ('bsk_missing', 'itm_missing', 'wsp_missing', 'ver_missing', 'x')");
  app.db.exec("PRAGMA foreign_keys = ON");
  const broken = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date("2026-11-03T10:00:03.000Z") });
  const occupied = tmp("occupied-ok");
  writeFileSync(path.join(occupied, "product.db"), "the live database");
  await assert.rejects(restoreBackup({ backupDir: broken.dir, dataDir: occupied, force: true }), /broken references/);
  assert.deepEqual(readdirSync(occupied), ["product.db"], "the original was put back; no leftovers");
  assert.equal(readFileSync(path.join(occupied, "product.db"), "utf8"), "the live database");
  await assert.rejects(restoreBackup({ backupDir: broken.dir, dataDir: fresh }), /broken references/);
  assert.equal(existsSync(path.join(fresh, "product.db")), false);

  // The good backup still restores.
  assert.equal((await restoreBackup({ backupDir: good.dir, dataDir: path.join(tmp("good"), "data") })).counts.items, 4);
  await assert.rejects(restoreBackup({ backupDir: tmp("notabackup"), dataDir: fresh }), /isn't a backup folder/);
});

test("a manifest naming files outside the backup or the data folder is refused before anything is written", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const out = tmp("out");
  let n = 0;
  const absolute = path.join(tmp("absolute"), "escaped");
  for (const name of ["media/../../escaped", "media/acc_x/../../../escaped", "../escaped", absolute, "media//escaped", "media/./x", "secrets/../../escaped", "media\\..\\escaped", "other/escaped", "product.db/../escaped"]) {
    const b = await createBackup({ dataDir: app.config.dataDir, outDir: out, now: new Date(Date.parse("2026-11-03T11:00:00.000Z") + n++ * 1000) });
    // Put a file where the name points, with its real checksum, so only the name check can stop it.
    const at = path.resolve(b.dir, name);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, "planted");
    const m = manifestOf(b.dir);
    m.files.push({ name, bytes: 7, sha256: createHash("sha256").update("planted").digest("hex") });
    writeFileSync(path.join(b.dir, "manifest.json"), JSON.stringify(m));
    const target = path.join(tmp("escape"), "deep", "data");
    await assert.rejects(restoreBackup({ backupDir: b.dir, dataDir: target }), /isn't a file this backup can hold/, name);
    assert.equal(existsSync(target), false, `nothing was created for ${name}`);
    assert.equal(existsSync(path.resolve(target, name)) && path.resolve(target, name) !== at, false);
  }
});

test("secrets are restored only when the backup holds them and the operator hasn't skipped them", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const withSecrets = await createBackup({ dataDir: app.config.dataDir, outDir: tmp("out"), includeSecrets: true });
  const target = path.join(tmp("t1"), "data");
  const r = await restoreBackup({ backupDir: withSecrets.dir, dataDir: target });
  assert.equal(r.secretsRestored, true);
  const privateId = app.db.get<{ id: string }>("SELECT id FROM sources WHERE is_private = 1")!.id;
  assert.equal(readFileSync(path.join(target, "secrets", "source-urls", privateId), "utf8").trim(), "https://feeds.example/u/9f8e7d6c5b4a39281706f5e4d3c2b1a0?token=SUPERSECRETTOKEN123");
  const skipped = await restoreBackup({ backupDir: withSecrets.dir, dataDir: path.join(tmp("t2"), "data"), skipSecrets: true });
  assert.equal(skipped.secretsRestored, false);
  assert.equal(existsSync(path.join(skipped.dataDir, "secrets")), false);
});

test("the command-line scripts work end to end", async (t) => {
  const { app, cleanup } = source();
  t.after(cleanup);
  const root = path.resolve(import.meta.dirname, "../../../..");
  const out = tmp("cli-out");
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    execFileSync(process.execPath, [path.join(root, "scripts", script), ...args], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const said = run("backup.ts", ["--data-dir", app.config.dataDir, "--out", out]);
  assert.match(said, /Backup written to/);
  assert.match(said, /secrets: not included/);
  const dir = path.join(out, readdirSync(out)[0]!);
  const target = path.join(tmp("cli-target"), "data");
  const restored = run("restore.ts", [dir, "--data-dir", target]);
  assert.match(restored, /search entries rebuilt: 4/);
  assert.throws(() => run("restore.ts", [dir, "--data-dir", target]), (e: any) => /isn't empty/.test(String(e.stderr)));
  assert.throws(() => run("backup.ts", ["--nonsense"]), (e: any) => /Unknown option/.test(String(e.stderr)));
  copyFileSync(path.join(target, "product.db"), path.join(tmp("x"), "product.db")); // the restored file is a plain, openable database
});

test("a backup holds the database and no media files; one made when the server still saved media restores without them", async (t) => {
  const { app, p, cleanup } = source();
  t.after(cleanup);
  // A media folder left in the data directory is not part of a backup.
  const folder = path.join(app.config.dataDir, "media", p.accountId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "med_0123456789abcdefghjkmnpqrs"), "leftover");
  const before = usedBytes(app, p.accountId);

  const { dir, manifest } = await createBackup({ dataDir: app.config.dataDir, outDir: tmp("out") });
  assert.deepEqual(manifest.files.map((f) => f.name), ["product.db"], "only the database");
  assert.equal("saved_media" in manifest.counts, false);

  // An earlier version's backup lists each saved file by account and id. They are neither read nor restored,
  // so a damaged or missing one doesn't stop the restore.
  const old = manifestOf(dir);
  const rel = `media/${p.accountId}/med_0123456789abcdefghjkmnpqrs`;
  old.files.push({ name: rel, bytes: 8, sha256: createHash("sha256").update("leftover").digest("hex") });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(old));
  const target = path.join(tmp("target"), "data");
  const report = await restoreBackup({ backupDir: dir, dataDir: target });
  assert.equal(existsSync(path.join(target, "media")), false, "no media folder comes back");
  assert.equal("mediaFilesRestored" in report, false);
  assert.deepEqual(report.usageDifferences, []);
  const db = openDatabase(path.join(target, "product.db"));
  try {
    assert.equal(usedBytes({ db, config: loadConfig({ PURSS_DATA_DIR: target }), events: app.events, serviceToken: "" }, p.accountId), before);
  } finally { db.close(); }
});
