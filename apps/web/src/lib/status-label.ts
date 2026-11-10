import type { ItemKind, WorkflowState } from "@purss/domain";
import { workflowLabel } from "./constants.ts";

/**
 * What the status button on an item says. While nothing is set (the stored value `new`, which filters, the board and the
 * menu still call Undecided) it is an invitation, "Set status"; otherwise the state, with "State" in front of it.
 */
export function statusButton(workflow: WorkflowState, kind?: ItemKind): { text: string; aria: string; keyed: boolean } {
  if (workflow === "new") return { text: "Set status", aria: "Set status", keyed: false };
  const label = workflowLabel(workflow, kind);
  return { text: label, aria: `State: ${label}. Change state`, keyed: true };
}
