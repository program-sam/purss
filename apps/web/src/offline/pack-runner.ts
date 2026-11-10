import type { QueryClient } from "@tanstack/react-query";
import type { AnnotationList, ItemDTO, ItemDetail, ItemPage } from "@purss/domain";
import { ApiError, api } from "../api/client.ts";
import { PAGE, bootstrapQuery, itemsRequest, notificationsQuery, remindersQuery, sessionQuery } from "../api/queries.ts";
import type { ListParams } from "../api/queries.ts";
import { comingUpQuery } from "../api/reminder-queries.ts";
import { homeRequests } from "../pages/Home.tsx";
import { orderHome } from "../state/workspace.tsx";
import { NO_COPY_HEADER } from "../sw/protocol.ts";
import { PACK_CONCURRENCY, PACK_KEPT_LIMIT, PACK_LIMIT, annotationsToFetch, itemsToFetch, selectQueue, sourcesOf } from "./pack.ts";
import type { SavedItems } from "./pack.ts";
import { refreshPackStatus } from "./pack-status.ts";
import { readRecord, savedItemIds, writeRecord } from "./store.ts";

/** Most collection and source pages saved next to the queue itself. */
const PLACES_MAX = 40;

async function pool<T>(items: readonly T[], size: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** The pack gives up quietly when the connection goes; any other failure of one item only skips that item. */
function lostConnection(err: unknown): boolean {
  return (err instanceof ApiError && err.code === "offline") || (err instanceof DOMException && err.name === "AbortError");
}

/** Baskets whose kept items are looked up for the queue (those that save readable text). */
const KEPT_BASKETS_MAX = 10;

/**
 * Save the reading queue on this device: what is To read or In progress, what is kept in baskets that save readable text, and
 * New items not yet sorted. Everything goes through the worker, which keeps the answers: the app's start-up answers, the pages
 * that show the queue (not in a `light` save, made right after a change to what is read or kept), and the full text of each
 * queued item. Images are not saved; reading offline shows the text.
 */
export async function runPack(qc: QueryClient, accountId: string, signal: AbortSignal, opts: { light?: boolean } = {}): Promise<void> {
  const started = Date.now();
  const before = readRecord(accountId);
  writeRecord(accountId, { ...before, startedAt: started });

  const session = await qc.fetchQuery({ ...sessionQuery, staleTime: 0 });
  if (session.state !== "signed_in" || session.account?.id !== accountId) return;
  const boot = await qc.fetchQuery({ ...bootstrapQuery, staleTime: 0 });
  await Promise.allSettled([qc.fetchQuery({ ...notificationsQuery, staleTime: 0 }), qc.fetchQuery({ ...remindersQuery, staleTime: 0 }), qc.fetchQuery({ ...comingUpQuery, staleTime: 0 })]);

  // The queue itself, looked up without keeping these answers: they aren't a page anyone opens.
  const found: Record<"toread" | "inprogress" | "fresh", ItemDTO[]> = { toread: [], inprogress: [], fresh: [] };
  const lookup = (query: Record<string, string | number>) => api<ItemPage>("/api/items", { query: { sort: "newest", limit: PACK_LIMIT, ...query }, signal, headers: { [NO_COPY_HEADER]: "1" } });
  await pool(["toread", "inprogress", "fresh"] as const, PACK_CONCURRENCY, signal, async (filter) => {
    found[filter] = (await lookup({ scope: "all", filter })).items;
  });
  // Kept items worth reading offline: from baskets that keep the readable text, most recently kept first.
  const textBaskets = [...boot.baskets].filter((b) => b.captureMode === "text" && b.itemCount > 0).sort((a, b) => a.position - b.position).slice(0, KEPT_BASKETS_MAX);
  const keptBy = new Map<string, ItemDTO[]>();
  await pool(textBaskets, PACK_CONCURRENCY, signal, async (b) => {
    try { keptBy.set(b.id, (await lookup({ scope: `basket:${b.id}`, filter: "all", sort: "kept", limit: PACK_KEPT_LIMIT })).items); } catch (err) { if (lostConnection(err)) throw err; }
  });
  const queue = selectQueue({ ...found, kept: textBaskets.flatMap((b) => keptBy.get(b.id) ?? []) });

  // The pages that show it: Home as the person has set it up, each collection, and the sources behind the queue.
  if (!opts.light) {
    const collections = [...boot.collections].sort((a, b) => a.position - b.position);
    const shown = orderHome(collections, boot.preferences.homeCollectionIds);
    const place = (scope: string): { params: ListParams; limit: number } => ({ params: { scope, filter: "active", sort: "newest" }, limit: PAGE });
    const pages = [
      ...homeRequests(boot.preferences.homeLayout, shown),
      ...collections.slice(0, PLACES_MAX).map((c) => place(`collection:${c.id}`)),
      ...sourcesOf(queue, PLACES_MAX).map((id) => place(`source:${id}`)),
    ];
    const seen = new Set<string>();
    const distinct = pages.filter((p) => { const k = JSON.stringify([p.params, p.limit]); if (seen.has(k)) return false; seen.add(k); return true; });
    await pool(distinct, PACK_CONCURRENCY, signal, async (p) => {
      const r = itemsRequest(p.params, p.limit);
      try { await api<ItemPage>(r.path, { query: r.query, signal }); } catch (err) { if (lostConnection(err)) throw err; }
    });
  }

  // The text of each queued item, unless it is already saved and hasn't changed.
  const present = await savedItemIds(accountId);
  const saved: SavedItems = {};
  for (const it of queue) if (before.items[it.id]) saved[it.id] = before.items[it.id]!;
  const refetched = new Set<string>();
  await pool(itemsToFetch(queue, before.items, present, started), PACK_CONCURRENCY, signal, async (it) => {
    try {
      const detail = await api<ItemDetail>(`/api/items/${encodeURIComponent(it.id)}`, { signal });
      const textPending = detail.captures.some((c) => c.level === "pending");
      saved[it.id] = { stateVersion: detail.stateVersion, at: Date.now(), ...(textPending ? { textPending } : {}) };
      refetched.add(it.id);
    } catch (err) {
      if (lostConnection(err)) throw err;
      delete saved[it.id];
    }
  });
  // The person's highlights and notes on those items, so they show offline too.
  await pool(annotationsToFetch(queue.filter((it) => saved[it.id]), before.items, refetched), PACK_CONCURRENCY, signal, async (it) => {
    const { annotatedAt: _previous, ...rest } = saved[it.id]!;
    saved[it.id] = rest;
    try {
      await api<AnnotationList>(`/api/items/${encodeURIComponent(it.id)}/annotations`, { signal });
      saved[it.id] = { ...rest, annotatedAt: it.annotatedAt! };
    } catch (err) {
      if (lostConnection(err)) throw err;
    }
  });
  if (signal.aborted) return;

  writeRecord(accountId, { startedAt: started, savedAt: new Date().toISOString(), items: saved });
  await refreshPackStatus(accountId);
}
