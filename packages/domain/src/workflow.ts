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

/** The board's columns; Ignored is an outcome shown separately. */
export const BOARD_COLUMNS: readonly WorkflowState[] = ["undecided", "toread", "inprogress", "finished"];

export function isWorkflowState(v: unknown): v is WorkflowState {
  return typeof v === "string" && (WORKFLOW_STATES as readonly string[]).includes(v);
}

/** Every transition is allowed and reversible; Finished is not deletion, Ignored does not unfollow. */
export function canTransition(_from: WorkflowState, _to: WorkflowState): boolean {
  return true;
}
