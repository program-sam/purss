import type { ItemDTO, WorkflowState } from "@purss/domain";
import type { Change } from "./entries.ts";
import type { Outcome } from "./outbox.ts";

type WorkflowChange = Extract<Change, { kind: "workflow" }>;
type KeepChange = Extract<Change, { kind: "keep" }>;

/**
 * One workflow change per item, each made against that item's own workflow and revision. Items that already have the
 * workflow need no change.
 */
export function workflowChanges(items: readonly ItemDTO[], to: WorkflowState): WorkflowChange[] {
  return items.filter((it) => it.workflow !== to).map((it) => ({ kind: "workflow", itemId: it.id, from: it.workflow, to, revision: it.revision }));
}

/** One keep per item and basket, leaving out the pairs the item is already kept in (items not loaded are kept anyway; keeping is repeatable). */
export function keepChanges(items: readonly ItemDTO[], ids: readonly string[], basketIds: readonly string[]): KeepChange[] {
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const out: KeepChange[] = [];
  for (const basketId of basketIds) for (const itemId of ids) if (!byId.get(itemId)?.basketIds.includes(basketId)) out.push({ kind: "keep", itemId, basketId, on: true });
  return out;
}

const itemsOf = (c: Change): string[] => (c.kind === "clearFresh" ? c.itemIds : [c.itemId]);

/** How a group of changes ended: what to tell the person, and what Undo has to reach. */
export type BatchSummary = {
  /** Items whose change went through or is waiting to be sent. */
  items: number;
  /** PURSS's Undo tokens for the changes that went through. */
  tokens: string[];
  /** Changes kept for later, with the entry that holds each. */
  waiting: { entryId: string; change: Change }[];
  /** Changes PURSS did not apply. */
  dropped: { reason: "conflict" | "rejected"; message: string; change: Change }[];
};

export function summariseBatch(changes: readonly Change[], outcomes: readonly Outcome[]): BatchSummary {
  const done = new Set<string>();
  const tokens: string[] = [];
  const waiting: BatchSummary["waiting"] = [];
  const dropped: BatchSummary["dropped"] = [];
  outcomes.forEach((o, i) => {
    const change = changes[i]!;
    if (o.status === "dropped") { dropped.push({ reason: o.reason, message: o.message, change }); return; }
    itemsOf(change).forEach((id) => done.add(id));
    if (o.status === "deferred") waiting.push({ entryId: o.entry.id, change });
    else if ("undoToken" in o.result && o.result.undoToken) tokens.push(o.result.undoToken);
  });
  return { items: done.size, tokens, waiting, dropped };
}
