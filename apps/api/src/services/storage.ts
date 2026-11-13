import { statfsSync, statSync } from "node:fs";
import { newId, CONTROL_HEADROOM_BYTES } from "@purss/domain";
import type { StorageSummary, StoredObjectKind } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";

/**
 * Logical storage ledger (plan/17). Account usage = sum of live stored objects, kept as
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
  constructor(reason: "quota" | "disk", accountId: string) {
    super(507, reason === "quota" ? "quota_full" : "disk_reserve",
      reason === "quota"
        ? "This PURSS has used all the space it is allowed. Reading and organising still work; new items and copies are paused until an administrator gives it more."
        : "The server is low on disk space. New items and copies are paused; nothing you kept was removed.");
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
  if (diskBlocks(app, bytes)) throw new HttpError(507, "disk_reserve", "The server is low on disk space, so the file can't be stored. Nothing you kept was removed.");
}

/**
 * Check whether `bytes` of growth can be admitted. Control writes (workflow, progress,
 * pinning an existing item) may use a small bounded headroom beyond the allocation. `onDisk`:
 * the bytes are already written to this disk (a downloaded file admitted on completion), so free
 * space already reflects them and only the reserve is checked.
 */
export function checkGrowth(app: App, accountId: string, bytes: number, opts: { control?: boolean; reservationId?: string; onDisk?: boolean } = {}): void {
  if (bytes <= 0) return;
  if (!opts.control && diskBlocks(app, opts.onDisk ? 0 : bytes)) throw new StorageFull("disk", accountId);
  const alloc = allocation(app, accountId);
  if (alloc === null) return;
  const own = opts.reservationId
    ? app.db.get<{ bytes: number }>("SELECT bytes FROM reservations WHERE id = ? AND settled_at IS NULL AND released_at IS NULL AND expires_at > ?", opts.reservationId, nowIso())?.bytes ?? 0
    : 0;
  const committed = usedBytes(app, accountId) + reservedBytes(app, accountId) - own;
  const limit = alloc + (opts.control ? CONTROL_HEADROOM_BYTES : 0);
  if (committed + bytes > limit) throw new StorageFull("quota", accountId);
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
    // The item row is written before its version's object, so whether the version is current is known here.
    `INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, item_id, source_id, bytes, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'item_version' AND EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = ?) THEN 1 ELSE 0 END, ?)`,
    id, spec.accountId, spec.workspaceId, spec.kind, spec.refId, spec.itemId ?? null, spec.sourceId ?? null, spec.bytes, spec.kind, spec.refId, now,
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

/**
 * Put `stored_objects.is_current` right from the items, for one account or all, and say how many were wrong. The flag is
 * derived (a version is current when an item points at it) and the database keeps it up to date; this is the recount for
 * anything that ever slipped past.
 */
export function recountCurrentFlags(app: App, accountId?: string): number {
  const right = "CASE WHEN EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = stored_objects.ref_id) THEN 1 ELSE 0 END";
  return app.db.run(
    `UPDATE stored_objects SET is_current = ${right} WHERE kind = 'item_version' AND released_at IS NULL${accountId ? " AND account_id = ?" : ""} AND is_current <> ${right}`,
    ...(accountId ? [accountId] : [])).changes;
}

/**
 * Split an account's live objects into kept, feed and other, without looking at objects one by one:
 *  - kept: a version that a basket pins, and the readable copies and kept pictures of items a basket keeps;
 *  - feed: a version that is still its item's current version (`is_current`, which the database keeps up to date), and the
 *    readable copies of items no basket keeps;
 *  - other: everything else (the small state records, superseded versions nothing pins).
 * The account's objects are added up by kind and flag from one index; only the few pinned versions and kept copies are
 * looked up, and subtracted from the group they would otherwise be counted in. (CROSS JOIN fixes the order: start from
 * the pinned ones, then find their objects by id; left to itself the planner walks every readable copy against them.)
 */
export function categories(app: App, accountId: string): { kept: number; feed: number; other: number } {
  let versions = 0, currentVersions = 0, records = 0, captures = 0;
  for (const g of app.db.all<{ kind: string; is_current: number; b: number }>(
    "SELECT kind, is_current, SUM(bytes) AS b FROM stored_objects WHERE account_id = ? AND released_at IS NULL GROUP BY kind, is_current", accountId)) {
    if (g.kind === "item_version") { versions += g.b; if (g.is_current) currentVersions += g.b; }
    else if (g.kind === "capture" || g.kind === "image") captures += g.b; // readable copies and kept pictures go with their item
    else records += g.b;
  }
  const workspaceId = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)?.id ?? null;
  const pinned = workspaceId === null ? { b: 0, current: 0 } : app.db.get<{ b: number; current: number }>(
    `SELECT COALESCE(SUM(o.bytes), 0) AS b, COALESCE(SUM(CASE WHEN o.is_current = 1 THEN o.bytes END), 0) AS current
     FROM (SELECT DISTINCT version_id AS id FROM basket_items WHERE workspace_id = ?) k
     CROSS JOIN stored_objects o ON o.kind = 'item_version' AND o.ref_id = k.id AND o.released_at IS NULL AND o.account_id = ?`, workspaceId, accountId)!;
  const keptCopies = workspaceId === null ? 0 : app.db.get<{ b: number }>(
    `SELECT COALESCE(SUM(o.bytes), 0) AS b
     FROM (SELECT DISTINCT item_id AS id FROM basket_items WHERE workspace_id = ?) k
     CROSS JOIN stored_objects o ON o.kind IN ('capture', 'image') AND o.item_id = k.id AND o.released_at IS NULL AND o.account_id = ?`, workspaceId, accountId)!.b;
  // A readable copy or kept picture that belongs to no item is "other", whatever else holds.
  const strayCopies = captures === 0 ? 0 : app.db.get<{ b: number }>(
    "SELECT COALESCE(SUM(bytes), 0) AS b FROM stored_objects WHERE account_id = ? AND released_at IS NULL AND kind IN ('capture', 'image') AND item_id IS NULL", accountId)!.b;
  return {
    kept: pinned.b + keptCopies,
    feed: currentVersions - pinned.current + (captures - strayCopies - keptCopies),
    other: records + strayCopies + (versions - currentVersions) - (pinned.b - pinned.current),
  };
}

export function summary(app: App, accountId: string): StorageSummary {
  const cats = categories(app, accountId);
  const paused = app.db.get<{ paused_reason: string | null }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", accountId)?.paused_reason ?? null;
  return {
    usedBytes: cats.kept + cats.feed + cats.other,
    allocationBytes: allocation(app, accountId),
    reservedBytes: reservedBytes(app, accountId),
    categories: cats,
    growthPaused: paused !== null,
    pausedReason: paused === "quota"
      ? "This PURSS has used all the space it is allowed, so new items and copies are paused until an administrator gives it more. Reading, organising and deleting still work."
      : paused === "disk" ? "The server is low on disk space, so new items and copies are paused." : null,
    measuredAt: nowIso(),
  };
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
