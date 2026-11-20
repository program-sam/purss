import { app } from "@purss/copy/app";
import type { ItemKind, WorkflowState } from "@purss/domain";
import { workflowLabel } from "./constants.ts";

/** The reading path the status button steps along, one click per step. */
const NEXT: Partial<Record<WorkflowState, WorkflowState>> = { new: "toread", toread: "inprogress", inprogress: "finished" };

/**
 * What the status button on an item says. While the item is on the reading path (Undecided, To read, In progress) the
 * button moves it one step on, "Mark …", and a chevron beside it opens every state. At the end (Finished, Ignored) it
 * names the state, with "State" in front of it, and opens the menu.
 */
export function statusButton(workflow: WorkflowState, kind?: ItemKind): { text: string; aria: string; keyed: boolean; next?: WorkflowState; menuAria: string } {
  const current = workflowLabel(workflow, kind);
  const menuAria = app.lib.statusLabel.menu(current);
  const next = NEXT[workflow];
  if (next) return { text: app.lib.statusLabel.mark(workflowLabel(next, kind)), aria: app.lib.statusLabel.mark(workflowLabel(next, kind)), keyed: false, next, menuAria };
  return { text: current, aria: menuAria, keyed: true, menuAria };
}
