import { useSearch } from "@tanstack/react-router";
import type { Sort, ViewMode } from "@purss/domain";
import { useBreakpoint } from "@purss/ui";
import type { ListFilter } from "../lib/constants.ts";
import type { ListSearch, Place } from "../nav.ts";
import { defaultFilterFor, filterFor } from "../lib/list-filters.ts";
import type { ItemTypeFilter } from "../lib/list-filters.ts";
import { useOpenHold } from "../state/open-hold.ts";
import { useWorkspace } from "../state/workspace.tsx";

export type ListState = {
  scope: string;
  view: ViewMode;
  modes: ViewMode[];
  filter: ListFilter;
  /** The filter the page shows when the address names none. */
  defaultFilter: ListFilter;
  sort: Sort;
  source: string | undefined;
  /** A source left out of the list. */
  without: string | undefined;
  /** Item types the list is limited to (articles, videos, podcasts), and short or long ones. */
  types: ItemTypeFilter[];
  length: "short" | "long" | undefined;
  /** Items that match muted words show too. */
  showMuted: boolean;
  /** Only items whose text could not be saved. */
  captureFailed: boolean;
  itemId: string | undefined;
};

const SCOPE_WORD = { c: "collection", s: "source", b: "basket" } as const;

export function scopeOf(place: Place): string {
  return place.t === "home" ? "home" : place.t === "r" ? "toread" : `${SCOPE_WORD[place.t]}:${place.id}`;
}

/** Views offered on a page: baskets keep to list, cards and timeline; phones drop the wide table. */
export function modesFor(place: Place | null, xs: boolean): ViewMode[] {
  if (place?.t === "b" || place?.t === "r") return ["list", "cards", "timeline"];
  return xs ? ["list", "cards", "board", "timeline"] : ["list", "cards", "board", "table", "timeline"];
}

/** View, filter, sort and scope for the current list page, read from the URL with sensible defaults. */
export function useListState(place: Place | null): ListState {
  const search = useSearch({ strict: false }) as ListSearch;
  const ws = useWorkspace();
  const xs = useBreakpoint() === "xs";
  const modes = modesFor(place, xs);
  const dflt: ViewMode = place?.t === "c" ? ws.collectionById.get(place.id)?.view ?? "list" : "list";
  const wanted = search.view ?? dflt;
  const view = modes.includes(wanted) ? wanted : "list";
  // The open item that was New still counts as New here until the panel closes, so the list behind does not switch.
  const held = useOpenHold();
  const freshCount = place?.t === "c" ? ws.collectionById.get(place.id)?.freshCount ?? 0 : 0;
  const defaultFilter = defaultFilterFor(place, view, freshCount + (held && held === search.item ? 1 : 0));
  return {
    scope: place ? scopeOf(place) : "all",
    modes,
    view,
    filter: filterFor(place, search.filter, defaultFilter),
    defaultFilter,
    sort: search.sort ?? "newest",
    source: search.source,
    without: search.without,
    types: search.type ? (search.type.split(",") as ItemTypeFilter[]) : [],
    length: search.length,
    showMuted: search.muted === "show",
    captureFailed: search.capture === "failed",
    itemId: search.item,
  };
}
