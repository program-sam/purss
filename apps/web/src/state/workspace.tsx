import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { BasketDTO, Bootstrap, CollectionDTO, Preferences, SourceDTO } from "@purss/domain";

/** The loaded PURSS (sidebar data and preferences) with lookups, available below the shell. */
export type Workspace = {
  data: Bootstrap;
  /** Preferences with the time zone resolved: the account's choice, else this device's. */
  prefs: Preferences & { timezone: string };
  sourceById: Map<string, SourceDTO>;
  collectionById: Map<string, CollectionDTO>;
  basketById: Map<string, BasketDTO>;
  /** Collections in sidebar order. */
  collections: CollectionDTO[];
  /** Collections shown on Home, in the order chosen in Customise Home. */
  homeCollections: CollectionDTO[];
  /** Followed sources that are in no collection. */
  looseSources: SourceDTO[];
  /** Sources that belong to a collection, in the order the collection lists them (alphabetical). */
  sourcesOf: (c: CollectionDTO) => SourceDTO[];
};

/** This browser's time zone, or UTC when the browser doesn't say. */
export function deviceTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

const Ctx = createContext<Workspace | null>(null);

/** What item rows show of their source and baskets. Keeps its identity while only counts change, so rows stay put. */
export type RowLookups = {
  source: (id: string) => SourceDTO | undefined;
  basketName: (id: string) => string | undefined;
};
const LookupCtx = createContext<RowLookups | null>(null);

function lookupSignature(data: Bootstrap): string {
  const sources = data.sources.map((s) => [s.id, s.hue, s.initials, s.iconUrl ?? "", s.title, s.curator ?? ""].join("\u0001"));
  const baskets = data.baskets.map((b) => `${b.id}\u0001${b.name}`);
  return `${sources.join("\u0002")}\u0003${baskets.join("\u0002")}`;
}

export function orderHome(collections: CollectionDTO[], order: string[]): CollectionDTO[] {
  const visible = collections.filter((c) => c.showOnHome);
  const rank = new Map(order.map((id, i) => [id, i] as const));
  return [...visible].sort((a, b) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.position - b.position;
  });
}

export function WorkspaceProvider({ data, children }: { data: Bootstrap; children: ReactNode }) {
  const value = useMemo<Workspace>(() => {
    const sourceById = new Map(data.sources.map((s) => [s.id, s]));
    const collections = [...data.collections].sort((a, b) => a.position - b.position);
    const inCollection = new Set(collections.flatMap((c) => c.sourceIds));
    return {
      data,
      prefs: { ...data.preferences, timezone: data.preferences.timezone ?? deviceTimezone() },
      sourceById,
      collectionById: new Map(collections.map((c) => [c.id, c])),
      basketById: new Map(data.baskets.map((b) => [b.id, b])),
      collections,
      homeCollections: orderHome(collections, data.preferences.homeCollectionIds),
      looseSources: data.sources.filter((s) => !inCollection.has(s.id) && !s.collectionIds.some((id) => collections.some((c) => c.id === id))),
      sourcesOf: (c) => c.sourceIds.map((id) => sourceById.get(id)).filter((s): s is SourceDTO => !!s),
    };
  }, [data]);
  const signature = lookupSignature(data);
  const lookups = useMemo<RowLookups>(() => ({
    source: (id) => value.sourceById.get(id),
    basketName: (id) => value.basketById.get(id)?.name,
  }), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}><LookupCtx.Provider value={lookups}>{children}</LookupCtx.Provider></Ctx.Provider>;
}

export function useRowLookups(): RowLookups {
  const v = useContext(LookupCtx);
  if (!v) throw new Error("WorkspaceProvider is missing");
  return v;
}

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error("WorkspaceProvider is missing");
  return v;
}
