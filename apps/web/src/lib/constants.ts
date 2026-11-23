import { app } from "@purss/translations/app";
import type { ItemKind, Sort, ViewMode, WorkflowState } from "@purss/domain";

/*
 * Browser-safe copies of the product's small enumerations. The domain package's runtime entry
 * pulls in server-only modules, so only its types are imported here; the annotations below make
 * the compiler fail if the contract's unions change.
 */

export const WORKFLOW_ORDER: readonly WorkflowState[] = ["undecided", "toread", "inprogress", "finished", "ignored"];
/** The stored workflow value `new` is shown as Undecided, and items with the `fresh` flag are shown as New. */
export const WORKFLOW_LABELS: Record<WorkflowState, string> = app.lib.constants.workflow;
/** What an item's "to do" state is called: videos are watched and podcasts listened to, everything else is read. */
export function workflowLabel(workflow: WorkflowState, kind?: ItemKind): string {
  if (workflow === "toread") return kind === "video" ? app.words.toWatch : kind === "podcast" ? app.words.toListen : app.lib.constants.workflow.toread;
  return WORKFLOW_LABELS[workflow];
}

/** The board's columns; Ignored is an outcome shown separately. */
export const BOARD_COLUMNS: readonly WorkflowState[] = ["undecided", "toread", "inprogress", "finished"];
/** The four states in the panel's segmented control. Ignore is a separate action. */
export const ACTIVE_STATES: readonly WorkflowState[] = BOARD_COLUMNS;

export const VIEW_MODES: readonly ViewMode[] = ["list", "cards", "board", "table", "timeline"];
export const VIEW_LABELS: Record<ViewMode, string> = app.lib.constants.views;

export const ITEM_KINDS: readonly ItemKind[] = ["article", "video", "paper", "post", "podcast", "link"];
export const KIND_LABELS: Record<ItemKind, string> = app.lib.constants.kinds;

export const SORT_LABELS: Record<Sort, string> = app.lib.constants.sorts;
export const SORT_ORDER: readonly Sort[] = ["newest", "oldest", "source", "title", "kept"];

/** Filters shown in the header menu. "active" (All) is everything except Ignored; "all" includes Ignored. */
export type ListFilter = "active" | "all" | "fresh" | WorkflowState;
export const LIST_FILTERS: readonly ListFilter[] = ["active", "all", "fresh", "undecided", "toread", "inprogress", "finished", "ignored"];
export const FILTER_LABELS: Record<ListFilter, string> = app.lib.constants.filters;

/** The reading list's page: To read items, and the videos to watch and podcasts to listen to that share its state. */
export const TO_READ_TITLE = app.lib.constants.toReadTitle;
