import { newId, measureBytes } from "@purss/domain";
import type { BulkResult, StateChange, WorkflowState, ItemDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, addSeconds, conflict, notFound, nowIso } from "../http.ts";
import { STATE_RECORD_BYTES, admitObject, markPaused, releaseObject, StorageFull } from "./storage.ts";
import { enqueue } from "./jobs.ts";
import { VISIBLE_SOURCE, getItem, scopeClause } from "./items.ts";
import type { SqlParam } from "../db/database.ts";
import { queueCapture } from "./captures.ts";
import { queueItemImages } from "./images.ts";

export type UndoOp =
  | { type: "workflow"; itemId: string; workflow: WorkflowState }
  | { type: "fresh"; itemId: string; fresh: boolean }
  | { type: "freshSet"; itemIds: string[] }
  | { type: "keep"; itemId: string; basketId: string }
  | { type: "unkeep"; itemId: string; basketId: string }
  | { type: "progress"; itemId: string; progress: number };

/** Whose item it is; what the workflow log, the storage record and read mirroring need. */
type Owner = Pick<Principal, "accountId" | "workspaceId">;

/** An AI filter setting an item to one of these has dealt with it, so it is no longer New. (The person's own changes always clear it.) */
const SEEN_WORKFLOWS: ReadonlySet<WorkflowState> = new Set<WorkflowState>(["finished", "ignored"]);

type OwnedItem = { id: string; url: string | null; source_id: string | null; current_version_id: string; workflow: WorkflowState; fresh: number; revision: number; progress: number; opened_at: string | null; is_private: number | null };
type OwnedBasket = { id: string; capture_mode: "metadata" | "text"; name: string };

function ownItem(app: App, p: Principal, itemId: string): OwnedItem {
  const row = app.db.get<OwnedItem>(
    `SELECT i.id, i.url, i.source_id, i.current_version_id, st.workflow, st.fresh, st.revision, st.progress, st.opened_at, s.is_private
     FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.workspace_id = ?`, itemId, p.workspaceId);
  if (!row) throw notFound("That item");
  return row;
}

function ownBasket(app: App, p: Principal, basketId: string): OwnedBasket {
  const b = app.db.get<OwnedBasket>("SELECT id, capture_mode, name FROM baskets WHERE id = ? AND workspace_id = ?", basketId, p.workspaceId);
  if (!b) throw notFound("That basket");
  return b;
}

function saveUndo(app: App, p: Principal, ops: UndoOp[]): string {
  const id = newId("und");
  app.db.run("INSERT INTO undo_tokens (id, workspace_id, ops, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", id, p.workspaceId, JSON.stringify(ops), nowIso(), addSeconds(15 * 60));
  return id;
}

/** Workflow change with optimistic concurrency. Two tabs cannot silently overwrite each other. */
export function changeState(app: App, p: Principal, itemId: string, change: StateChange): { item: ItemDTO; undoToken: string } {
  const undoToken = app.db.tx(() => {
    const cur = ownItem(app, p, itemId);
    if (cur.revision !== change.expectedRevision) {
      throw new HttpError(409, "conflict", "This item changed in another tab or device. It has been refreshed; please try again.");
    }
    const inverse: UndoOp[] = [];
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (change.workflow && change.workflow !== cur.workflow) {
      sets.push("workflow = ?"); params.push(change.workflow);
      inverse.push({ type: "workflow", itemId, workflow: cur.workflow });
      logWorkflow(app, p, itemId, cur.workflow, change.workflow);
      mirrorRead(app, p, [itemId], change.workflow);
    }
    if (change.progress !== undefined) { sets.push("progress = ?"); params.push(change.progress); inverse.push({ type: "progress", itemId, progress: cur.progress }); }
    // The first opening is recorded; opening again changes nothing, so it must not move the state version.
    if (change.opened && !cur.opened_at) { sets.push("opened_at = ?"); params.push(nowIso()); }
    // Opening an item, or doing anything with it (another state, reading partway), means it has been seen: its New marker goes
    // (and comes back with Undo). A change that changes nothing, such as choosing the state it already has, leaves it.
    const seen = change.fresh === false || change.opened === true || inverse.length > 0;
    if (seen && cur.fresh) { sets.push("fresh = 0"); inverse.push({ type: "fresh", itemId, fresh: true }); }
    if (sets.length) {
      // The revision guards workflow and reading progress against stale writers. The New marker and the opened time are separate
      // facts: changing only those does not move it, so a change queued against the revision still applies.
      const moves = inverse.some((op) => op.type === "workflow" || op.type === "progress");
      app.db.run(`UPDATE item_state SET ${sets.join(", ")}, ${moves ? "revision = revision + 1, " : ""}state_version = state_version + 1, updated_at = ? WHERE item_id = ?`, ...params, nowIso(), itemId);
      recordControlWrite(app, p, `state:${itemId}`);
    }
    return saveUndo(app, p, inverse);
  });
  return { item: getItem(app, p, itemId), undoToken };
}

/**
 * Append one row to the account's workflow log, in the transaction that changes the workflow.
 * The item's small "state" record (see recordControlWrite) is what the ledger counts for it, so
 * the log adds no object of its own and nothing is counted twice.
 */
function logWorkflow(app: App, p: Owner, itemId: string, from: WorkflowState, to: WorkflowState): void {
  app.db.run("INSERT INTO state_log (account_id, workspace_id, item_id, from_state, to_state, at) VALUES (?, ?, ?, ?, ?, ?)",
    p.accountId, p.workspaceId, itemId, from, to, nowIso());
  recordControlWrite(app, p, `state:${itemId}`);
}

/**
 * A workflow change a Smart filter makes for the person (plan/36): logged, counted and mirrored to the engine like their own change,
 * without an undo token (they change it back like any other). Becoming Ignored clears the New marker, as it does for them. Call in
 * a transaction, after checking the item is still as the filter expects. Returns the item's revision after the change.
 */
export function setWorkflowByFilter(app: App, owner: Owner, itemId: string, from: WorkflowState, to: WorkflowState): number {
  logWorkflow(app, owner, itemId, from, to);
  mirrorRead(app, owner, [itemId], to);
  app.db.run(`UPDATE item_state SET workflow = ?, ${SEEN_WORKFLOWS.has(to) ? "fresh = 0, " : ""}revision = revision + 1, state_version = state_version + 1, updated_at = ? WHERE item_id = ?`,
    to, nowIso(), itemId);
  return app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", itemId)!.revision;
}

/** State writes count as small "Other" records, admitted with bounded headroom when the quota is full. */
function recordControlWrite(app: App, p: Owner, key: string): void {
  if (app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'record' AND ref_id = ? AND released_at IS NULL", key)) return;
  admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: key, bytes: STATE_RECORD_BYTES, reason: "state", control: true });
}

/** Optional read mirroring to the engine through the outbox. */
function mirrorRead(app: App, p: Owner, itemIds: string[], workflow: WorkflowState): void {
  const read = workflow === "finished" || workflow === "ignored";
  const rows = app.db.all<{ engine_user_id: string; external_id: string }>(
    `SELECT engine_user_id, external_id FROM external_ids WHERE workspace_id = ? AND item_id IN (${itemIds.map(() => "?").join(",")})`, p.workspaceId, ...itemIds);
  const byUser = new Map<string, string[]>();
  for (const r of rows) byUser.set(r.engine_user_id, [...(byUser.get(r.engine_user_id) ?? []), r.external_id]);
  for (const [engineUserId, ids] of byUser) {
    for (let i = 0; i < ids.length; i += 200) {
      enqueue(app, "engine.mark_read", { engineUserId, externalIds: ids.slice(i, i + 200), read }, { accountId: p.accountId, workspaceId: p.workspaceId });
    }
  }
}

/**
 * Which baskets hold an item is part of the copy that caches and the offline pack keep (`basketIds`), so a change to it moves the
 * state version like any other change to the item. The revision stays where it is, and `updated_at` too: Home orders the items
 * in progress by it, and keeping an item is not reading it. It also stores again when the item was last kept, which lists sorted
 * by kept time read (migration 058). Call in the transaction that adds or removes the membership, after it.
 */
export function markMembershipChanged(app: App, workspaceId: string, itemId: string): void {
  app.db.run("UPDATE item_state SET state_version = state_version + 1 WHERE item_id = ? AND workspace_id = ?", itemId, workspaceId);
  app.db.run("UPDATE items SET kept_key = COALESCE((SELECT MAX(kept_at) FROM basket_items WHERE item_id = ?), '') WHERE id = ?", itemId, itemId);
}

export function keepItem(app: App, p: Principal, itemId: string, basketId: string, ops?: UndoOp[]): { captureQueued: boolean; captureNote: string | null } {
  return app.db.tx(() => keepOwned(app, p, ownItem(app, p, itemId), ownBasket(app, p, basketId), ops));
}

/**
 * Keep an item that is this PURSS's in a basket that is, in the caller's transaction. The bulk action calls it straight from its
 * own transaction, with the item as it read it: anything that fails there undoes the whole action, so a savepoint per item would
 * only add work.
 */
function keepOwned(app: App, p: Principal, item: OwnedItem, basket: OwnedBasket, ops?: UndoOp[]): { captureQueued: boolean; captureNote: string | null } {
  const itemId = item.id;
  const basketId = basket.id;
  if (app.db.get("SELECT 1 FROM basket_items WHERE basket_id = ? AND item_id = ?", basketId, itemId)) return { captureQueued: false, captureNote: null };
  const keptAt = nowIso();
  const key = `basket:${basketId}:${itemId}`;
  // The membership pins the existing immutable version; only the small record is new growth.
  admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: key, itemId, bytes: measureBytes({ basketId, itemId, keptAt }), reason: "keep", control: true });
  app.db.run("INSERT INTO basket_items (basket_id, item_id, workspace_id, version_id, kept_at) VALUES (?, ?, ?, ?, ?)", basketId, itemId, p.workspaceId, item.current_version_id, keptAt);
  markMembershipChanged(app, p.workspaceId, itemId);
  ops?.push({ type: "unkeep", itemId, basketId });

  let captureQueued = false;
  let captureNote: string | null = null;
  if (basket.capture_mode === "text" && item.url && !item.is_private) {
    try {
      captureQueued = queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId, url: item.url });
    } catch (err) {
      if (!(err instanceof StorageFull)) throw err;
      markPaused(app, err);
      captureNote = "Kept with its details and feed content. A readable copy wasn't made because this PURSS is out of space.";
    }
  }
  // The pictures of the kept copy follow its readable copy when one is on the way, and are fetched now otherwise.
  if (basket.capture_mode === "text" && !captureQueued) queueItemImages(app, itemId);
  return { captureQueued, captureNote };
}

export function unkeepItem(app: App, p: Principal, itemId: string, basketId: string, ops?: UndoOp[]): boolean {
  return app.db.tx(() => {
    ownItem(app, p, itemId);
    ownBasket(app, p, basketId);
    return unkeepOwned(app, p, itemId, basketId, ops);
  });
}

/** Take an item out of a basket, both known to be this PURSS's, in the caller's transaction (see `keepOwned`). */
function unkeepOwned(app: App, p: Principal, itemId: string, basketId: string, ops?: UndoOp[]): boolean {
  const r = app.db.run("DELETE FROM basket_items WHERE basket_id = ? AND item_id = ?", basketId, itemId);
  if (r.changes) {
    markMembershipChanged(app, p.workspaceId, itemId);
    releaseObject(app, "record", `basket:${basketId}:${itemId}`, "unkeep");
    pruneUnreferencedVersions(app, itemId);
    ops?.push({ type: "keep", itemId, basketId });
  }
  return r.changes > 0;
}

/**
 * Superseded versions exist only while a basket pins them. Once nothing pins one and it isn't
 * the item's current version, it's released (plan/17: release at the last reference).
 */
export function pruneUnreferencedVersions(app: App, itemId: string): number {
  const stale = app.db.all<{ id: string }>(
    `SELECT v.id FROM item_versions v JOIN items i ON i.id = v.item_id
     WHERE v.item_id = ? AND v.id <> i.current_version_id AND NOT EXISTS (SELECT 1 FROM basket_items b WHERE b.version_id = v.id)`, itemId);
  for (const v of stale) {
    releaseObject(app, "item_version", v.id, "superseded version no longer kept");
    app.db.run("DELETE FROM item_versions WHERE id = ?", v.id);
  }
  return stale.length;
}

/** Keeping an item in a basket or taking it out is doing something with it: its New marker goes, and comes back with Undo. */
function clearFreshOnKeep(app: App, itemId: string, ops: UndoOp[]): void {
  const r = app.db.run("UPDATE item_state SET fresh = 0, state_version = state_version + 1, updated_at = ? WHERE item_id = ? AND fresh = 1", nowIso(), itemId);
  if (r.changes) ops.push({ type: "fresh", itemId, fresh: true });
}

export function keepWithUndo(app: App, p: Principal, itemId: string, basketId: string, keep: boolean) {
  const ops: UndoOp[] = [];
  const out = app.db.tx(() => {
    const r = keep ? keepItem(app, p, itemId, basketId, ops) : { captureQueued: false, captureNote: null, removed: unkeepItem(app, p, itemId, basketId, ops) };
    if (ops.length) clearFreshOnKeep(app, itemId, ops);
    return { ...r, undoToken: saveUndo(app, p, ops) };
  });
  emit(app, p.accountId, { type: "storage" });
  return { ...out, item: getItem(app, p, itemId) };
}

export function bulk(app: App, p: Principal, itemIds: string[], action:
  | { type: "workflow"; workflow: WorkflowState } | { type: "clearFresh" } | { type: "keep"; basketId: string } | { type: "unkeep"; basketId: string }): BulkResult {
  const ops: UndoOp[] = [];
  let changed = 0;
  const undoToken = app.db.tx(() => {
    // Asked for after the first item, as keeping that item would: a missing item is reported before a missing basket.
    let basket: OwnedBasket | undefined;
    for (const itemId of itemIds) {
      const cur = ownItem(app, p, itemId);
      if (action.type === "workflow" && cur.workflow !== action.workflow) {
        const seen = cur.fresh === 1;
        app.db.run(`UPDATE item_state SET workflow = ?, ${seen ? "fresh = 0, " : ""}revision = revision + 1, state_version = state_version + 1, updated_at = ? WHERE item_id = ?`, action.workflow, nowIso(), itemId);
        logWorkflow(app, p, itemId, cur.workflow, action.workflow);
        ops.push({ type: "workflow", itemId, workflow: cur.workflow });
        if (seen) ops.push({ type: "fresh", itemId, fresh: true });
        changed++;
      } else if (action.type === "clearFresh" && cur.fresh) {
        app.db.run("UPDATE item_state SET fresh = 0, state_version = state_version + 1, updated_at = ? WHERE item_id = ?", nowIso(), itemId);
        ops.push({ type: "fresh", itemId, fresh: true });
        changed++;
      } else if (action.type === "keep") {
        const before = ops.length;
        basket ??= ownBasket(app, p, action.basketId);
        keepOwned(app, p, cur, basket, ops);
        // Keeping never touches the New marker itself, so an item that wasn't New has none to clear.
        if (ops.length > before) { if (cur.fresh) clearFreshOnKeep(app, itemId, ops); changed++; }
      } else if (action.type === "unkeep") {
        basket ??= ownBasket(app, p, action.basketId);
        if (unkeepOwned(app, p, itemId, action.basketId, ops)) { if (cur.fresh) clearFreshOnKeep(app, itemId, ops); changed++; }
      }
    }
    if (action.type === "workflow" && changed) mirrorRead(app, p, itemIds, action.workflow);
    return saveUndo(app, p, ops);
  });
  emit(app, p.accountId, { type: "items", sourceIds: [], count: 0 });
  return { changed, undoToken };
}

/** Clear freshness markers for a list of items (never changes workflow or reading state). */
export function clearFreshScope(app: App, p: Principal, itemIds: string[]): BulkResult {
  return bulk(app, p, itemIds, { type: "clearFresh" });
}

const CLEAR_PAGE = 500;

/**
 * Clear every New marker in a scope, however many there are: one page of markers per transaction until none are
 * left, and one Undo for the whole. Only the New marker changes; workflow, reading progress and kept items don't.
 */
export function clearFreshAll(app: App, p: Principal, scope: string): { changed: number; undoToken: string | null } {
  const ops: UndoOp[] = [];
  let changed = 0;
  for (;;) {
    const page = app.db.tx(() => {
      const params: SqlParam[] = [p.workspaceId];
      const where = ["i.workspace_id = ?", "st.fresh = 1", scopeClause(app, p, scope, params), VISIBLE_SOURCE];
      const ids = app.db.all<{ id: string }>(
        `SELECT i.id FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id WHERE ${where.join(" AND ")} LIMIT ?`,
        ...params, CLEAR_PAGE).map((r) => r.id);
      if (ids.length) {
        app.db.run(`UPDATE item_state SET fresh = 0, state_version = state_version + 1, updated_at = ? WHERE workspace_id = ? AND fresh = 1 AND item_id IN (${ids.map(() => "?").join(",")})`, nowIso(), p.workspaceId, ...ids);
      }
      return ids;
    });
    if (!page.length) break;
    ops.push({ type: "freshSet", itemIds: page });
    changed += page.length;
  }
  if (!changed) return { changed: 0, undoToken: null };
  const undoToken = saveUndo(app, p, ops);
  emit(app, p.accountId, { type: "items", sourceIds: [], count: 0 });
  return { changed, undoToken };
}

export function applyUndo(app: App, p: Principal, token: string): { applied: number } {
  const row = app.db.get<{ ops: string; expires_at: string }>("SELECT ops, expires_at FROM undo_tokens WHERE id = ? AND workspace_id = ?", token, p.workspaceId);
  if (!row || row.expires_at < nowIso()) throw conflict("That change can no longer be undone.");
  const ops = JSON.parse(row.ops) as UndoOp[];
  app.db.tx(() => {
    for (const op of ops.reverse()) {
      if (op.type === "workflow") {
        const cur = app.db.get<{ workflow: WorkflowState }>("SELECT workflow FROM item_state WHERE item_id = ? AND workspace_id = ?", op.itemId, p.workspaceId);
        app.db.run("UPDATE item_state SET workflow = ?, revision = revision + 1, state_version = state_version + 1, updated_at = ? WHERE item_id = ? AND workspace_id = ?", op.workflow, nowIso(), op.itemId, p.workspaceId);
        if (cur && cur.workflow !== op.workflow) logWorkflow(app, p, op.itemId, cur.workflow, op.workflow);
        mirrorRead(app, p, [op.itemId], op.workflow);
      } else if (op.type === "fresh") {
        app.db.run("UPDATE item_state SET fresh = ?, state_version = state_version + 1, updated_at = ? WHERE item_id = ? AND workspace_id = ?", op.fresh ? 1 : 0, nowIso(), op.itemId, p.workspaceId);
      } else if (op.type === "freshSet") {
        app.db.run(`UPDATE item_state SET fresh = 1, state_version = state_version + 1, updated_at = ? WHERE workspace_id = ? AND item_id IN (${op.itemIds.map(() => "?").join(",")})`, nowIso(), p.workspaceId, ...op.itemIds);
      } else if (op.type === "progress") {
        app.db.run("UPDATE item_state SET progress = ?, revision = revision + 1, state_version = state_version + 1, updated_at = ? WHERE item_id = ? AND workspace_id = ?", op.progress, nowIso(), op.itemId, p.workspaceId);
      } else if (op.type === "keep") {
        keepItem(app, p, op.itemId, op.basketId);
      } else if (op.type === "unkeep") {
        unkeepItem(app, p, op.itemId, op.basketId);
      }
    }
    app.db.run("DELETE FROM undo_tokens WHERE id = ?", token);
  });
  emit(app, p.accountId, { type: "items", sourceIds: [], count: 0 });
  return { applied: ops.length };
}
