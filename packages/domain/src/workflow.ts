import { common } from "@purss/translations/common";

export const WORKFLOW_STATES = ["undecided", "toread", "inprogress", "finished", "ignored"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  undecided: common.workflow.undecided,
  toread: common.workflow.toRead,
  inprogress: common.workflow.inProgress,
  finished: common.workflow.finished,
  ignored: common.workflow.ignored,
};

/**
 * The queue: what the person put aside (To read) and what they started (In progress). Home's To read, To watch and To listen
 * rows, the reading list and the offline pack are made of it.
 */
export const QUEUE_STATES = ["toread", "inprogress"] as const satisfies readonly WorkflowState[];

export function isQueued(workflow: WorkflowState): boolean {
  return (QUEUE_STATES as readonly string[]).includes(workflow);
}

/**
 * The state filters of a list: everything but Ignored, everything, the items with the New marker, or one workflow state.
 * The server answers them in SQL (services/item-view.ts); a device that has just changed an item decides with
 * `stateFilterKeeps` whether it still belongs in the list it is shown in, before the server has answered.
 */
export const STATE_FILTERS = ["all", "all_with_ignored", "new", ...WORKFLOW_STATES] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

/**
 * Whether an item in this workflow state, with or without the New marker, is in a list with this state filter. An Ignored item is
 * never New: the server takes the marker off when an item is Ignored, and a device that has just ignored one has not heard that yet.
 */
export function stateFilterKeeps(filter: StateFilter, workflow: WorkflowState, isNew: boolean): boolean {
  switch (filter) {
    case "all": return workflow !== "ignored";
    case "all_with_ignored": return true;
    case "new": return isNew && workflow !== "ignored";
    default: return workflow === filter;
  }
}

/** The board's columns; Ignored is an outcome shown separately. */
export const BOARD_COLUMNS: readonly WorkflowState[] = ["undecided", "toread", "inprogress", "finished"];

export function isWorkflowState(v: unknown): v is WorkflowState {
  return typeof v === "string" && (WORKFLOW_STATES as readonly string[]).includes(v);
}

/** Every transition is allowed and reversible; Finished is not deletion, Ignored does not unfollow. */
export function canTransition(_from: WorkflowState, _to: WorkflowState): boolean {
  return true;
}
