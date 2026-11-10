import type { CollectionDTO, Preferences, SourceDTO } from "@purss/domain";
import type { OTHER_BOX_ID as DomainOtherBoxId } from "@purss/domain";

/** The id Home's "Other sources" box has in the order list; the same value as in the shared contract. */
export const OTHER_BOX_ID: typeof DomainOtherBoxId = "other";

/** The scope of the items a Home box lists. */
export const boxScope = (c: Pick<CollectionDTO, "id">): string => (c.id === OTHER_BOX_ID ? "loose" : `collection:${c.id}`);
export const isOtherBox = (c: Pick<CollectionDTO, "id">): boolean => c.id === OTHER_BOX_ID;

/** Sources that are in no collection, shaped like a collection so a Home box can show them. */
export function otherSourcesBox(loose: readonly SourceDTO[]): CollectionDTO {
  return {
    id: OTHER_BOX_ID, name: "Other sources", emoji: null, mode: "sources", view: "list", position: Number.MAX_SAFE_INTEGER, showOnHome: true,
    sourceIds: loose.map((s) => s.id), query: null,
    freshCount: loose.reduce((n, s) => n + s.freshCount, 0), itemCount: loose.reduce((n, s) => n + s.itemCount, 0),
    aiFiltered: false,
  };
}

/**
 * The boxes Home shows, in order: the collections chosen for Home in Customise's order, with "Other sources" among
 * them where Customise put it (last until moved), unless it is switched off or there are no such sources.
 */
export function homeBoxes(shown: readonly CollectionDTO[], loose: readonly SourceDTO[], prefs: Pick<Preferences, "homeOther" | "homeCollectionIds">): CollectionDTO[] {
  if (!loose.length || !prefs.homeOther) return [...shown];
  const rank = new Map(prefs.homeCollectionIds.map((id, i) => [id, i] as const));
  const at = rank.get(OTHER_BOX_ID);
  const other = otherSourcesBox(loose);
  if (at === undefined) return [...shown, other];
  const before = shown.filter((c) => (rank.get(c.id) ?? Infinity) < at).length;
  return [...shown.slice(0, before), other, ...shown.slice(before)];
}

/** Items a Home box asks for beyond the ones it shows: some may already be shown by a section above it or by an earlier box. */
export const DEDUPE_SLACK = 12;

/**
 * An item shows in one Home section only, the first that has it. These are the lists of Home's boxes in the order they are
 * shown, with how many rows each shows (none for a collapsed box). Each list loses the items that `seen` (the rows above the
 * boxes) or an earlier box shows, keeps its first `limits[i]`, and only those count as shown: an item a box fetched but has no
 * row for is left to a later box.
 */
export function distribute<T extends { id: string }>(lists: readonly (readonly T[])[], seen: ReadonlySet<string>, limits: readonly number[]): T[][] {
  const taken = new Set(seen);
  return lists.map((list, i) => {
    const shown = list.filter((it) => !taken.has(it.id)).slice(0, limits[i] ?? 0);
    for (const it of shown) taken.add(it.id);
    return shown;
  });
}
