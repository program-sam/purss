import type { BulkResult, ItemDTO } from "@purss/domain";
import { api } from "../api/client.ts";
import type { KeepResult, StateChangeResult } from "../api/types.ts";
import { Outbox } from "./outbox.ts";
import type { Sender } from "./outbox.ts";
import { serial } from "./serial.ts";
import { openStore } from "./store.ts";

const enc = encodeURIComponent;
/** A request that gets no answer for this long counts as a lost connection and is sent again later. */
const TIMEOUT_MS = 20_000;
const signal = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

const sender: Sender = {
  workflow: (itemId, workflow, expectedRevision) =>
    api<StateChangeResult>(`/api/items/${enc(itemId)}/state`, { method: "PATCH", body: { workflow, expectedRevision }, signal: signal() }),
  keep: (itemId, basketId, on) => {
    const path = `/api/items/${enc(itemId)}/baskets/${enc(basketId)}`;
    return api<KeepResult>(path, { method: on ? "PUT" : "DELETE", body: on ? {} : undefined, signal: signal() });
  },
  clearFresh: (itemIds) => api<BulkResult>("/api/items/bulk", { method: "POST", body: { itemIds, action: { type: "clearFresh" } }, signal: signal() }),
  // A saved copy of the item would show a workflow that may be out of date: only PURSS's own answer counts.
  workflowOf: async (itemId) => {
    const item = await api<ItemDTO>(`/api/items/${enc(itemId)}`, { signal: signal(), live: true });
    return { workflow: item.workflow, revision: item.revision };
  },
};

/** Only one tab sends at a time; the others leave it to the tab that holds the lock. */
async function exclusive(fn: () => Promise<void>): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) { await fn(); return true; }
  return locks.request("purss-outbox-send", { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

/** The same lock, waited for: Undo takes a queued change back only while no tab is sending. */
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request("purss-outbox-send", async () => fn()) : fn();
}

export const outbox = new Outbox({ store: openStore(), sender, serialize: serial, exclusive, locked });
