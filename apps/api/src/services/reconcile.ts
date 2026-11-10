import type { ReconcileEntryDTO, ReconcileList } from "@purss/domain";
export type { ReconcileEntryDTO, ReconcileList };
import { newId } from "@purss/domain";
import type { SyncEntry } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, badRequest, conflict, notFound, nowIso } from "../http.ts";
import { detectKind, excerpt, findDoi, toText } from "./content.ts";
import { insertItem } from "./items.ts";

/*
 * Reconciliation review (plan/02). When the collection engine is replaced or restored, the
 * entries it sends cannot be trusted to continue the old engine's identifiers. The sync keeps
 * them in a durable queue instead of creating a duplicate library; this is where the owner
 * (or a bulk accept) decides: it is the same item (attach the new engine's identity to the
 * existing item), it is genuinely new, or it should be ignored. Nothing is merged or created
 * without a decision, and ambiguous entries are never suggested as matches.
 */

type QueueRow = { id: string; workspace_id: string; engine_user_id: string; entry: string; candidate_item_id: string | null; status: string; created_at: string };

type Source = { id: string; title: string; kind: string };

function sourceFor(app: App, workspaceId: string, streamId: string): Source | null {
  return app.db.get<Source>("SELECT id, title, kind FROM sources WHERE workspace_id = ? AND engine_stream_id = ?", workspaceId, streamId) ?? null;
}

type Candidate = { itemId: string; reason: string } | { ambiguous: string } | null;

/** The existing item an entry most likely is: the one found at queue time by source + original id, else the single item with the same link. */
function candidateFor(app: App, row: QueueRow, entry: SyncEntry, source: Source | null): Candidate {
  if (row.candidate_item_id && app.db.get("SELECT 1 FROM items WHERE id = ? AND workspace_id = ?", row.candidate_item_id, row.workspace_id)) {
    return { itemId: row.candidate_item_id, reason: "Same source and the same original ID." };
  }
  if (!source || !entry.url) return null;
  const same = app.db.all<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? AND source_id = ? AND url = ?", row.workspace_id, source.id, entry.url);
  if (same.length === 1) return { itemId: same[0]!.id, reason: "Same source and the same link." };
  if (same.length > 1) return { ambiguous: "More than one existing item has this link, so it needs your decision." };
  return null;
}

function toDTO(app: App, row: QueueRow): ReconcileEntryDTO {
  const entry = JSON.parse(row.entry) as SyncEntry;
  const source = sourceFor(app, row.workspace_id, entry.streamId);
  const c = candidateFor(app, row, entry, source);
  let candidate: ReconcileEntryDTO["candidate"] = null;
  if (c && "itemId" in c) {
    const it = app.db.get<{ id: string; title: string; url: string | null; published_at: string | null; kept: number }>(
      "SELECT i.id, i.title, i.url, i.published_at, EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id) AS kept FROM items i WHERE i.id = ?", c.itemId);
    if (it) candidate = { itemId: it.id, title: it.title, url: it.url, publishedAt: it.published_at, kept: it.kept === 1 };
  }
  return {
    id: row.id, createdAt: row.created_at, sourceTitle: source?.title ?? null,
    entry: { title: entry.title, url: entry.url, author: entry.author, publishedAt: entry.publishedAt, summary: excerpt(toText(entry.summaryHtml), 200) },
    candidate,
    suggestion: candidate ? "match" : c && "ambiguous" in c ? "review" : "new",
    reason: c ? ("reason" in c ? c.reason : c.ambiguous) : "Nothing in your library matches this, so it looks new.",
  };
}

export function listReconciliation(app: App, p: Principal, limit = 100): ReconcileList {
  const rows = app.db.all<QueueRow>("SELECT * FROM reconciliation_queue WHERE workspace_id = ? AND status = 'open' ORDER BY created_at, id LIMIT ?", p.workspaceId, limit);
  const total = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_queue WHERE workspace_id = ? AND status = 'open'", p.workspaceId)!.n;
  const entries = rows.map((r) => toDTO(app, r));
  return { entries, total, suggestedMatches: entries.filter((e) => e.suggestion === "match").length };
}

export type ReconcileAction = "match" | "new" | "dismiss";

/** Apply one decision. The whole decision commits or none of it does; a handled entry cannot be handled twice. */
export function resolveEntry(app: App, p: Principal, id: string, action: ReconcileAction, itemId?: string): { status: "matched" | "new" | "dismissed"; itemId: string | null } {
  const out = app.db.tx((): { status: "matched" | "new" | "dismissed"; itemId: string | null } => {
    const row = app.db.get<QueueRow>("SELECT * FROM reconciliation_queue WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
    if (!row) throw notFound("That entry");
    if (row.status !== "open") throw conflict("That entry was already handled.");
    const entry = JSON.parse(row.entry) as SyncEntry;
    const source = sourceFor(app, p.workspaceId, entry.streamId);

    if (action === "dismiss") {
      app.db.run("UPDATE reconciliation_queue SET status = 'dismissed' WHERE id = ?", id);
      return { status: "dismissed", itemId: null };
    }
    const existingMap = app.db.get<{ item_id: string }>("SELECT item_id FROM external_ids WHERE engine_user_id = ? AND external_id = ?", row.engine_user_id, entry.externalId);

    if (action === "match") {
      const c = itemId ? { itemId } : candidateFor(app, row, entry, source);
      const target = c && "itemId" in c ? c.itemId : null;
      if (!target) throw badRequest("Choose which of your items this is.", "choose_item");
      if (!app.db.get("SELECT 1 FROM items WHERE id = ? AND workspace_id = ?", target, p.workspaceId)) throw notFound("That item");
      if (existingMap && existingMap.item_id !== target) throw conflict("This entry has already been linked to a different item.");
      if (!existingMap) {
        app.db.run("INSERT INTO external_ids (id, workspace_id, item_id, engine_user_id, external_id, stream_id, original_guid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          newId("ext"), p.workspaceId, target, row.engine_user_id, entry.externalId, entry.streamId, entry.originalGuid, nowIso());
      }
      app.db.run("UPDATE reconciliation_queue SET status = 'matched', candidate_item_id = ? WHERE id = ?", target, id);
      return { status: "matched", itemId: target };
    }

    // action === "new": create through the core item creation path
    if (existingMap) throw conflict("This entry has already been added.");
    if (app.db.get("SELECT 1 FROM item_tombstones WHERE engine_user_id = ? AND external_id = ?", row.engine_user_id, entry.externalId)) {
      throw conflict("You deleted this item earlier, so it won't be added again. You can dismiss the entry.");
    }
    if (!source) throw new HttpError(409, "source_gone", "The source this belongs to isn't followed any more. You can dismiss the entry.");
    const doi = findDoi(entry.url, entry.summaryHtml, entry.contentHtml);
    const created = insertItem(app, {
      accountId: p.accountId, workspaceId: p.workspaceId, sourceId: source.id,
      kind: detectKind({ sourceKind: source.kind, url: entry.url, doi, enclosures: entry.enclosures }),
      title: entry.title.trim() || excerpt(toText(entry.summaryHtml ?? entry.contentHtml), 80) || "(untitled)",
      url: entry.url, author: entry.author, summaryHtml: entry.summaryHtml, contentHtml: entry.contentHtml, imageUrl: entry.imageUrl,
      durationSeconds: null, doi, curatorNote: null, publishedAt: entry.publishedAt, discoveredAt: entry.crawledAt, enclosures: entry.enclosures,
      fresh: false, // history coming back from a restored engine is not "new since you last looked"
      reason: "reconciled feed item",
    });
    app.db.run("INSERT INTO external_ids (id, workspace_id, item_id, engine_user_id, external_id, stream_id, original_guid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      newId("ext"), p.workspaceId, created.id, row.engine_user_id, entry.externalId, entry.streamId, entry.originalGuid, nowIso());
    app.db.run("UPDATE sources SET last_item_at = (SELECT MAX(COALESCE(published_at, discovered_at)) FROM items WHERE source_id = ?) WHERE id = ?", source.id, source.id);
    app.db.run("UPDATE reconciliation_queue SET status = 'new', candidate_item_id = ? WHERE id = ?", created.id, id);
    return { status: "new", itemId: created.id };
  });
  emit(app, p.accountId, { type: "jobs" });
  if (out.status === "new") {
    emit(app, p.accountId, { type: "items", sourceIds: [], count: 1 });
    emit(app, p.accountId, { type: "storage" });
  }
  return out;
}

/** Accept every entry that has one clear suggested match (all open entries, or only the given ones). Ambiguous or new-looking entries are left for review. */
export function acceptSuggested(app: App, p: Principal, ids?: string[]): { matched: number; skipped: number; remaining: number } {
  let matched = 0;
  let skipped = 0;
  const wanted = ids ? new Set(ids) : null;
  let after = "";
  for (;;) {
    const rows = app.db.all<QueueRow>("SELECT * FROM reconciliation_queue WHERE workspace_id = ? AND status = 'open' AND id > ? ORDER BY id LIMIT 200", p.workspaceId, after);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      if (wanted && !wanted.has(row.id)) continue;
      const entry = JSON.parse(row.entry) as SyncEntry;
      const c = candidateFor(app, row, entry, sourceFor(app, p.workspaceId, entry.streamId));
      if (!c || !("itemId" in c)) { skipped++; continue; }
      try {
        resolveEntry(app, p, row.id, "match", c.itemId);
        matched++;
      } catch (err) {
        if (!(err instanceof HttpError) || err.status >= 500) throw err;
        skipped++; // handled elsewhere in the meantime, or linked to a different item
      }
    }
  }
  const remaining = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_queue WHERE workspace_id = ? AND status = 'open'", p.workspaceId)!.n;
  return { matched, skipped, remaining };
}
