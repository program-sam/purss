import type { ItemKind, Sort, ViewMode, WorkflowState } from "@purss/domain";

/*
 * Browser-safe copies of the product's small enumerations. The domain package's runtime entry
 * pulls in server-only modules, so only its types are imported here; the annotations below make
 * the compiler fail if the contract's unions change.
 */

export const WORKFLOW_ORDER: readonly WorkflowState[] = ["new", "toread", "inprogress", "finished", "ignored"];
/** The stored workflow value `new` is shown as Undecided, and items with the `fresh` flag are shown as New. */
export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  new: "Undecided", toread: "To read", inprogress: "In progress", finished: "Finished", ignored: "Ignored",
};
/** What an item's "to do" state is called: videos are watched and podcasts listened to, everything else is read. */
export function workflowLabel(workflow: WorkflowState, kind?: ItemKind): string {
  if (workflow === "toread") return kind === "video" ? "To watch" : kind === "podcast" ? "To listen" : "To read";
  return WORKFLOW_LABELS[workflow];
}

/** The board's columns; Ignored is an outcome shown separately. */
export const BOARD_COLUMNS: readonly WorkflowState[] = ["new", "toread", "inprogress", "finished"];
/** The four states in the panel's segmented control. Ignore is a separate action. */
export const ACTIVE_STATES: readonly WorkflowState[] = BOARD_COLUMNS;

export const VIEW_MODES: readonly ViewMode[] = ["list", "cards", "board", "table", "timeline"];
export const VIEW_LABELS: Record<ViewMode, string> = { list: "List", cards: "Cards", board: "Board", table: "Table", timeline: "Timeline" };

export const ITEM_KINDS: readonly ItemKind[] = ["article", "video", "paper", "post", "podcast", "link"];
export const KIND_LABELS: Record<ItemKind, string> = { article: "Article", video: "Video", paper: "Paper", post: "Post", podcast: "Podcast", link: "Link" };

export const SORT_LABELS: Record<Sort, string> = { newest: "Newest", oldest: "Oldest", source: "Source", title: "Title", kept: "Recently kept" };
export const SORT_ORDER: readonly Sort[] = ["newest", "oldest", "source", "title", "kept"];

/** Filters shown in the header menu. "active" (All) is everything except Ignored; "all" includes Ignored. */
export type ListFilter = "active" | "all" | "fresh" | WorkflowState;
export const LIST_FILTERS: readonly ListFilter[] = ["active", "all", "fresh", "new", "toread", "inprogress", "finished", "ignored"];
export const FILTER_LABELS: Record<ListFilter, string> = {
  active: "All", all: "All + ignored", fresh: "New", new: "Undecided", toread: "To read", inprogress: "In progress", finished: "Finished", ignored: "Ignored",
};

/** The reading list's page: To read items, and the videos to watch and podcasts to listen to that share its state. */
export const TO_READ_TITLE = "To read, watch and listen";
