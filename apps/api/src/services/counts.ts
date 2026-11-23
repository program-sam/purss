import type { WorkflowState } from "@purss/domain";
import type { App } from "../app.ts";

/**
 * How many items a PURSS has, by source, workflow state and New marker.
 *
 * The source list, the collection list and the totals of item lists all need these numbers, and computing each from the
 * item rows costs a probe per item. Here the cost follows what is rare: most items are in the default cell (workflow
 * "undecided", not New), so that cell is the source's item count (read from an index alone) minus the other nine cells, and the
 * other nine are found through a partial index on `item_state` that holds only those rows: a few New items, the items a person
 * has moved to To read, In progress, Finished or Ignored, and the back catalogue of sources followed from now, which arrives Ignored
 * (in a PURSS that has just followed many sources that is most of the items). `item_state.source_id` is there for that: the counts never
 * join to `items` for the source of a state row.
 */

const STATES: readonly WorkflowState[] = ["undecided", "toread", "inprogress", "finished", "ignored"];
const cellOf = (workflow: string, isNew: number): number => STATES.indexOf(workflow as WorkflowState) * 2 + isNew;

export type CellFilter = (workflow: WorkflowState, isNew: boolean) => boolean;

export class ItemCounts {
  /** Per source id (null: items without a source), ten counts: `cellOf(workflow, isNew)`. Every item the source holds. */
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

  /** Everything the source holds, Ignored items included. */
  items(source: string): number {
    return this.sum([source], () => true);
  }

  /** Items with the New marker, whatever their workflow state. */
  isNew(source: string): number {
    return this.sum([source], (_w, isNew) => isNew);
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
export function itemCounts(app: App, accountId: string): ItemCounts {
  const stamp = dbStamp(app);
  let byAccount = remembered.get(app);
  if (!byAccount) remembered.set(app, (byAccount = new Map()));
  const hit = byAccount.get(accountId);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = computeCounts(app, accountId);
  if (!app.db.raw.isTransaction) byAccount.set(accountId, { stamp, value });
  return value;
}

function computeCounts(app: App, accountId: string): ItemCounts {
  const bySource = new Map<string | null, number[]>();
  const cells = (source: string | null) => {
    let c = bySource.get(source);
    if (!c) bySource.set(source, (c = new Array<number>(STATES.length * 2).fill(0)));
    return c;
  };
  // Each source's items, from an index alone.
  for (const r of app.db.all<{ source_id: string | null; n: number }>("SELECT source_id, COUNT(*) AS n FROM items WHERE account_id = ? GROUP BY source_id", accountId)) {
    cells(r.source_id)[cellOf("undecided", 0)] = r.n;
  }
  // The other cells: the items a person has acted on, the New ones and the Ignored ones (the back catalogue of a source followed from now
  // arrives so). The partial index holds exactly those rows and each one's source, so they are counted from it alone, however many there are.
  for (const r of app.db.all<{ source_id: string | null; workflow: string; is_new: number; n: number }>(
    // The condition is the partial index's own, which lets the planner use it.
    `SELECT source_id, workflow, is_new, COUNT(*) AS n FROM item_state
     WHERE account_id = ? AND NOT (workflow = 'undecided' AND is_new = 0) GROUP BY source_id, workflow, is_new`, accountId)) {
    const c = cells(r.source_id);
    c[cellOf(r.workflow, r.is_new)] = r.n;
    c[cellOf("undecided", 0)]! -= r.n;
  }
  return new ItemCounts(bySource);
}
