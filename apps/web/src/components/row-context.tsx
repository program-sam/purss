import { createContext, useContext, useSyncExternalStore } from "react";
import type { BasketDTO, ItemDTO, WorkflowState } from "@purss/domain";

/**
 * Which item is open and which are selected. Rows subscribe to their own marks, so opening an item or ticking one
 * re-renders the rows whose marks changed instead of every row on the page.
 */
export type RowMarks = {
  active: () => string | undefined;
  selected: () => ReadonlySet<string>;
  subscribe: (fn: () => void) => () => void;
};

/**
 * What the rows, cards and board cards of the current page need to know and do. The value only changes when
 * select mode, the basket, the time zone or the minute changes; the actions keep their identity.
 */
export type RowCtx = {
  marks: RowMarks;
  selecting: boolean;
  /** Set on a basket page: rows offer Remove instead of Keep. */
  basket: BasketDTO | null;
  timeZone: string;
  now: number;
  onOpen: (item: ItemDTO) => void;
  onMore: (item: ItemDTO, anchor: HTMLElement) => void;
  /** Board cards open a menu that starts with "Move to". */
  onBoardMore: (item: ItemDTO, anchor: HTMLElement) => void;
  onKeep: (item: ItemDTO, anchor: HTMLElement) => void;
  onWorkflow: (item: ItemDTO, workflow: WorkflowState) => void;
  /** Download the item's audio or video to this device (the apps). */
  onDownload: (item: ItemDTO) => Promise<void>;
  onRestore: (item: ItemDTO) => void;
  /** The changes that take this item out of the list shown, for its row's `data-leaves` (see lib/leave.ts). */
  leaves: (item: ItemDTO) => string;
  onRemove: (item: ItemDTO) => void;
};

export const RowContext = createContext<RowCtx | null>(null);

export function useRowCtx(): RowCtx {
  const v = useContext(RowContext);
  if (!v) throw new Error("RowContext is missing");
  return v;
}

/** Whether this item is the open one and whether it is selected. */
export function useRowMarks(id: string): { active: boolean; picked: boolean } {
  const { marks } = useRowCtx();
  const bits = useSyncExternalStore(marks.subscribe, () => (marks.active() === id ? 1 : 0) | (marks.selected().has(id) ? 2 : 0));
  return { active: (bits & 1) !== 0, picked: (bits & 2) !== 0 };
}
