import type { App } from "../app.ts";
import { indexAnnotation } from "./annotations.ts";
import { reindex } from "./items.ts";

/*
 * Keeping the search index in step with how search folds text (search-text.ts). The index is derived
 * from the items; when the fold changes, SEARCH_INDEX_VERSION goes up, and the next start rebuilds the
 * index (the items' and the person's notes') in small steps in the background. Until a step has reached an item or a note,
 * it is still in the index under its old entry: found by what it was indexed as, but not yet by the folded forms.
 */

/** Raise whenever search-text.ts changes what it folds. */
export const SEARCH_INDEX_VERSION = 3;
const STEP = 50;

type State = { version: number; cursor: number; target: number; annotation_cursor: number };

function state(app: App): State {
  return app.db.get<State>("SELECT version, cursor, target, annotation_cursor FROM search_index_state WHERE id = 1") ?? { version: 0, cursor: 0, target: 0, annotation_cursor: 0 };
}

export function searchIndexIsCurrent(app: App): boolean {
  return state(app).version >= SEARCH_INDEX_VERSION;
}

/**
 * Index the next few items again, then the person's notes; true when the whole index is current. Safe to call at any time, from any
 * process. The progress belongs to the version being rebuilt for (`target`): progress left by an earlier version's rebuild, which
 * an upgrade can interrupt, says nothing about this one, so a rebuild for a different target starts from the beginning.
 */
export function stepSearchIndex(app: App, size = STEP): boolean {
  const s = state(app);
  if (s.version >= SEARCH_INDEX_VERSION) return true;
  return app.db.tx(() => {
    const own = s.target === SEARCH_INDEX_VERSION;
    const itemCursor = own ? s.cursor : 0;
    const noteCursor = own ? s.annotation_cursor : 0;
    const items = app.db.all<{ id: string; seq: number }>("SELECT id, seq FROM items WHERE seq > ? ORDER BY seq LIMIT ?", itemCursor, size);
    for (const it of items) reindex(app, it.id);
    const lastItem = items.length ? items[items.length - 1]!.seq : itemCursor;
    if (items.length === size) {
      app.db.run("UPDATE search_index_state SET target = ?, cursor = ?, annotation_cursor = ? WHERE id = 1", SEARCH_INDEX_VERSION, lastItem, noteCursor);
      return false;
    }
    // The items are done; the notes have an index of their own.
    const notes = app.db.all<{ seq: number; quote_exact: string | null; body: string | null }>(
      "SELECT seq, quote_exact, body FROM annotations WHERE deleted_at IS NULL AND seq > ? ORDER BY seq LIMIT ?", noteCursor, size);
    for (const n of notes) indexAnnotation(app, n.seq, n.quote_exact, n.body);
    if (notes.length === size) {
      app.db.run("UPDATE search_index_state SET target = ?, cursor = ?, annotation_cursor = ? WHERE id = 1", SEARCH_INDEX_VERSION, lastItem, notes[notes.length - 1]!.seq);
      return false;
    }
    app.db.run("UPDATE search_index_state SET version = ?, target = ?, cursor = 0, annotation_cursor = 0 WHERE id = 1", SEARCH_INDEX_VERSION, SEARCH_INDEX_VERSION);
    return true;
  });
}

/** The whole rebuild in one go (for tools and tests); returns how many steps it took. */
export function rebuildSearchIndex(app: App, size = STEP): number {
  let steps = 0;
  do steps++; while (!stepSearchIndex(app, size));
  return steps;
}

/**
 * Rebuild in the background when the index is behind: a step per turn of the event loop, so the server
 * keeps answering. Stops quietly when the database is closed. Resolves when the index is current.
 */
export function startSearchIndexRebuild(app: App, size = STEP): Promise<void> {
  return new Promise((resolve) => {
    const next = () => {
      try {
        if (stepSearchIndex(app, size)) return resolve();
      } catch (err) {
        if (!/not open/i.test(String((err as Error)?.message))) console.error("[api] search index rebuild stopped:", err);
        return resolve();
      }
      setImmediate(next);
    };
    next();
  });
}
