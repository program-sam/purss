import { newId, checkQuery } from "@purss/domain";
import type { BasketDTO, CollectionDTO, DeletePreview, StoredObjectKind, ViewMode } from "@purss/domain";
import type { z } from "zod";
import type { basketCreateSchema, basketPatchSchema, collectionCreateSchema, collectionPatchSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { addSeconds, badRequest, notFound, nowIso } from "../http.ts";
import { randomToken } from "../secrets.ts";
import { refreshPause, releaseObject, releaseReservation } from "./storage.ts";
import { compileQuery } from "./items.ts";
import { itemCounts } from "./counts.ts";
import { markMembershipChanged, pruneUnreferencedVersions } from "./state.ts";
import { forgetPlayback } from "./media.ts";
import { annotationCounts, deleteItemAnnotations } from "./annotations.ts";
import type { SqlParam } from "../db/database.ts";
import { assertRoom } from "./plans.ts";
import { forgetCollectionFilter, forgetItemVerdicts } from "./ai-access.ts";

// ---------- collections ----------

type CollectionRow = { id: string; name: string; emoji: string | null; mode: CollectionDTO["mode"]; view: ViewMode; position: number; show_on_home: number; query: string | null };

export function listCollections(app: App, p: Principal): CollectionDTO[] {
  const rows = app.db.all<CollectionRow>("SELECT id, name, emoji, mode, view, position, show_on_home, query FROM collections WHERE workspace_id = ? ORDER BY position, created_at", p.workspaceId);
  const sourceMode = rows.some((r) => r.mode === "sources");
  // A collection of sources adds up its sources' counts; the PURSS is counted once for all of them.
  const counts = sourceMode ? itemCounts(app, p.workspaceId) : null;
  const filtered = new Set(app.db.all<{ collection_id: string }>("SELECT collection_id FROM ai_filters WHERE workspace_id = ? AND enabled = 1 AND collection_id IS NOT NULL", p.workspaceId).map((x) => x.collection_id));
  return rows.map((r) => {
    const sourceIds = app.db.all<{ source_id: string }>("SELECT source_id FROM collection_sources WHERE collection_id = ?", r.id).map((x) => x.source_id);
    const n = r.mode === "sources" && counts
      ? { fresh: counts.sum(sourceIds, (w, fresh) => w !== "ignored" && fresh), items: counts.sum(sourceIds, (w) => w !== "ignored") }
      : countQueryCollection(app, p, r);
    return {
      id: r.id, name: r.name, emoji: r.emoji, mode: r.mode, view: r.view, position: r.position, showOnHome: r.show_on_home === 1,
      sourceIds, query: r.query ? JSON.parse(r.query) : null, freshCount: n.fresh, itemCount: n.items, aiFiltered: filtered.has(r.id),
    };
  });
}

/** A collection defined by a query has no sources to add up: its items are counted where they are. */
function countQueryCollection(app: App, p: Principal, r: CollectionRow): { fresh: number; items: number } {
  const params: SqlParam[] = [p.workspaceId];
  const q = checkQuery(r.query ? JSON.parse(r.query) : null);
  const clause = q.ok ? compileQuery(q.query, params, p.workspaceId) : "0";
  return app.db.get<{ fresh: number; items: number }>(
    `SELECT COALESCE(SUM(st.fresh), 0) AS fresh, COUNT(*) AS items FROM items i JOIN item_state st ON st.item_id = i.id
     WHERE i.workspace_id = ? AND st.workflow <> 'ignored' AND ${clause}`, ...params)!;
}

/** Names are how people find their collections and baskets; two with the same name are confusing. */
function assertUniqueName(app: App, table: "collections" | "baskets", workspaceId: string, name: string, exceptId?: string): void {
  const clash = app.db.get("SELECT 1 FROM " + table + " WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?)) AND id <> ?", workspaceId, name, exceptId ?? "");
  if (clash) throw badRequest(`You already have a ${table === "baskets" ? "basket" : "collection"} called “${name.trim()}”. Pick another name.`, "duplicate_name");
}

function nextPosition(app: App, table: "collections" | "baskets", workspaceId: string): number {
  return app.db.get<{ n: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} WHERE workspace_id = ?`, workspaceId)!.n;
}

function validateSources(app: App, p: Principal, ids: string[]): void {
  for (const id of ids) if (!app.db.get("SELECT 1 FROM sources WHERE id = ? AND workspace_id = ?", id, p.workspaceId)) throw notFound("That source");
}

export function createCollection(app: App, p: Principal, input: z.infer<typeof collectionCreateSchema>): CollectionDTO {
  if (input.mode === "query") {
    const q = checkQuery(input.query);
    if (!q.ok) throw badRequest(q.message);
  }
  validateSources(app, p, input.sourceIds);
  assertUniqueName(app, "collections", p.workspaceId, input.name);
  const id = newId("col");
  app.db.tx(() => {
    assertRoom(app, p.accountId, "collections");
    // A collection of sources starts on Home; a filter collection starts off it (a filter can match anything, so putting it on Home is a choice).
    app.db.run("INSERT INTO collections (id, workspace_id, name, emoji, mode, view, query, show_on_home, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, p.workspaceId, input.name, input.emoji, input.mode, input.view, input.mode === "query" ? JSON.stringify(input.query) : null, input.mode === "query" ? 0 : 1, nextPosition(app, "collections", p.workspaceId), nowIso());
    if (input.mode === "sources") for (const s of input.sourceIds) app.db.run("INSERT OR IGNORE INTO collection_sources (collection_id, source_id) VALUES (?, ?)", id, s);
  });
  emit(app, p.accountId, { type: "source", sourceId: "" });
  return listCollections(app, p).find((c) => c.id === id)!;
}

export function patchCollection(app: App, p: Principal, id: string, patch: z.infer<typeof collectionPatchSchema>): CollectionDTO {
  const c = app.db.get<{ mode: string; position: number }>("SELECT mode, position FROM collections WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!c) throw notFound("That collection");
  app.db.tx(() => {
    if (patch.name !== undefined) { assertUniqueName(app, "collections", p.workspaceId, patch.name, id); app.db.run("UPDATE collections SET name = ? WHERE id = ?", patch.name, id); }
    if (patch.emoji !== undefined) app.db.run("UPDATE collections SET emoji = ? WHERE id = ?", patch.emoji, id);
    if (patch.view !== undefined) app.db.run("UPDATE collections SET view = ? WHERE id = ?", patch.view, id);
    if (patch.showOnHome !== undefined) app.db.run("UPDATE collections SET show_on_home = ? WHERE id = ?", patch.showOnHome ? 1 : 0, id);
    if (patch.query !== undefined) {
      if (c.mode !== "query") throw badRequest("Only filter collections have a filter.");
      const q = checkQuery(patch.query);
      if (!q.ok) throw badRequest(q.message);
      app.db.run("UPDATE collections SET query = ? WHERE id = ?", JSON.stringify(q.query), id);
    }
    if (patch.sourceIds !== undefined) {
      if (c.mode !== "sources") throw badRequest("This collection doesn't group sources.");
      validateSources(app, p, patch.sourceIds);
      app.db.run("DELETE FROM collection_sources WHERE collection_id = ?", id);
      for (const s of new Set(patch.sourceIds)) app.db.run("INSERT INTO collection_sources (collection_id, source_id) VALUES (?, ?)", id, s);
    }
    if (patch.position !== undefined && patch.position !== c.position) reorder(app, "collections", p.workspaceId, id, patch.position);
  });
  emit(app, p.accountId, { type: "source", sourceId: "" });
  return listCollections(app, p).find((x) => x.id === id)!;
}

function reorder(app: App, table: "collections" | "baskets", workspaceId: string, id: string, to: number): void {
  const ids = app.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE workspace_id = ? ORDER BY position, created_at`, workspaceId).map((r) => r.id).filter((x) => x !== id);
  ids.splice(Math.min(to, ids.length), 0, id);
  ids.forEach((x, i) => app.db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, i, x));
}

/** A page an administrator took down stays, with its reports, until they restore it; so does what it shares. */
const TAKEN_DOWN_TARGET = "An administrator took this one's shared page down after a report, so it can't be deleted until they restore the page.";

/** Deleting a collection removes the grouping only; sources, items and baskets stay. Its shared page goes with it. */
export function deleteCollection(app: App, p: Principal, id: string): void {
  const r = app.db.tx(() => {
    if (app.db.get("SELECT 1 FROM shares WHERE target_kind = 'collection' AND target_id = ? AND workspace_id = ? AND taken_down_at IS NOT NULL", id, p.workspaceId)) throw badRequest(TAKEN_DOWN_TARGET, "taken_down");
    forgetCollectionFilter(app, p.workspaceId, id);
    const out = app.db.run("DELETE FROM collections WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
    if (out.changes) app.db.run("DELETE FROM shares WHERE target_kind = 'collection' AND target_id = ?", id);
    return out;
  });
  if (!r.changes) throw notFound("That collection");
  emit(app, p.accountId, { type: "source", sourceId: "" });
}

// ---------- baskets ----------

export function listBaskets(app: App, p: Principal): BasketDTO[] {
  return app.db.all<{ id: string; name: string; capture_mode: BasketDTO["captureMode"]; position: number; n: number }>(
    "SELECT b.id, b.name, b.capture_mode, b.position, (SELECT COUNT(*) FROM basket_items x WHERE x.basket_id = b.id) AS n FROM baskets b WHERE b.workspace_id = ? ORDER BY b.position, b.created_at",
    p.workspaceId,
  ).map((b) => ({ id: b.id, name: b.name, captureMode: b.capture_mode, position: b.position, itemCount: b.n }));
}

export function createBasket(app: App, p: Principal, input: z.infer<typeof basketCreateSchema>): BasketDTO {
  assertUniqueName(app, "baskets", p.workspaceId, input.name);
  const id = newId("bsk");
  app.db.run("INSERT INTO baskets (id, workspace_id, name, capture_mode, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id, p.workspaceId, input.name, input.captureMode, nextPosition(app, "baskets", p.workspaceId), nowIso());
  return listBaskets(app, p).find((b) => b.id === id)!;
}

export function patchBasket(app: App, p: Principal, id: string, patch: z.infer<typeof basketPatchSchema>): BasketDTO {
  const b = app.db.get<{ position: number }>("SELECT position FROM baskets WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!b) throw notFound("That basket");
  app.db.tx(() => {
    if (patch.name !== undefined) { assertUniqueName(app, "baskets", p.workspaceId, patch.name, id); app.db.run("UPDATE baskets SET name = ? WHERE id = ?", patch.name, id); }
    if (patch.captureMode !== undefined) app.db.run("UPDATE baskets SET capture_mode = ? WHERE id = ?", patch.captureMode, id);
    if (patch.position !== undefined && patch.position !== b.position) reorder(app, "baskets", p.workspaceId, id, patch.position);
  });
  return listBaskets(app, p).find((x) => x.id === id)!;
}

export function basketDeletePreview(app: App, p: Principal, id: string): { items: number; onlyHere: number; confirmToken: string } {
  if (!app.db.get("SELECT 1 FROM baskets WHERE id = ? AND workspace_id = ?", id, p.workspaceId)) throw notFound("That basket");
  const items = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items WHERE basket_id = ?", id)!.n;
  const onlyHere = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items b WHERE b.basket_id = ? AND NOT EXISTS (SELECT 1 FROM basket_items o WHERE o.item_id = b.item_id AND o.basket_id <> b.basket_id)", id)!.n;
  const confirmToken = randomToken(18);
  app.db.run("INSERT INTO confirm_tokens (token, workspace_id, purpose, data, expires_at) VALUES (?, ?, 'basket-delete', ?, ?)", confirmToken, p.workspaceId, id, addSeconds(600));
  return { items, onlyHere, confirmToken };
}

/** Deleting a basket removes its memberships (pins); the items themselves stay. Its shared page goes with it. */
export function deleteBasket(app: App, p: Principal, id: string, confirmToken: string): void {
  app.db.tx(() => {
    const t = app.db.get("SELECT 1 FROM confirm_tokens WHERE token = ? AND workspace_id = ? AND purpose = 'basket-delete' AND data = ? AND expires_at > ?", confirmToken, p.workspaceId, id, nowIso());
    if (!t) throw badRequest("Please review what will happen and confirm again.", "confirm");
    if (app.db.get("SELECT 1 FROM shares WHERE target_kind = 'basket' AND target_id = ? AND taken_down_at IS NOT NULL", id)) throw badRequest(TAKEN_DOWN_TARGET, "taken_down");
    const members = app.db.all<{ item_id: string }>("SELECT item_id FROM basket_items WHERE basket_id = ?", id);
    for (const m of members) releaseObject(app, "record", `basket:${id}:${m.item_id}`, "basket deleted");
    app.db.run("DELETE FROM basket_items WHERE basket_id = ?", id);
    for (const m of members) markMembershipChanged(app, p.workspaceId, m.item_id);
    for (const m of members) pruneUnreferencedVersions(app, m.item_id);
    app.db.run("DELETE FROM shares WHERE target_kind = 'basket' AND target_id = ?", id);
    app.db.run("DELETE FROM baskets WHERE id = ?", id);
    app.db.run("DELETE FROM confirm_tokens WHERE token = ?", confirmToken);
  });
  emit(app, p.accountId, { type: "storage" });
}

// ---------- permanent deletion ----------

export function deletePreview(app: App, p: Principal, itemIds: string[]): DeletePreview {
  const kept: DeletePreview["keptItems"] = [];
  const annotated: DeletePreview["annotatedItems"] = [];
  const counts = annotationCounts(app, itemIds);
  let bytes = 0;
  for (const id of itemIds) {
    const item = app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
    if (!item) throw notFound("That item");
    const baskets = app.db.all<{ name: string }>("SELECT b.name FROM basket_items m JOIN baskets b ON b.id = m.basket_id WHERE m.item_id = ?", id).map((b) => b.name);
    if (baskets.length) kept.push({ id, title: item.title, baskets });
    if (counts.get(id)) annotated.push({ id, title: item.title, annotations: counts.get(id)! });
    bytes += app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE item_id = ? AND released_at IS NULL", id)!.n;
  }
  const confirmToken = randomToken(18);
  app.db.run("INSERT INTO confirm_tokens (token, workspace_id, purpose, data, expires_at) VALUES (?, ?, 'item-delete', ?, ?)", confirmToken, p.workspaceId, JSON.stringify(itemIds), addSeconds(600));
  return { itemIds, keptItems: kept, annotatedItems: annotated, releasesBytes: bytes, confirmToken };
}


/**
 * Permanently delete one item inside the caller's transaction (no confirmation here; callers
 * confirm first). Returns the bytes released, or null when the item isn't in this PURSS.
 */
export function deleteItemNow(app: App, p: Pick<Principal, "workspaceId">, id: string): number | null {
  let released = 0;
  const item = app.db.get<{ seq: number }>("SELECT seq FROM items WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!item) return null;
  for (const o of app.db.all<{ kind: StoredObjectKind; ref_id: string }>("SELECT kind, ref_id FROM stored_objects WHERE item_id = ? AND released_at IS NULL", id)) {
    released += releaseObject(app, o.kind, o.ref_id, "deleted");
  }
  for (const m of app.db.all<{ basket_id: string }>("SELECT basket_id FROM basket_items WHERE item_id = ?", id)) {
    released += releaseObject(app, "record", `basket:${m.basket_id}:${id}`, "deleted");
  }
  released += releaseObject(app, "record", `state:${id}`, "deleted");
  for (const e of app.db.all<{ engine_user_id: string; external_id: string }>("SELECT engine_user_id, external_id FROM external_ids WHERE item_id = ?", id)) {
    app.db.run("INSERT OR IGNORE INTO item_tombstones (engine_user_id, external_id, deleted_at) VALUES (?, ?, ?)", e.engine_user_id, e.external_id, nowIso());
  }
  for (const c of app.db.all<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", id)) {
    const r = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ?", `capture:${c.id}`);
    if (r) releaseReservation(app, r.id);
  }
  forgetPlayback(app, id);
  app.db.run("DELETE FROM items_fts WHERE rowid = ?", item.seq);
  deleteItemAnnotations(app, id);
  forgetItemVerdicts(app, id);
  for (const table of ["basket_items", "captures", "item_images", "external_ids", "item_state", "state_log", "reminders"]) {
    app.db.run(`DELETE FROM ${table} WHERE item_id = ?`, id);
  }
  app.db.run("DELETE FROM share_notes WHERE item_id = ?", id);
  app.db.run("UPDATE items SET current_version_id = NULL WHERE id = ?", id);
  app.db.run("DELETE FROM item_versions WHERE item_id = ?", id);
  app.db.run("DELETE FROM notifications WHERE item_id = ?", id);
  app.db.run("DELETE FROM items WHERE id = ?", id);
  return released;
}

/** Permanent, confirmed deletion. Never blocked by a full quota. No undo. */
export function deleteItems(app: App, p: Principal, confirmToken: string): { deleted: number; releasedBytes: number } {
  let released = 0;
  let deleted = 0;
  app.db.tx(() => {
    const t = app.db.get<{ data: string }>("SELECT data FROM confirm_tokens WHERE token = ? AND workspace_id = ? AND purpose = 'item-delete' AND expires_at > ?", confirmToken, p.workspaceId, nowIso());
    if (!t) throw badRequest("Please review what will be deleted and confirm again.", "confirm");
    for (const id of JSON.parse(t.data) as string[]) {
      const r = deleteItemNow(app, p, id);
      if (r === null) continue;
      released += r;
      deleted++;
    }
    app.db.run("DELETE FROM confirm_tokens WHERE token = ?", confirmToken);
  });
  refreshPause(app, p.accountId);
  emit(app, p.accountId, { type: "storage" });
  emit(app, p.accountId, { type: "items", sourceIds: [], count: 0 });
  return { deleted, releasedBytes: released };
}
