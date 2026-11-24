import { QUEUE_STATES, checkQuery, isQueued, stateFilterKeeps } from "@purss/domain";
import type { QueryNode, StateFilter } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { badRequest, notFound } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import { itemCounts } from "./counts.ts";
import type { CellFilter } from "./counts.ts";
import { failedCopy, fullCopy, pendingCopy } from "./capture-state.ts";
import { ftsQuery } from "./search-text.ts";
import { server } from "@purss/translations/server";

/*
 * Which items a view shows. A list, a collection's count, Select all, the statistics and Clear New all ask "which of this PURSS's
 * items are in this scope, with this state filter, that a person sees", and they get one answer, written here:
 *
 *  - the scope: everything, New, the queue, a source, the sources in no collection, a basket, a collection (of sources, or a rule);
 *  - the state filter: everything but Ignored, everything, New, or one workflow state (domain `stateFilterKeeps` says the same of an item
 *    a device holds);
 *  - the visible-source rule: items of sources nobody follows any more are seen only while kept or annotated;
 *  - the readable-copy states a rule can ask for (capture-state.ts).
 *
 * `viewConditions` is the SQL, over `VIEW_FROM`. `viewTotal` is the same answer added up from the PURSS's counts (counts.ts), an
 * optimisation that must agree with the SQL: the tests hold both to a model of what each item is. What narrows a list further (chips,
 * search, muted words, Home's boxes, paging) is the list's own (items.ts), and so is its order.
 */

/** `items i` with its state `st` and its source `s` (an item kept by hand has none), what every condition below is written over. */
export const VIEW_FROM = "FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id";

const KEPT = "EXISTS (SELECT 1 FROM basket_items vb WHERE vb.item_id = i.id)";
const ANNOTATED = "EXISTS (SELECT 1 FROM annotations va WHERE va.item_id = i.id AND va.deleted_at IS NULL)";
/** An item of a source nobody follows is still seen while a basket keeps it or it carries a highlight or note of the person's. */
const KEPT_OR_ANNOTATED = `(${KEPT} OR ${ANNOTATED})`;

/**
 * Items from unfollowed sources leave lists and search unless kept, added by hand, carrying the
 * person's own highlights or notes (all of which must stay findable).
 */
export const VISIBLE_SOURCE = `(i.source_id IS NULL OR s.followed = 1 OR s.kind = 'manual' OR ${KEPT} OR ${ANNOTATED})`;

/**
 * The same for a public page: highlights and notes are private, so an item that only they keep in the person's own lists is not
 * on it. An item without a source is on it only while a basket keeps it.
 */
export const PUBLIC_VISIBLE_SOURCE = `(s.followed = 1 OR s.kind = 'manual' OR ${KEPT})`;

/** The queue is what is put aside (To read, To watch, To listen) and what is started (In progress). */
export const QUEUE_STATES_SQL = `st.workflow IN (${QUEUE_STATES.map((s) => `'${s}'`).join(", ")})`;

export type View = { scope: string; filter: StateFilter };

/** A state filter as SQL over `st` (with its parameters) and as the same decision over the counts' cells. */
function stateFilter(filter: StateFilter): { sql: string; params: SqlParam[]; keep: CellFilter } {
  const keep: CellFilter = (workflow, isNew) => stateFilterKeeps(filter, workflow, isNew);
  switch (filter) {
    case "new": return { sql: "st.is_new = 1", params: [], keep };
    case "all": return { sql: "st.workflow <> 'ignored'", params: [], keep };
    case "all_with_ignored": return { sql: "1", params: [], keep };
    default: return { sql: "st.workflow = ?", params: [filter], keep };
  }
}

/** The part of a scope that depends on an item's state rather than on its source. */
const STATE_SCOPES: Record<string, { sql: string; keep: CellFilter }> = {
  new: { sql: "st.is_new = 1", keep: (workflow, isNew) => stateFilterKeeps("new", workflow, isNew) },
  // Looked up by state in the account's own item_state index (the states are rare), not found by probing every item.
  toread: { sql: QUEUE_STATES_SQL, keep: (workflow) => isQueued(workflow) },
};

/** Followed sources that are in no collection. */
export function looseSources(app: App, accountId: string): string[] {
  return app.db.all<{ id: string }>(
    `SELECT o.id FROM sources o WHERE o.account_id = ? AND o.followed = 1 AND o.kind <> 'manual'
       AND NOT EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.source_id = o.id)`, accountId).map((r) => r.id);
}

export function scopeClause(app: App, p: Principal, scope: string, params: SqlParam[]): string {
  const [kind, id] = scope.split(":") as [string, string | undefined];
  switch (kind) {
    case "all":
    case "home":
      return "1";
    case "new":
      return STATE_SCOPES.new!.sql;
    case "toread":
      // The queue: what is waiting (To read, To watch, To listen) and what is started (In progress).
      params.push(p.accountId);
      return `st.account_id = ? AND ${STATE_SCOPES.toread!.sql}`;
    case "loose": {
      // Followed sources that are in no collection (Home's "Other sources"). When there are none, say so: the planner can't
      // tell that the set is empty and would otherwise walk every item looking for a match.
      const ids = looseSources(app, p.accountId);
      if (!ids.length) return "0";
      params.push(JSON.stringify(ids));
      return "i.source_id IN (SELECT value FROM json_each(?))";
    }
    case "source":
      params.push(id!);
      return "i.source_id = ?";
    case "basket":
      params.push(id!);
      return "EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id AND b.basket_id = ?)";
    case "collection": {
      const c = app.db.get<{ mode: string; query: string | null }>("SELECT mode, query FROM collections WHERE id = ? AND account_id = ?", id!, p.accountId);
      if (!c) throw notFound(server.api.shared.thatCollection);
      if (c.mode === "sources") { params.push(id!); return "i.source_id IN (SELECT source_id FROM collection_sources WHERE collection_id = ?)"; }
      const q = checkQuery(JSON.parse(c.query ?? "null"));
      return q.ok ? compileQuery(q.query, params, p.accountId) : "0";
    }
    default:
      throw badRequest(server.api.items.unknownView);
  }
}

/**
 * The conditions an item meets to be in a view, over `VIEW_FROM`, and their parameters (the account first). A view with no
 * state filter is the scope's items whatever their state (the statistics count them by state).
 */
export function viewConditions(app: App, p: Principal, view: { scope: string; filter?: StateFilter }): { where: string[]; params: SqlParam[] } {
  const params: SqlParam[] = [p.accountId];
  const where = ["i.account_id = ?", scopeClause(app, p, view.scope, params), VISIBLE_SOURCE];
  if (view.filter) {
    const filter = stateFilter(view.filter);
    where.push(filter.sql);
    params.push(...filter.params);
  }
  return { where, params };
}

/**
 * Over `ItemCounts`' share of the followed sources below which a collection is counted from its rows: the rest are added up from the
 * PURSS's counts. Adding up the counts costs the same whatever the collection (about 90 ms at 100,000 items); counting rows costs in
 * proportion (about 70 ms for a tenth of them). Sources are a cheap stand-in for items here: asking for the items themselves costs
 * about a quarter of the saving. A test hook, so the tests can take either way with few items.
 */
export const viewTuning = { countFromRowsBelowShare: 0.2 };

/**
 * How many items a view holds, added up from the PURSS's counts instead of from a probe per item. Applies to the
 * views a person opens most (everything, New, To read, a large collection of sources, sources in no collection); for the rest,
 * null: counting the rows is cheap (one source, a basket) or the only way (a rule). The result is what counting the rows gives:
 * items of sources that are no longer followed are in the view only while a basket keeps them or they carry a highlight or note,
 * which is looked up for those items alone.
 */
export function viewTotal(app: App, p: Principal, view: View): number | null {
  const [kind, id] = view.scope.split(":") as [string, string | undefined];
  const scopeState = STATE_SCOPES[kind];
  let scopeSources: Set<string | null> | null = null; // null: every source
  if (kind === "collection") {
    const c = app.db.get<{ mode: string }>("SELECT mode FROM collections WHERE id = ? AND account_id = ?", id!, p.accountId);
    if (c?.mode !== "sources") return null;
    scopeSources = new Set(app.db.all<{ source_id: string }>("SELECT source_id FROM collection_sources WHERE collection_id = ?", id!).map((r) => r.source_id));
    const followed = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE account_id = ? AND followed = 1 AND kind <> 'manual'", p.accountId)!.n;
    if (scopeSources.size < followed * viewTuning.countFromRowsBelowShare) return null;
  } else if (kind === "loose") {
    scopeSources = new Set(looseSources(app, p.accountId));
  } else if (kind !== "all" && kind !== "home" && !scopeState) return null;

  const filter = stateFilter(view.filter);
  const keep: CellFilter = (w, isNew) => filter.keep(w, isNew) && (!scopeState || scopeState.keep(w, isNew));

  const counts = itemCounts(app, p.accountId);
  const followed = new Set(app.db.all<{ id: string }>("SELECT id FROM sources WHERE account_id = ? AND (followed = 1 OR kind = 'manual')", p.accountId).map((r) => r.id));
  const inScope = [...counts.bySource.keys()].filter((k) => !scopeSources || scopeSources.has(k));
  const shown = inScope.filter((k) => k === null || followed.has(k));
  const hidden = inScope.filter((k): k is string => k !== null && !followed.has(k));
  let total = counts.sum(shown, keep);
  if (hidden.length) {
    total += app.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items i JOIN item_state st ON st.item_id = i.id
       WHERE i.account_id = ? AND i.source_id IN (SELECT value FROM json_each(?)) AND ${KEPT_OR_ANNOTATED}
         AND ${scopeState ? scopeState.sql : "1"} AND ${filter.sql}`,
      p.accountId, JSON.stringify(hidden), ...filter.params)!.n;
  }
  return total;
}

/**
 * The numbers beside each collection's name: how many items opening it shows (Ignored items are left out) and how many of those are
 * New. A collection of sources adds up its sources' counts, the PURSS counted once for all of them; a collection defined by a rule has
 * no sources to add up, so its items are counted where they are, as its list would show them.
 */
export function collectionNumbers(app: App, p: Principal, collections: { id: string; mode: string; sourceIds: string[] }[]): Map<string, { isNew: number; items: number }> {
  const counts = collections.some((c) => c.mode === "sources") ? itemCounts(app, p.accountId) : null;
  const all = stateFilter("all");
  const marked = stateFilter("new");
  return new Map(collections.map((c) => {
    if (c.mode === "sources" && counts) return [c.id, { isNew: counts.sum(c.sourceIds, marked.keep), items: counts.sum(c.sourceIds, all.keep) }];
    const { where, params } = viewConditions(app, p, { scope: `collection:${c.id}`, filter: "all" });
    return [c.id, app.db.get<{ isNew: number; items: number }>(`SELECT COALESCE(SUM(st.is_new), 0) AS isNew, COUNT(*) AS items ${VIEW_FROM} WHERE ${where.join(" AND ")}`, ...params)!];
  }));
}

/** Compile a validated query tree to a parameterised WHERE fragment over items i / item_state st. */
/** `itemTextOnly`: a text rule matches the items' own text, never the person's highlights and notes (for shared pages). */
export function compileQuery(node: QueryNode, params: SqlParam[], accountId: string, opts: { itemTextOnly?: boolean } = {}): string {
  if ("all" in node) return `(${node.all.map((n) => compileQuery(n, params, accountId, opts)).join(" AND ")})`;
  if ("any" in node) return `(${node.any.map((n) => compileQuery(n, params, accountId, opts)).join(" OR ")})`;
  if ("not" in node) return `(NOT ${compileQuery(node.not, params, accountId, opts)})`;
  const list = (values: readonly string[]) => { params.push(...values); return values.map(() => "?").join(","); };
  switch (node.field) {
    case "text": return opts.itemTextOnly ? itemTextMatch(node.value, params) : textMatch(node.value, params);
    case "source": return `i.source_id IN (${list(node.value)})`;
    case "kind": return `i.kind IN (${list(node.value)})`;
    case "workflow": return `st.workflow IN (${list(node.value)})`;
    case "author": params.push(`%${node.value}%`); return "i.author LIKE ?";
    case "new": return node.value ? "st.is_new = 1" : "st.is_new = 0";
    case "opened": return node.value ? "st.opened_at IS NOT NULL" : "st.opened_at IS NULL";
    case "kept": return `${node.value ? "" : "NOT "}EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id)`;
    // Only this PURSS's own baskets and collections count, whatever ids a filter names.
    case "basket": { const ids = list(node.value); params.push(accountId); return `EXISTS (SELECT 1 FROM basket_items b JOIN baskets bk ON bk.id = b.basket_id WHERE b.item_id = i.id AND b.basket_id IN (${ids}) AND bk.account_id = ?)`; }
    case "collection": { const ids = list(node.value); params.push(accountId); return `i.source_id IN (SELECT cs.source_id FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id WHERE cs.collection_id IN (${ids}) AND c.account_id = ?)`; }
    case "capture": {
      const parts: string[] = [];
      for (const level of node.value) {
        if (level === "fulltext") parts.push(fullCopy("i.id"));
        if (level === "pending") parts.push(pendingCopy("i.id"));
        if (level === "failed") parts.push(failedCopy("i.id"));
        if (level === "feed") parts.push("EXISTS (SELECT 1 FROM item_versions v WHERE v.id = i.current_version_id AND v.content_html IS NOT NULL)");
        if (level === "metadata") parts.push("EXISTS (SELECT 1 FROM item_versions v WHERE v.id = i.current_version_id AND v.content_html IS NULL)");
      }
      return `(${parts.join(" OR ")})`;
    }
    case "date": {
      const col = node.which === "published" ? "COALESCE(i.published_at, i.discovered_at)" : node.which === "discovered" ? "i.discovered_at"
        : "(SELECT MIN(b.kept_at) FROM basket_items b WHERE b.item_id = i.id)";
      const parts: string[] = [];
      if (node.from) { params.push(node.from); parts.push(`${col} >= ?`); }
      if (node.to) { params.push(node.to + "T23:59:59.999Z"); parts.push(`${col} <= ?`); }
      return `(${parts.join(" AND ")})`;
    }
  }
}

/** Items whose own text matches. */
function itemTextMatch(text: string, params: SqlParam[]): string {
  params.push(ftsQuery(text));
  return "i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)";
}

/**
 * Items whose own text matches, or whose annotations do: the person's comments and notes and the
 * passages they highlighted. The caller's WHERE scopes it to the PURSS.
 */
export function textMatch(text: string, params: SqlParam[]): string {
  const q = ftsQuery(text);
  params.push(q, q);
  return `(i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
    OR i.id IN (SELECT a.item_id FROM annotations a WHERE a.deleted_at IS NULL AND a.seq IN (SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?)))`;
}
