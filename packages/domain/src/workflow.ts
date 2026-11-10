export const WORKFLOW_STATES = ["new", "toread", "inprogress", "finished", "ignored"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** The stored workflow value `new` is shown as Undecided; the `fresh` item flag is shown as New. */
export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  new: "Undecided",
  toread: "To read",
  inprogress: "In progress",
  finished: "Finished",
  ignored: "Ignored",
};

/** The board's columns; Ignored is an outcome shown separately. */
export const BOARD_COLUMNS: readonly WorkflowState[] = ["new", "toread", "inprogress", "finished"];

export function isWorkflowState(v: unknown): v is WorkflowState {
  return typeof v === "string" && (WORKFLOW_STATES as readonly string[]).includes(v);
}

/** Every transition is allowed and reversible; Finished is not deletion, Ignored does not unfollow. */
export function canTransition(_from: WorkflowState, _to: WorkflowState): boolean {
  return true;
}
