import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { Database } from "../db/database.ts";
import { createApp, tick } from "../main.ts";
import { removeMediaFolder } from "./media-folder.ts";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const scratch: string[] = [];
const tmp = (label: string) => { const d = mkdtempSync(path.join(os.tmpdir(), `purss-media-folder-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** What an earlier version left under <data>/media: an account folder with files, and downloads in incoming/. */
function oldMediaFolder(dataDir: string): string[] {
  const files = [path.join(dataDir, "media", "acc_0123456789abcdefghjkmnpqrs", "med_0123456789abcdefghjkmnpqrs"), path.join(dataDir, "media", "incoming", "med_0123456789abcdefghjkmnpqrt.part")];
  for (const f of files) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, Buffer.alloc(2048, 7)); }
  return files;
}

const quiet = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

test("the media folder an earlier version filled is removed, and nothing outside it is touched", () => {
  const dataDir = tmp("data");
  const outside = tmp("outside");
  writeFileSync(path.join(outside, "keep.mp3"), "not ours");
  writeFileSync(path.join(dataDir, "product.db"), "database");
  mkdirSync(path.join(dataDir, "secrets"));
  writeFileSync(path.join(dataDir, "secrets", "service-token"), "secret");
  mkdirSync(path.join(dataDir, "mediafiles"));
  writeFileSync(path.join(dataDir, "mediafiles", "other.txt"), "a neighbour with a similar name");
  const files = oldMediaFolder(dataDir);
  symlinkSync(outside, path.join(dataDir, "media", "link-out")); // a link inside the folder is removed, never followed

  assert.deepEqual(quiet(() => removeMediaFolder(dataDir)), { files: 2, bytes: 4096 });
  assert.equal(existsSync(path.join(dataDir, "media")), false);
  for (const f of files) assert.equal(existsSync(f), false);
  assert.equal(readFileSync(path.join(outside, "keep.mp3"), "utf8"), "not ours", "what a link pointed at is untouched");
  assert.deepEqual(readdirSync(dataDir).sort(), ["mediafiles", "product.db", "secrets"], "the rest of the data directory is as it was");
  assert.equal(readFileSync(path.join(dataDir, "secrets", "service-token"), "utf8"), "secret");
  assert.equal(readFileSync(path.join(dataDir, "mediafiles", "other.txt"), "utf8"), "a neighbour with a similar name");

  assert.equal(quiet(() => removeMediaFolder(dataDir)), null, "run again, it finds nothing and does nothing");
});

test("a link at the media folder's name is removed and what it points to is left alone", () => {
  const dataDir = tmp("data");
  const elsewhere = tmp("elsewhere");
  writeFileSync(path.join(elsewhere, "a.mp3"), "a file on another disk");
  symlinkSync(elsewhere, path.join(dataDir, "media"));
  assert.deepEqual(quiet(() => removeMediaFolder(dataDir)), { files: 0, bytes: 0 });
  assert.equal(existsSync(path.join(dataDir, "media")), false);
  assert.equal(readFileSync(path.join(elsewhere, "a.mp3"), "utf8"), "a file on another disk");
});

test("starting the API on an installation that saved media releases the ledger and removes the files, once", () => {
  const dataDir = tmp("install");
  // A database as the version before this one left it, with one saved file in the ledger.
  const old = new Database(path.join(dataDir, "product.db"));
  try {
    old.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    for (const f of readdirSync(MIGRATIONS).filter((n) => /^\d{3}_.+\.sql$/.test(n) && n < "033").sort()) {
      old.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
      old.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')", f);
    }
    const at = "2026-10-01T00:00:00.000Z";
    old.run("INSERT INTO accounts (id, created_at) VALUES ('acc_0123456789abcdefghjkmnpqrs', ?)", at);
    old.run("INSERT INTO workspaces (id, account_id, created_at) VALUES ('wsp_1', 'acc_0123456789abcdefghjkmnpqrs', ?)", at);
    old.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_m', 'acc_0123456789abcdefghjkmnpqrs', 'wsp_1', 'media', 'med_0123456789abcdefghjkmnpqrs', 2048, ?), ('obj_s', 'acc_0123456789abcdefghjkmnpqrs', 'wsp_1', 'record', 'state:x', 64, ?)", at, at);
    old.run("INSERT INTO storage_accounts (account_id, used_bytes) VALUES ('acc_0123456789abcdefghjkmnpqrs', 2112)");
  } finally {
    old.close();
  }
  const files = oldMediaFolder(dataDir);

  const app = quiet(() => createApp(loadConfig({ PURSS_DATA_DIR: dataDir })));
  try {
    assert.equal(app.db.get<{ used_bytes: number }>("SELECT used_bytes FROM storage_accounts")!.used_bytes, 64, "only the 64-byte record is still counted");
    assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE released_at IS NULL")!.n, 1);
    assert.equal(existsSync(path.join(dataDir, "media")), false);
    for (const f of files) assert.equal(existsSync(f), false);
    assert.equal(existsSync(path.join(dataDir, "product.db")), true);
  } finally {
    app.db.close();
  }
  const again = quiet(() => createApp(loadConfig({ PURSS_DATA_DIR: dataDir })));
  try {
    assert.equal(again.db.get<{ used_bytes: number }>("SELECT used_bytes FROM storage_accounts")!.used_bytes, 64, "a second start changes nothing");
  } finally {
    again.db.close();
  }
});

test("a media file written after start, as an older worker finishing a download would, goes at the next maintenance tick", () => {
  const dataDir = tmp("late");
  const app = quiet(() => createApp(loadConfig({ PURSS_DATA_DIR: dataDir, PURSS_DISK_RESERVE_BYTES: "0" })));
  try {
    const [file] = oldMediaFolder(dataDir);
    assert.ok(existsSync(file!));
    quiet(() => tick(app));
    assert.equal(existsSync(path.join(dataDir, "media")), false);
  } finally { app.db.close(); }
});
