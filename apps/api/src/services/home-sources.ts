import type { App } from "../app.ts";
import type { SqlParam } from "../db/database.ts";
import { getPreferences } from "./preferences.ts";

/*
 * Which sources Home speaks for. A source has a box on Home when it is in a collection shown on Home, or in none while
 * "Other sources" is shown there; items kept by hand and kept items of sources no longer followed are always on Home's
 * side. Home's one feed, the sections above Home's boxes (To read, Recently kept) and filter collections all draw from
 * this set, so hiding a collection from Home hides it everywhere on Home.
 */

/** A condition over a source row `s`: the source has a box on Home. Appends its one parameter. */
export function inHomeBox(app: App, workspaceId: string, params: SqlParam[]): string {
  params.push(getPreferences(app, workspaceId).homeOther ? 1 : 0);
  return `(s.followed = 0 OR s.kind = 'manual'
    OR EXISTS (SELECT 1 FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id WHERE cs.source_id = s.id AND c.mode = 'sources' AND c.show_on_home = 1)
    OR (? = 1 AND NOT EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.source_id = s.id)))`;
}

/**
 * A condition over `items i` joined to `LEFT JOIN sources s`: Home may show the item. An item with no source can be shown;
 * one from a source without a box on Home cannot.
 */
export function onHomeItem(app: App, workspaceId: string, params: SqlParam[]): string {
  return `(i.source_id IS NULL OR ${inHomeBox(app, workspaceId, params)})`;
}
