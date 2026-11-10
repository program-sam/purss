import type { WorkflowState } from "@purss/domain";
import type { App } from "../app.ts";

/**
 * How many items a PURSS has, by source, workflow state and New marker.
 *
 * The source list, the collection list and the totals of item lists all need these numbers, and computing each from the
 * item rows costs a probe per item. Here the cost follows what is rare: almost every item is in the default cell (workflow
 * "new", not New), so that cell is the source's item count (read from an index alone) minus the other nine cells, and the
 * other nine are found through a partial index on `item_state` that holds only those rows: a few New items, and the items a person
 * has moved to To read, In progress, Finished or Ignored.
 */

const STATES: readonly WorkflowState[] = ["new", "toread", "inprogress", "finished", "ignored"];
const cellOf = (workflow: string, fresh: number): number => STATES.indexOf(workflow as WorkflowState) * 2 + fresh;

export type CellFilter = (workflow: WorkflowState, fresh: boolean) => boolean;

export class ItemCounts {
  /** Per source id (null: items without a source), ten counts: `cellOf(workflow, fresh)`. */
  readonly bySource: Map<string | null, number[]>;

  constructor(bySource: Map<string | null, number[]>) {
    this.bySource = bySource;
  }

  /** The items of these sources whose state passes the filter. */
  sum(sources: Iterable<string | null>, keep: CellFilter): number {
    let n = 0;
    for (const s of sources) {
      const cells = this.bySource.get(s);
      if (!cells) continue;
      for (let c = 0; c < cells.length; c++) if (cells[c] && keep(STATES[c >> 1]!, (c & 1) === 1)) n += cells[c]!;
    }
    return n;
  }

  /** Everything the source holds. */
  items(source: string): number {
    return this.sum([source], () => true);
  }

  /** Items with the New marker, whatever their workflow state. */
  fresh(source: string): number {
    return this.sum([source], (_w, fresh) => fresh);
  }
}

type Stamped<T> = { stamp: string; value: T };
const remembered = new WeakMap<App, Map<string, Stamped<ItemCounts>>>();

/**
 * Identifies the content of the database as this connection sees it: every row changed through this connection and every
 * commit by another one move it. Equal stamps mean nothing was written in between.
 */
export function dbStamp(app: App): string {
  const changes = app.db.get<{ c: number }>("SELECT total_changes() AS c")!.c;
  const version = app.db.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
  return `${changes}:${version}`;
}

/**
 * The PURSS's counts. A second call before anything is written (the source list and the collection list in one
 * bootstrap) reuses the first. Nothing is kept from inside a transaction: its rows may still be rolled back, and a
 * rollback does not move the stamp.
 */
export function itemCounts(app: App, workspaceId: string): ItemCounts {
  const stamp = dbStamp(app);
  let byWorkspace = remembered.get(app);
  if (!byWorkspace) remembered.set(app, (byWorkspace = new Map()));
  const hit = byWorkspace.get(workspaceId);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = computeCounts(app, workspaceId);
  if (!app.db.raw.isTransaction) byWorkspace.set(workspaceId, { stamp, value });
  return value;
}

function computeCounts(app: App, workspaceId: string): ItemCounts {
  const bySource = new Map<string | null, number[]>();
  const cells = (source: string | null) => {
    let c = bySource.get(source);
    if (!c) bySource.set(source, (c = new Array<number>(STATES.length * 2).fill(0)));
    return c;
  };
  // Each source's items, from an index alone.
  for (const r of app.db.all<{ source_id: string | null; n: number }>("SELECT source_id, COUNT(*) AS n FROM items WHERE workspace_id = ? GROUP BY source_id", workspaceId)) {
    cells(r.source_id)[cellOf("new", 0)] = r.n;
  }
  // The other cells: items a person has acted on, and the New ones, joined to their source.
  const rare = (where: string, ...params: string[]) => {
    for (const r of app.db.all<{ source_id: string | null; workflow: string; fresh: number; n: number }>(
      // The first condition is the partial index's own, which lets the planner use it.
      `SELECT i.source_id AS source_id, st.workflow AS workflow, st.fresh AS fresh, COUNT(*) AS n
       FROM item_state st JOIN items i ON i.id = st.item_id
       WHERE st.workspace_id = ? AND NOT (st.workflow = 'new' AND st.fresh = 0) AND ${where} GROUP BY i.source_id, st.workflow, st.fresh`, workspaceId, ...params)) {
      const c = cells(r.source_id);
      c[cellOf(r.workflow, r.fresh)] = r.n;
      c[cellOf("new", 0)]! -= r.n;
    }
  };
  for (const w of STATES) if (w !== "new") rare("st.workflow = ?", w);
  rare("st.workflow = 'new' AND st.fresh = 1");
  return new ItemCounts(bySource);
}
