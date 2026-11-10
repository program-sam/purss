import type { ItemDTO, WorkflowState } from "@purss/domain";

/**
 * The changes that go through the outbox: each one is shown at once, kept on this device until the
 * PURSS confirms it, and sent in order. Keep and un-keep are idempotent (PUT and DELETE), clearing
 * New markers names its items, and a workflow change carries the workflow it started from so it can
 * be checked against what PURSS holds when it is finally sent.
 */
export type Change =
  | { kind: "workflow"; itemId: string; from: WorkflowState; to: WorkflowState; revision: number }
  | { kind: "keep"; itemId: string; basketId: string; on: boolean }
  /** An Undo that could not be settled when it was pressed (the item could not be read): when it is sent, the item is read, and only if it still has `applied` is it put back to `restore`. */
  | { kind: "undoWorkflow"; itemId: string; applied: WorkflowState; restore: WorkflowState }
  | { kind: "clearFresh"; itemIds: string[] };

export type Entry = Change & {
  id: string;
  /** Entries belong to one installation (the page's origin) and one account on it; no other account, and no other
   *  installation served from this browser, ever sees or sends them. */
  installation: string;
  accountId: string;
  /** Order of making: entries are sent in this order, and an item's entries never overtake each other. */
  seq: number;
  createdAt: string;
  /** Failed attempts so far (not counting waits for the connection). */
  attempts: number;
  /** A send was started (kept on disk before the request leaves): from then on it may have reached PURSS, answer or no answer. */
  tried?: boolean;
  /** Do not try again before this time (epoch ms). */
  notBefore: number;
};

/** The key an entry is filed under: installation and account. */
export function scopeOf(installation: string, accountId: string): string {
  return `${installation}\u0000${accountId}`;
}

/**
 * A workflow change is sent with the revision it was made against. When PURSS refuses it as a conflict
 * (the item has moved on since), the item is read once:
 * - its workflow already equals the target: the earlier send committed and only its answer was lost (or the same
 *   change was made elsewhere), so the change counts as done, silently;
 * - anything else: the item changed elsewhere, so the change is dropped and the person is told.
 * The workflow it started from is deliberately not compared: A to B to A elsewhere looks unchanged but is not.
 */
export function judgeConflict(change: { to: WorkflowState }, server: { workflow: WorkflowState }): "done" | "drop" {
  return server.workflow === change.to ? "done" : "drop";
}

/** Show a pending change on an item the way it will look once sent. Entries are applied in order. */
export function overlayItem<T extends ItemDTO>(item: T, entries: readonly Entry[]): T {
  let out = item;
  for (const e of entries) {
    if (e.kind === "workflow" && e.itemId === item.id) out = out.workflow === e.to ? out : { ...out, workflow: e.to };
    else if (e.kind === "undoWorkflow" && e.itemId === item.id) out = out.workflow === e.applied ? { ...out, workflow: e.restore } : out;
    else if (e.kind === "keep" && e.itemId === item.id) {
      const has = out.basketIds.includes(e.basketId);
      if (e.on && !has) out = { ...out, basketIds: [...out.basketIds, e.basketId] };
      else if (!e.on && has) out = { ...out, basketIds: out.basketIds.filter((b) => b !== e.basketId) };
    } else if (e.kind === "clearFresh" && e.itemIds.includes(item.id) && out.fresh) out = { ...out, fresh: false };
  }
  return out;
}

/** Ids of the items a list of entries is about. */
export function itemIdsOf(entries: readonly Entry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind === "clearFresh") e.itemIds.forEach((id) => ids.add(id));
    else ids.add(e.itemId);
  }
  return ids;
}

/** Items that a pending "remove from basket" has already taken out of that basket's page. */
export function removedFromBasket(entries: readonly Entry[], basketId: string): Set<string> {
  const gone = new Set<string>();
  for (const e of entries) if (e.kind === "keep" && e.basketId === basketId) { if (e.on) gone.delete(e.itemId); else gone.add(e.itemId); }
  return gone;
}

export type Failure = { status: number; code: string; message: string };

export function asFailure(err: unknown): Failure {
  const e = err as Partial<Failure> | null;
  if (e && typeof e === "object" && typeof e.status === "number" && typeof e.code === "string") return { status: e.status, code: e.code, message: typeof e.message === "string" ? e.message : "" };
  return { status: 0, code: "offline", message: "" };
}

/**
 * What a failed send means.
 * - `connection`: no answer (offline, timeout); the whole pass stops and waits for the connection.
 * - `signed-out`: the session ended; nothing is sent until someone signs in, and nothing is dropped.
 * - `later`: PURSS had a problem or asked to slow down; this entry waits, others carry on.
 * - `conflict`: the item changed elsewhere (a 409 on a workflow change); checked against the item.
 * - `rejected`: PURSS refused this change for good (gone, not allowed, storage full).
 */
export type FailureKind = "connection" | "signed-out" | "later" | "conflict" | "rejected";

export function classify(f: Failure): FailureKind {
  if (f.status === 0 || f.code === "offline") return "connection";
  if (f.code === "signed_out" || f.status === 401) return "signed-out";
  if (f.status === 409 && f.code === "conflict") return "conflict";
  // 507 is PURSS saying its storage is full: waiting does not change that, so it is a refusal, not a fault.
  if (f.status === 429 || f.status === 408 || (f.status >= 500 && f.status !== 507)) return "later";
  return "rejected";
}

/** Seconds to wait after the n-th failed attempt: 2, 5, 15, 60, then every 5 minutes. */
export function backoffSeconds(attempts: number): number {
  return [2, 5, 15, 60][Math.max(0, attempts - 1)] ?? 300;
}

/** The person-facing reason a change was not applied. */
export function notChangedMessage(reason: "conflict" | "rejected", serverMessage: string): string {
  if (reason === "conflict") return "Not changed: this item was changed on another device.";
  const detail = serverMessage.trim();
  return detail ? `Not changed. ${detail}` : "Not changed. PURSS couldn't apply it.";
}
