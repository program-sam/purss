import type { ItemDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { VISIBLE_SOURCE, getItem, listItems, snippetAround } from "./items.ts";
import { indexedWord, searchTerms } from "./search-text.ts";

/** A search word that is a version or a date ("26.12.1", "v2.0-rc1", "2026-11-05"): its numbers belong together. */
const VERSION_LIKE = /\d+(?:[.\-]\d+)+/;

/**
 * The query as the full-text index should hold it when the search asks for exactly what was typed: a version-like
 * word becomes a phrase of its parts ("26.12.1" is the words 26, 12 and 1 in a row, which "26.12.10" is not) and any
 * other word stays a word start. Null when the query has no version-like word, so an ordinary search is left as it is.
 */
export function exactQuery(text: string): string | null {
  const terms = searchTerms(text);
  if (!terms.some((t) => VERSION_LIKE.test(t))) return null;
  return terms.map((t) => {
    if (!VERSION_LIKE.test(t)) return `"${t}"*`;
    const parts = (t.match(/[\p{L}\p{N}]+/gu) ?? [t]).join(" ");
    // Releases are often written with a v in front ("v26.12.1"), which the index holds as part of the first number.
    return /^\d/.test(parts) ? `("${parts}" OR "v${parts}")` : `"${parts}"`;
  }).join(" AND ");
}

/**
 * Items for the search box. The items whose text holds a version exactly come first ("26.12.1" finds release 26.12.1
 * before 26.12.10 and 26.12.11, which also begin with those numbers), newest first within each group; the rest follow.
 */
export function searchItems(app: App, p: Principal, query: string, limit = 8): ItemDTO[] {
  const found = listItems(app, p, { scope: "all", filter: "all", q: query, limit }).items;
  const exact = exactQuery(query);
  if (!exact) return found;
  const ids = app.db.all<{ id: string }>(
    `SELECT i.id FROM items i LEFT JOIN sources s ON s.id = i.source_id
      WHERE i.workspace_id = ? AND ${VISIBLE_SOURCE} AND i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
      ORDER BY COALESCE(i.published_at, i.discovered_at) DESC, i.id DESC LIMIT ?`, p.workspaceId, exact, limit).map((r) => r.id);
  const first = ids.map((id) => getItem(app, p, id));
  const seen = new Set(ids);
  return [...first, ...found.filter((i) => !seen.has(i.id))].slice(0, limit);
}

/**
 * For items the search found only through a note (or a comment on a highlight), a few words of that note around the match,
 * the match marked as in `searchSnippets`. Items whose own text matched are left to that snippet.
 */
export function noteSnippets(app: App, p: Principal, itemIds: string[], query: string): Record<string, string> {
  const terms = searchTerms(query).map((t) => indexedWord(t));
  if (!itemIds.length || !terms.length) return {};
  const rows = app.db.all<{ item_id: string; body: string }>(
    `SELECT item_id, body FROM annotations WHERE workspace_id = ? AND deleted_at IS NULL AND body IS NOT NULL AND item_id IN (${itemIds.map(() => "?").join(",")})
      ORDER BY created_at, id`, p.workspaceId, ...itemIds);
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (out[r.item_id]) continue;
    const snippet = snippetAround(r.body, terms);
    if (snippet !== null) out[r.item_id] = snippet;
  }
  return out;
}
