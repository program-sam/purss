import { ANNOTATIONS_PER_ITEM, measureBytes } from "@purss/domain";
import type { AnnotationDTO, AnnotationList, AnnotationWriteResult, annotationPutSchema } from "@purss/domain";
import type { z } from "zod";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { badRequest, notFound, nowIso } from "../http.ts";
import { admitObject, releaseObject } from "./storage.ts";
import { foldForSearch } from "./search-text.ts";

/*
 * The person's own highlights and notes on items (plan/26). An annotation is not workflow, not
 * collection or basket membership and not a retention pin: it pins no version and makes no copy.
 * Its quote is stored on it, so it outlives the text it was made on. Each live annotation is one
 * small "Other" record in the storage ledger (`annotation:<id>`, with the item, so permanent
 * deletion releases it), admitted as a control write like workflow changes.
 *
 * IDs come from the client; every write carries the time it was made and the later write wins
 * (ties keep what is stored). A removal leaves a tombstone without the text, kept as long as the
 * item, so an older write that arrives late can't bring it back however late it is. An id the server
 * has no row for was never written, so a write for it is accepted whatever the device's clock says.
 * `received_at` is when the server last accepted a write, in server time; the item's `annotatedAt`
 * is the latest of them.
 */

/** Items with at least one live annotation; for queries over items `i`. */
export const HAS_ANNOTATIONS = "EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = i.id AND a.deleted_at IS NULL)";

type Row = {
  seq: number; id: string; workspace_id: string; item_id: string; kind: "highlight" | "note";
  quote_exact: string | null; quote_prefix: string | null; quote_suffix: string | null; pos_start: number | null; pos_end: number | null;
  target_kind: "capture" | "version" | null; target_id: string | null; body: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
};
const COLUMNS = "seq, id, workspace_id, item_id, kind, quote_exact, quote_prefix, quote_suffix, pos_start, pos_end, target_kind, target_id, body, created_at, updated_at, deleted_at";

/** Put an annotation's text into the search index, folded like the items' (search-text.ts). Every writer of `annotations_fts` goes through here. */
export function indexAnnotation(app: App, seq: number, quote: string | null, body: string | null): void {
  app.db.run("DELETE FROM annotations_fts WHERE rowid = ?", seq);
  app.db.run("INSERT INTO annotations_fts (rowid, quote, body) VALUES (?, ?, ?)", seq, foldForSearch(quote ?? ""), foldForSearch(body ?? ""));
}

export function toAnnotationDTO(r: Row): AnnotationDTO {
  return {
    id: r.id, itemId: r.item_id, kind: r.kind,
    quote: r.quote_exact !== null ? { exact: r.quote_exact, prefix: r.quote_prefix ?? "", suffix: r.quote_suffix ?? "" } : null,
    position: r.pos_start !== null && r.pos_end !== null ? { start: r.pos_start, end: r.pos_end } : null,
    target: r.target_kind && r.target_id ? { kind: r.target_kind, id: r.target_id } : null,
    body: r.body, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function ownItem(app: App, p: Principal, itemId: string): void {
  if (!app.db.get("SELECT 1 FROM items WHERE id = ? AND workspace_id = ?", itemId, p.workspaceId)) throw notFound("That item");
}

/** The row with this id, only when it belongs to this PURSS and item; another's is "not found", never overwritten. */
function ownRow(app: App, p: Principal, itemId: string, id: string): Row | null {
  const row = app.db.get<Row>(`SELECT ${COLUMNS} FROM annotations WHERE id = ?`, id);
  if (!row) return null;
  if (row.workspace_id !== p.workspaceId || row.item_id !== itemId) throw notFound("That note");
  return row;
}

/** A write's time as stored: the client's clock, but never later than now, so a fast clock can't win every future write. */
function writeTime(raw: string): string {
  return new Date(Math.min(Date.parse(raw), Date.now())).toISOString();
}

/** Live annotations of one item, in the order they were made. */
export function listAnnotations(app: App, p: Principal, itemId: string): AnnotationList {
  ownItem(app, p, itemId);
  const rows = app.db.all<Row>(`SELECT ${COLUMNS} FROM annotations WHERE item_id = ? AND workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id`, itemId, p.workspaceId);
  return { itemId, annotations: rows.map(toAnnotationDTO) };
}

/**
 * Create or replace an annotation (idempotent: the same write again changes nothing). A write older
 * than the stored one is ignored and the stored one is returned with `applied: false`.
 */
export function putAnnotation(app: App, p: Principal, itemId: string, id: string, input: z.infer<typeof annotationPutSchema>): AnnotationWriteResult {
  const out = app.db.tx((): AnnotationWriteResult & { changed: boolean } => {
    ownItem(app, p, itemId);
    const existing = ownRow(app, p, itemId, id);
    const at = writeTime(input.updatedAt);
    if (existing && existing.updated_at >= at) {
      return { annotation: existing.deleted_at ? null : toAnnotationDTO(existing), applied: false, changed: false };
    }
    if (existing && existing.kind !== input.kind) throw badRequest("A highlight can't be turned into a note, or a note into a highlight.");
    if (!existing || existing.deleted_at) {
      const live = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM annotations WHERE item_id = ? AND deleted_at IS NULL", itemId)!.n;
      if (live >= ANNOTATIONS_PER_ITEM) throw badRequest(`An item can have up to ${ANNOTATIONS_PER_ITEM} highlights and notes. Remove some before adding more.`, "too_many");
    }

    const body = input.body !== null && input.body.trim() ? input.body : null;
    const h = input.kind === "highlight" ? input : null;
    // A target is only a label of which text this was made on. Keep it when it names this item's
    // own capture or version; anything else (released meanwhile, or not this item's) is stored as unknown.
    const target = h?.target && (h.target.kind === "capture"
      ? app.db.get("SELECT 1 FROM captures WHERE id = ? AND item_id = ?", h.target.id, itemId)
      : app.db.get("SELECT 1 FROM item_versions WHERE id = ? AND item_id = ?", h.target.id, itemId)) ? h.target : null;
    const createdAt = existing && !existing.deleted_at ? existing.created_at : at;
    const values = [
      input.kind, h?.quote.exact ?? null, h?.quote.prefix ?? null, h?.quote.suffix ?? null, h?.position?.start ?? null, h?.position?.end ?? null,
      target?.kind ?? null, target?.id ?? null, body, createdAt, at,
    ] as const;
    let seq: number;
    if (existing) {
      app.db.run(`UPDATE annotations SET kind = ?, quote_exact = ?, quote_prefix = ?, quote_suffix = ?, pos_start = ?, pos_end = ?, target_kind = ?, target_id = ?,
        body = ?, created_at = ?, updated_at = ?, deleted_at = NULL, received_at = ? WHERE seq = ?`, ...values, nowIso(), existing.seq);
      seq = existing.seq;
    } else {
      seq = app.db.run(`INSERT INTO annotations (id, account_id, workspace_id, item_id, kind, quote_exact, quote_prefix, quote_suffix, pos_start, pos_end,
        target_kind, target_id, body, created_at, updated_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, p.accountId, p.workspaceId, itemId, ...values, nowIso()).lastInsertRowid;
    }
    indexAnnotation(app, seq, h?.quote.exact ?? null, body);
    recordBytes(app, p, itemId, id, annotationBytes({ kind: input.kind, quote: h?.quote ?? null, position: h?.position ?? null, target, body, createdAt, updatedAt: at }));
    const row = app.db.get<Row>(`SELECT ${COLUMNS} FROM annotations WHERE seq = ?`, seq)!;
    return { annotation: toAnnotationDTO(row), applied: true, changed: true };
  });
  if (out.changed) emit(app, p.accountId, { type: "annotations", itemId });
  return { annotation: out.annotation, applied: out.applied };
}

/**
 * Remove an annotation: its text is deleted and a tombstone stays. Removing one that is already
 * removed, or that this server never received, succeeds and changes nothing. A removal older than
 * the stored write is ignored.
 */
export function deleteAnnotation(app: App, p: Principal, itemId: string, id: string, updatedAt: string): AnnotationWriteResult {
  const out = app.db.tx((): AnnotationWriteResult & { changed: boolean } => {
    ownItem(app, p, itemId);
    const existing = ownRow(app, p, itemId, id);
    if (!existing) return { annotation: null, applied: true, changed: false };
    const at = writeTime(updatedAt);
    if (existing.updated_at >= at) return { annotation: existing.deleted_at ? null : toAnnotationDTO(existing), applied: false, changed: false };
    const now = nowIso();
    app.db.run(`UPDATE annotations SET quote_exact = NULL, quote_prefix = NULL, quote_suffix = NULL, pos_start = NULL, pos_end = NULL,
      target_kind = NULL, target_id = NULL, body = NULL, updated_at = ?, deleted_at = COALESCE(deleted_at, ?), received_at = ? WHERE seq = ?`, at, now, now, existing.seq);
    if (existing.deleted_at) return { annotation: null, applied: true, changed: false };
    app.db.run("DELETE FROM annotations_fts WHERE rowid = ?", existing.seq);
    releaseObject(app, "record", `annotation:${id}`, "annotation removed");
    return { annotation: null, applied: true, changed: true };
  });
  if (out.changed) emit(app, p.accountId, { type: "annotations", itemId });
  return { annotation: out.annotation, applied: out.applied };
}

/** Measured size of an annotation's stored fields (plan/17's canonical JSON rule). */
export function annotationBytes(a: Omit<AnnotationDTO, "id" | "itemId">): number {
  return measureBytes({ kind: a.kind, quote: a.quote, position: a.position, target: a.target, body: a.body, createdAt: a.createdAt, updatedAt: a.updatedAt });
}

/** The ledger holds one record per live annotation at its current measured size. */
function recordBytes(app: App, p: Principal, itemId: string, id: string, bytes: number): void {
  const key = `annotation:${id}`;
  const cur = app.db.get<{ bytes: number }>("SELECT bytes FROM stored_objects WHERE kind = 'record' AND ref_id = ? AND released_at IS NULL", key);
  if (cur?.bytes === bytes) return;
  if (cur) releaseObject(app, "record", key, "annotation changed");
  admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: key, itemId, bytes, reason: "annotation", control: true });
}

/** Inside deleteItemNow's transaction: the item's annotations and their search entries go with it (their ledger records are released there). */
export function deleteItemAnnotations(app: App, itemId: string): void {
  for (const a of app.db.all<{ seq: number }>("SELECT seq FROM annotations WHERE item_id = ?", itemId)) app.db.run("DELETE FROM annotations_fts WHERE rowid = ?", a.seq);
  app.db.run("DELETE FROM annotations WHERE item_id = ?", itemId);
}

/** Number of live annotations on each of these items (only the ones that have any). */
export function annotationCounts(app: App, itemIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500);
    for (const r of app.db.all<{ item_id: string; n: number }>(
      `SELECT item_id, COUNT(*) AS n FROM annotations WHERE deleted_at IS NULL AND item_id IN (${chunk.map(() => "?").join(",")}) GROUP BY item_id`, ...chunk)) {
      out.set(r.item_id, r.n);
    }
  }
  return out;
}

