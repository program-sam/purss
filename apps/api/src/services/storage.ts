import { statfsSync, statSync } from "node:fs";
import { newId, CONTROL_HEADROOM_BYTES } from "@purss/domain";
import type { StoredObjectKind } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";

/**
 * Logical storage ledger. Account usage = sum of live stored objects, kept as
 * a total (`storage_accounts.used_bytes`) that `admitObject`, `releaseObject` and the
 * import's ledger insert update in the same transaction as the object.
 * All admission happens inside the caller's write transaction, so the single
 * SQLite writer serialises concurrent imports and keeps: two admissions cannot
 * spend the same free bytes.
 */

/** Size the ledger records for an item's small "state" record (workflow, progress and its change history). */
export const STATE_RECORD_BYTES = 64;

export class StorageFull extends HttpError {
  readonly reason: "quota" | "disk";
  readonly accountId: string;
  constructor(reason: "quota" | "disk", accountId: string, mode: "self" | "hosted") {
    super(507, reason === "quota" ? "quota_full" : "disk_reserve",
      reason === "quota"
        ? mode === "hosted"
          ? "Your storage allowance is full. Reading and organising still work, but new items and copies are paused."
          : "This PURSS has used all the space it is allowed. Reading and organising still work; new items and copies are paused until its administrator gives it more."
        : "PURSS can't save new items and copies right now because there isn't enough free space. Nothing you kept was removed.");
    this.reason = reason;
    this.accountId = accountId;
  }
}

/**
 * Record that growth is paused. Called after the failed mutation's transaction has
 * rolled back (writing it inside that transaction would be rolled back with it).
 */
export function markPaused(app: App, err: StorageFull): void {
  app.db.run("UPDATE storage_accounts SET paused_reason = ? WHERE account_id = ?", err.reason, err.accountId);
}

/**
 * What the account has stored: the sizes of its live objects, read from a total that is updated, in the same transaction,
 * wherever an object is admitted or released (`addUsedBytes`). Adding the objects up for every admission made a large
 * account's sync slower the more it held. `recountUsedBytes` checks the total against the objects.
 */
export function usedBytes(app: App, accountId: string): number {
  return app.db.get<{ n: number }>("SELECT used_bytes AS n FROM storage_accounts WHERE account_id = ?", accountId)?.n ?? 0;
}

/** Add to, or take from, the account's used-bytes total. Call it in the transaction that writes or releases the stored object. */
export function addUsedBytes(app: App, accountId: string, delta: number): void {
  if (app.db.run("UPDATE storage_accounts SET used_bytes = used_bytes + ? WHERE account_id = ?", delta, accountId).changes === 0) {
    app.db.run("INSERT INTO storage_accounts (account_id, used_bytes) VALUES (?, ?)", accountId, delta);
  }
}

/** The sizes of the account's live objects, added up from the objects themselves (an index alone answers). */
export function countedBytes(app: App, accountId: string): number {
  return app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE account_id = ? AND released_at IS NULL", accountId)!.n;
}

/**
 * Compare the account's used-bytes total with a recount of its objects and put the total right. Returns the total as it
 * was and the recount; they differ only if something wrote objects without going through `admitObject` and
 * `releaseObject`.
 */
export function recountUsedBytes(app: App, accountId: string): { tracked: number; counted: number } {
  const tracked = usedBytes(app, accountId);
  const counted = countedBytes(app, accountId);
  if (tracked !== counted) addUsedBytes(app, accountId, counted - tracked);
  return { tracked, counted };
}

export function reservedBytes(app: App, accountId: string): number {
  return app.db.get<{ n: number }>(
    "SELECT COALESCE(SUM(bytes), 0) AS n FROM reservations WHERE account_id = ? AND settled_at IS NULL AND released_at IS NULL AND expires_at > ?",
    accountId, nowIso(),
  )!.n;
}

export function allocation(app: App, accountId: string): number | null {
  return app.db.get<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", accountId)?.allocation_bytes ?? null;
}

export type DiskInfo = { freeBytes: number | null; totalBytes: number | null };

export function diskInfo(app: App): DiskInfo {
  try {
    const s = statfsSync(app.config.dataDir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

/** Test hook: lets integration tests simulate a nearly full disk without filling one. */
export const diskOverride: { freeBytes: number | null } = { freeBytes: null };

function diskBlocks(app: App, bytes: number): boolean {
  const free = diskOverride.freeBytes ?? diskInfo(app).freeBytes;
  if (free === null) return false; // unknown is reported as unknown, not as full
  return free - bytes < app.config.diskReserveBytes;
}

/** Refuses to store a file (an upload, a staged import) that would eat into the disk's reserve; it isn't account content, so nothing is paused. */
export function assertDiskRoom(app: App, bytes: number): void {
  if (diskBlocks(app, bytes)) throw new HttpError(507, "disk_reserve", "There isn't enough free space to store this file right now. Nothing you kept was removed.");
}

/**
 * Check whether `bytes` of growth can be admitted. Control writes (workflow, progress,
 * pinning an existing item) may use a small bounded headroom beyond the allocation. `onDisk`:
 * the bytes are already written to this disk (a downloaded file admitted on completion), so free
 * space already reflects them and only the reserve is checked.
 */
export function checkGrowth(app: App, accountId: string, bytes: number, opts: { control?: boolean; reservationId?: string; onDisk?: boolean } = {}): void {
  if (bytes <= 0) return;
  if (!opts.control && diskBlocks(app, opts.onDisk ? 0 : bytes)) throw new StorageFull("disk", accountId, app.config.mode);
  const alloc = allocation(app, accountId);
  if (alloc === null) return;
  const own = opts.reservationId
    ? app.db.get<{ bytes: number }>("SELECT bytes FROM reservations WHERE id = ? AND settled_at IS NULL AND released_at IS NULL AND expires_at > ?", opts.reservationId, nowIso())?.bytes ?? 0
    : 0;
  const committed = usedBytes(app, accountId) + reservedBytes(app, accountId) - own;
  const limit = alloc + (opts.control ? CONTROL_HEADROOM_BYTES : 0);
  if (committed + bytes > limit) throw new StorageFull("quota", accountId, app.config.mode);
}

/** Clear a pause once growth fits again (called after deletions or allocation changes). */
export function refreshPause(app: App, accountId: string): void {
  const row = app.db.get<{ paused_reason: string | null }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", accountId);
  if (!row?.paused_reason) return;
  try {
    checkGrowth(app, accountId, 1);
    app.db.run("UPDATE storage_accounts SET paused_reason = NULL WHERE account_id = ?", accountId);
  } catch (err) {
    if (!(err instanceof StorageFull)) throw err; // still paused; anything else (a transaction the database ended) is not for this to hide
  }
}

export type ObjectSpec = {
  accountId: string;
  workspaceId: string;
  kind: StoredObjectKind;
  refId: string;
  itemId?: string | null;
  sourceId?: string | null;
  bytes: number;
  reason: string;
  control?: boolean;
  reservationId?: string;
  /** The bytes are already on this disk (see checkGrowth). */
  onDisk?: boolean;
};

/** Admit and record a stored object. Must run inside the mutation's transaction. */
export function admitObject(app: App, spec: ObjectSpec): string {
  checkGrowth(app, spec.accountId, spec.bytes, { control: spec.control, reservationId: spec.reservationId, onDisk: spec.onDisk });
  const id = newId("obj");
  const now = nowIso();
  app.db.run(
    "INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, source_id, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, spec.accountId, spec.workspaceId, spec.kind, spec.refId, spec.itemId ?? null, spec.sourceId ?? null, spec.bytes, now,
  );
  app.db.run("INSERT INTO usage_events (id, account_id, idempotency_key, object_id, delta_bytes, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    newId("use"), spec.accountId, `admit:${id}`, id, spec.bytes, spec.reason, now);
  addUsedBytes(app, spec.accountId, spec.bytes);
  if (spec.reservationId) settleReservation(app, spec.reservationId);
  return id;
}

/** Release an object's bytes (explicit deletion only). Idempotent. */
export function releaseObject(app: App, kind: StoredObjectKind, refId: string, reason: string): number {
  const row = app.db.get<{ id: string; account_id: string; bytes: number }>(
    "SELECT id, account_id, bytes FROM stored_objects WHERE kind = ? AND ref_id = ? AND released_at IS NULL", kind, refId);
  if (!row) return 0;
  const now = nowIso();
  app.db.run("UPDATE stored_objects SET released_at = ? WHERE id = ?", now, row.id);
  app.db.run("INSERT OR IGNORE INTO usage_events (id, account_id, idempotency_key, object_id, delta_bytes, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    newId("use"), row.account_id, `release:${row.id}`, row.id, -row.bytes, reason, now);
  addUsedBytes(app, row.account_id, -row.bytes);
  return row.bytes;
}

export function reserve(app: App, accountId: string, bytes: number, purpose: string, idempotencyKey: string, ttlSeconds = 3600): string {
  const existing = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ?", idempotencyKey);
  if (existing) return existing.id;
  checkGrowth(app, accountId, bytes);
  const id = newId("rsv");
  app.db.run("INSERT INTO reservations (id, account_id, bytes, purpose, idempotency_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, accountId, bytes, purpose, idempotencyKey, nowIso(), addSeconds(ttlSeconds));
  return id;
}

export function settleReservation(app: App, id: string): void {
  app.db.run("UPDATE reservations SET settled_at = ? WHERE id = ? AND settled_at IS NULL AND released_at IS NULL", nowIso(), id);
}

export function releaseReservation(app: App, id: string): void {
  app.db.run("UPDATE reservations SET released_at = ? WHERE id = ? AND settled_at IS NULL AND released_at IS NULL", nowIso(), id);
}

/** Expired, unsettled reservations no longer count (expiry is checked at read time); mark them released. */
export function expireReservations(app: App): number {
  const now = nowIso();
  return app.db.run("UPDATE reservations SET released_at = ? WHERE settled_at IS NULL AND released_at IS NULL AND expires_at <= ?", now, now).changes;
}

/** What a person is told when their account's growth is paused (full allowance or full disk); null when it is not. */
export function pausedReason(app: App, accountId: string): string | null {
  const paused = app.db.get<{ paused_reason: string | null }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", accountId)?.paused_reason ?? null;
  return paused === "quota"
    ? app.config.mode === "hosted"
      ? "Your storage allowance is full, so new items and copies are paused. Reading, organising and deleting still work."
      : "This PURSS has used all the space it is allowed, so new items and copies are paused until its administrator gives it more. Reading, organising and deleting still work."
    : paused === "disk" ? "PURSS can't save new items and copies right now because there isn't enough free space." : null;
}

/**
 * Compare the ledger with the owned objects (`difference`, which should be 0), and the used-bytes total with a recount of
 * the objects (`trackedDifference`, likewise). With `repair`, a total that has drifted is put right; the ledger is only reported.
 */
export function reconcile(app: App, accountId: string, opts: { repair?: boolean } = {}): { ledger: number; objects: number; difference: number; tracked: number; trackedDifference: number } {
  const ledger = app.db.get<{ n: number }>("SELECT COALESCE(SUM(delta_bytes), 0) AS n FROM usage_events WHERE account_id = ?", accountId)!.n;
  const objects = countedBytes(app, accountId);
  const tracked = usedBytes(app, accountId);
  if (opts.repair && tracked !== objects) addUsedBytes(app, accountId, objects - tracked);
  return { ledger, objects, difference: ledger - objects, tracked, trackedDifference: tracked - objects };
}

export function databaseBytes(app: App): { bytes: number | null; walBytes: number | null } {
  const size = (f: string) => { try { return statSync(f).size; } catch { return null; } };
  return { bytes: size(app.config.dbFile), walBytes: size(app.config.dbFile + "-wal") };
}
