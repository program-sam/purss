import type { QueryClient } from "@tanstack/react-query";
import type { AnnotationList, ItemDTO, ItemDetail, ItemPage } from "@purss/domain";
import { ApiError, api } from "../api/client.ts";
import { PAGE, bootstrapQuery, itemsRequest, notificationsQuery, remindersQuery, sessionQuery } from "../api/queries.ts";
import type { ListParams } from "../api/queries.ts";
import { comingUpQuery } from "../api/reminder-queries.ts";
import { homeRequests } from "../pages/Home.tsx";
import { orderHome } from "../state/purss.tsx";
import { platform } from "../platform/index.ts";
import { NO_COPY_HEADER, pictureCacheName } from "../sw/protocol.ts";
import {
  PACK_CONCURRENCY, PACK_ICONS_LIMIT, PACK_KEPT_LIMIT, PACK_LIMIT, annotationsToFetch, itemsToFetch, picturesIn, picturesToForget, selectQueue, sourcesOf,
} from "./pack.ts";
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
 * queued item. The worker also keeps pictures: every source's icon, and the pictures kept with the copies of kept items;
 * other pictures in an article are the publisher's and are not saved.
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
  const found: Record<"toread" | "inprogress" | "new", ItemDTO[]> = { toread: [], inprogress: [], new: [] };
  const lookup = (query: Record<string, string | number>) => api<ItemPage>("/api/items", { query: { sort: "newest", limit: PACK_LIMIT, ...query }, signal, headers: { [NO_COPY_HEADER]: "1" } });
  await pool(["toread", "inprogress", "new"] as const, PACK_CONCURRENCY, signal, async (filter) => {
    found[filter] = (await lookup({ scope: "all", filter })).items;
  });
  // Kept items worth reading offline: from baskets that keep the readable text, most recently kept first.
  const textBaskets = [...boot.baskets].filter((b) => b.captureMode === "text" && b.itemCount > 0).sort((a, b) => a.position - b.position).slice(0, KEPT_BASKETS_MAX);
  const keptBy = new Map<string, ItemDTO[]>();
  await pool(textBaskets, PACK_CONCURRENCY, signal, async (b) => {
    try { keptBy.set(b.id, (await lookup({ scope: `basket:${b.id}`, filter: "all_with_ignored", sort: "kept", limit: PACK_KEPT_LIMIT })).items); } catch (err) { if (lostConnection(err)) throw err; }
  });
  const kept = textBaskets.flatMap((b) => keptBy.get(b.id) ?? []);
  const queue = selectQueue({ ...found, kept });

  // The pages that show it: Home as the person has set it up, each collection, and the sources behind the queue.
  if (!opts.light) {
    const collections = [...boot.collections].sort((a, b) => a.position - b.position);
    const shown = orderHome(collections, boot.preferences.homeCollectionIds);
    const place = (scope: string): { params: ListParams; limit: number } => ({ params: { scope, filter: "all", sort: "newest" }, limit: PAGE });
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
  for (const it of queue) if (before.items[it.id]) saved[it.id] = { ...before.items[it.id]!, number: it.number };
  const refetched = new Set<string>();
  const keptIds = new Set(kept.map((it) => it.id));
  const keptPictures: string[] = [];
  await pool(itemsToFetch(queue, before.items, present, started), PACK_CONCURRENCY, signal, async (it) => {
    try {
      const detail = await api<ItemDetail>(`/api/items/${encodeURIComponent(it.id)}`, { signal });
      if (keptIds.has(it.id)) keptPictures.push(...picturesIn(it.id, [detail.contentHtml, detail.latestHtml, detail.partialCopy?.html, detail.keptPicture, ...detail.gallery]));
      const textPending = detail.captures.some((c) => c.level === "pending");
      saved[it.id] = { stateVersion: detail.stateVersion, at: Date.now(), number: it.number, ...(textPending ? { textPending } : {}) };
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
  const icons = boot.sources.flatMap((src) => (src.iconUrl ? [src.iconUrl] : [])).slice(0, PACK_ICONS_LIMIT);
  await savePictures(accountId, signal, icons, keptPictures, new Set(queue.filter((it) => keptIds.has(it.id) && saved[it.id]).map((it) => it.id)));
  if (signal.aborted) return;

  writeRecord(accountId, { startedAt: started, savedAt: new Date().toISOString(), items: saved });
  await refreshPackStatus(accountId);
}

/**
 * Fetch the pictures not yet saved (the worker keeps each as it passes), then let go of the ones no longer wanted. Kept
 * pictures of an item saved earlier stay as they are; they are looked at again when its text is next fetched.
 */
async function savePictures(accountId: string, signal: AbortSignal, icons: readonly string[], keptPictures: readonly string[], keptItems: ReadonlySet<string>): Promise<void> {
  const caches = platform.offline.caches();
  if (!caches) return;
  const name = pictureCacheName(accountId);
  const savedPaths = async () => {
    if (!(await caches.has(name))) return new Map<string, Request>();
    return new Map((await (await caches.open(name)).keys()).map((key) => { const u = new URL(key.url); return [u.pathname + u.search, key] as const; }));
  };
  const before = await savedPaths();
  const missing = [...new Set([...icons, ...keptPictures])].filter((path) => !before.has(path));
  await pool(missing, PACK_CONCURRENCY, signal, async (path) => {
    try {
      const res = await platform.transport.fetch(path, { signal });
      await res.arrayBuffer();
    } catch (err) {
      if (lostConnection(err) || signal.aborted) throw err;
      // Otherwise skip this one: the next save tries again.
    }
  });
  if (signal.aborted) return;
  const after = await savedPaths();
  const forget = picturesToForget([...after.keys()], new Set(icons), keptItems);
  if (forget.length === 0) return;
  const cache = await caches.open(name);
  await Promise.all(forget.map((path) => cache.delete(after.get(path)!)));
}
