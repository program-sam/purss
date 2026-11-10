import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { infiniteQueryOptions, queryOptions, replaceEqualDeep } from "@tanstack/react-query";
import type { BasketDTO, Bootstrap, CollectionStatsResponse, SourceDTO, ItemDTO, ItemDetail, ItemPage, NotificationDTO, ReminderDTO, SearchResult, SessionInfo, SourceStatsResponse } from "@purss/domain";
import { ApiError, get, setCsrf } from "./client.ts";
import { isNewerCopy, withNewerState } from "../lib/items.ts";
import { outbox } from "../outbox/instance.ts";
import type { SecurityInfo } from "./types.ts";

/** One place for every query key and fetcher, so cache updates and invalidation stay in step. */

export const keys = {
  session: ["session"] as const,
  bootstrap: ["bootstrap"] as const,
  items: ["items"] as const,
  stats: ["stats"] as const,
  item: (id: string) => ["item", id] as const,
  annotations: (itemId: string) => ["annotations", itemId] as const,
  notifications: ["notifications"] as const,
  reminders: ["reminders"] as const,
  security: ["security"] as const,
  search: (q: string) => ["search", q] as const,
};

export const sessionQuery = queryOptions({
  queryKey: keys.session,
  queryFn: async () => {
    const s = await get<SessionInfo>("/api/session");
    setCsrf(s.csrf);
    // Whoever is signed in owns the outbox queue; a different account sets the previous one's aside.
    outbox.setAccount(s.state === "signed_in" ? s.account?.id ?? null : null);
    return s;
  },
  staleTime: 5 * 60_000,
});

export const bootstrapQuery = queryOptions({
  queryKey: keys.bootstrap,
  queryFn: () => get<Bootstrap>("/api/bootstrap"),
  staleTime: 30_000,
});

export type ListParams = {
  scope: string;
  filter: string;
  sort: string;
  source?: string;
  q?: string;
  /** "home": a list as Home shows it: only sources with a box on Home, New first, then the rest, newest first within each. */
  mix?: "home";
  /** Leave these sources out of the list (comma separated). */
  without?: string;
  /** Item types, comma separated: articles, videos, podcasts. */
  type?: string;
  length?: "short" | "long";
  /** Show the items that muted words leave out. */
  muted?: "show";
  /** Only items whose text could not be saved. */
  capture?: "failed";
};

export const PAGE = 50;

/**
 * A reloaded list keeps the newer state of items it already shows: on a slow network the answer can be this device's offline
 * copy, saved before changes the person has made since (the outbox overlay covers only changes not yet confirmed).
 */
function keepNewerStates(old: unknown, next: unknown): unknown {
  const known = new Map<string, ItemDTO>();
  const pagesOf = (d: unknown): ItemPage[] => (isInfinite(d) ? d.pages : d && typeof d === "object" && "items" in d ? [d as ItemPage] : []);
  for (const p of pagesOf(old)) for (const it of p.items) known.set(it.id, it);
  if (!known.size) return replaceEqualDeep(old, next);
  const merge = (p: ItemPage): ItemPage => ({ ...p, items: p.items.map((it) => withNewerState(it, known.get(it.id))) });
  const merged = isInfinite(next) ? { ...next, pages: next.pages.map(merge) } : pagesOf(next).length ? merge(next as ItemPage) : next;
  return replaceEqualDeep(old, merged);
}

/**
 * Changes made here that PURSS has not confirmed yet (the outbox) show on whatever is fetched
 * meanwhile, so a refresh or a reload never flips an item back before its change has been sent.
 */
async function withPending(scope: string | undefined, page: ItemPage): Promise<ItemPage> {
  await outbox.ready;
  if (!outbox.pendingCount()) return page;
  const gone = scope?.startsWith("basket:") ? outbox.removedFromBasket(scope.slice("basket:".length)) : null;
  const items = outbox.overlay(gone?.size ? page.items.filter((it) => !gone.has(it.id)) : page.items);
  return { ...page, items };
}

/** The request behind every item list and preview, so the offline pack asks for exactly what the pages ask for. */
export function itemsRequest(p: ListParams, limit: number, cursor?: string): { path: string; query: Record<string, string | number | undefined> } {
  return { path: "/api/items", query: { ...p, cursor, limit } };
}

export function itemListQuery(p: ListParams) {
  return infiniteQueryOptions({
    queryKey: [...keys.items, "list", p] as const,
    queryFn: async ({ pageParam, signal }) => { const r = itemsRequest(p, PAGE, pageParam); return withPending(p.scope, await get<ItemPage>(r.path, r.query, signal)); },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    structuralSharing: keepNewerStates,
    staleTime: 15_000,
  });
}

/** A single short page (Home modules, Front page headlines). */
export function itemPreviewQuery(p: ListParams, limit: number) {
  return queryOptions({
    queryKey: [...keys.items, "preview", p, limit] as const,
    queryFn: async ({ signal }) => { const r = itemsRequest(p, limit); return withPending(p.scope, await get<ItemPage>(r.path, r.query, signal)); },
    structuralSharing: keepNewerStates,
    staleTime: 15_000,
  });
}

export const itemDetailQuery = (id: string) => queryOptions({
  queryKey: keys.item(id),
  queryFn: async ({ signal }) => {
    const detail = await get<ItemDetail>(`/api/items/${encodeURIComponent(id)}`, undefined, signal);
    await outbox.ready;
    return outbox.overlay([detail])[0]!;
  },
  structuralSharing: (old: unknown, next: unknown) => replaceEqualDeep(old, withNewerState(next as ItemDetail, old as ItemDetail | undefined)),
  staleTime: 30_000,
});

/** Private statistics for one source or one collection (GET /api/stats/...). */
export const sourceStatsQuery = (id: string) => queryOptions({
  queryKey: [...keys.stats, "source", id] as const,
  queryFn: ({ signal }) => get<SourceStatsResponse>(`/api/stats/sources/${encodeURIComponent(id)}`, undefined, signal),
  staleTime: 15_000,
});
export const collectionStatsQuery = (id: string) => queryOptions({
  queryKey: [...keys.stats, "collection", id] as const,
  queryFn: ({ signal }) => get<CollectionStatsResponse>(`/api/stats/collections/${encodeURIComponent(id)}`, undefined, signal),
  staleTime: 15_000,
});

export const notificationsQuery = queryOptions({
  queryKey: keys.notifications,
  queryFn: () => get<NotificationDTO[]>("/api/notifications"),
  staleTime: 15_000,
});

/** GET /api/reminders. A missing endpoint (404) means "no reminders", never an error to show. */
export const remindersQuery = queryOptions({
  queryKey: keys.reminders,
  queryFn: async (): Promise<ReminderDTO[]> => {
    try {
      const out = await get<ReminderDTO[] | { reminders: ReminderDTO[] }>("/api/reminders");
      return Array.isArray(out) ? out : out.reminders ?? [];
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return [];
      throw err;
    }
  },
  staleTime: 5 * 60_000,
  retry: false,
});

export const securityQuery = queryOptions({
  queryKey: keys.security,
  queryFn: () => get<SecurityInfo>("/api/account/security"),
});

export const searchQuery = (q: string) => queryOptions({
  queryKey: keys.search(q),
  queryFn: ({ signal }) => get<SearchResult>("/api/search", { q }, signal),
  staleTime: 10_000,
});

// ---------- item cache helpers ----------

type ListData = InfiniteData<ItemPage>;

function isInfinite(d: unknown): d is ListData {
  return !!d && typeof d === "object" && "pages" in d;
}

/** Replace an item everywhere it is cached (lists, previews, detail), keeping the copy with the higher state version. */
export function putItem(qc: QueryClient, dto: ItemDTO): void {
  const swap = (it: ItemDTO) => (it.id === dto.id && !isNewerCopy(it, dto) ? { ...it, ...dto } : it);
  qc.setQueriesData({ queryKey: keys.items }, (old: unknown) => {
    if (isInfinite(old)) return { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map(swap) })) };
    if (old && typeof old === "object" && "items" in old) return { ...(old as ItemPage), items: (old as ItemPage).items.map(swap) };
    return old;
  });
  qc.setQueryData<ItemDetail>(keys.item(dto.id), (old) => (old && !isNewerCopy(old, dto) ? { ...old, ...dto } : old));
}

/** Take an item out of the loaded lists for one scope (e.g. "basket:<id>") straight away. */
export function dropFromScope(qc: QueryClient, scope: string, id: string): void {
  qc.setQueriesData({ queryKey: [...keys.items, "list"], predicate: (q) => (q.queryKey[2] as { scope?: string } | undefined)?.scope === scope }, (old: unknown) => {
    if (!isInfinite(old)) return old;
    return { ...old, pages: old.pages.map((p, i) => {
      const items = p.items.filter((it) => it.id !== id);
      const gone = p.items.length - items.length;
      return { ...p, items, total: i === 0 && typeof p.total === "number" && gone ? Math.max(0, p.total - 1) : p.total };
    }) };
  });
}

/** Latest cached copy of an item, wherever it is loaded. */
export function findItem(qc: QueryClient, id: string): ItemDTO | undefined {
  let best: ItemDTO | undefined;
  const consider = (it: ItemDTO) => { if (it.id === id && (!best || isNewerCopy(it, best))) best = it; };
  for (const [, data] of qc.getQueriesData({ queryKey: keys.items })) {
    if (isInfinite(data)) data.pages.forEach((p) => p.items.forEach(consider));
    else if (data && typeof data === "object" && "items" in data) (data as ItemPage).items.forEach(consider);
  }
  const detail = qc.getQueryData<ItemDetail>(keys.item(id));
  if (detail) consider(detail);
  return best;
}

/** Show a renamed or changed source in the sidebar, headings and pickers at once, with PURSS's own answer. */
export function putSource(qc: QueryClient, dto: SourceDTO): void {
  qc.setQueryData<Bootstrap>(keys.bootstrap, (cur) => (cur ? { ...cur, sources: cur.sources.map((s) => (s.id === dto.id ? { ...s, ...dto } : s)) } : cur));
}

/** Show a new or changed basket in the sidebar and the Keep list at once. */
export function putBasket(qc: QueryClient, dto: BasketDTO): void {
  qc.setQueryData<Bootstrap>(keys.bootstrap, (cur) => {
    if (!cur) return cur;
    return cur.baskets.some((b) => b.id === dto.id) ? { ...cur, baskets: cur.baskets.map((b) => (b.id === dto.id ? { ...b, ...dto } : b)) } : { ...cur, baskets: [...cur.baskets, dto] };
  });
}

/** After changes the server owns the truth: refresh everything that shows items or counts. */
export function refreshWorkspace(qc: QueryClient, opts: { items?: boolean } = { items: true }): void {
  void qc.invalidateQueries({ queryKey: keys.bootstrap });
  if (opts.items !== false) {
    void qc.invalidateQueries({ queryKey: keys.items });
    void qc.invalidateQueries({ queryKey: ["item"] });
    void qc.invalidateQueries({ queryKey: keys.stats });
  }
}
