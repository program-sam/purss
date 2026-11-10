import type { MenuEntry } from "@purss/ui";
import type { ListParams } from "../api/queries.ts";
import type { ViewMode } from "@purss/domain";
import { FILTER_LABELS } from "./constants.ts";
import type { ListFilter } from "./constants.ts";
import type { ListSearch, Place } from "../nav.ts";
import type { ListState } from "../pages/list-state.ts";

/** Item types a list can be limited to. */
export type ItemTypeFilter = "articles" | "videos" | "podcasts";

/** The parts of a list request that come from the page's address besides its scope, filter and sort. */
export function listFilters(ls: ListState): Pick<ListParams, "source" | "without" | "type" | "length" | "muted" | "capture"> {
  return {
    ...(ls.source ? { source: ls.source } : {}),
    ...(ls.without ? { without: ls.without } : {}),
    ...(ls.types.length ? { type: ls.types.join(",") } : {}),
    ...(ls.length ? { length: ls.length } : {}),
    ...(ls.showMuted ? { muted: "show" as const } : {}),
    ...(ls.captureFailed ? { capture: "failed" as const } : {}),
  };
}

/**
 * A collection opens on its new items while it has any, and on everything but ignored once it has none.
 * The board keeps every item, since its columns are the workflow; a basket shows everything kept in it,
 * since ignoring is for what arrives, not for what was saved; other pages show everything but ignored.
 */
export function defaultFilterFor(place: Place | null, view: ViewMode, freshCount: number): ListFilter {
  if (place?.t === "b") return "all";
  return place?.t === "c" && view !== "board" && freshCount > 0 ? "fresh" : "active";
}

/** The filter a page uses for the one its address names: a basket has no Ignored filter, and its All keeps ignored items too. */
export function filterFor(place: Place | null, named: ListFilter | undefined, fallback: ListFilter): ListFilter {
  if (place?.t === "b" && (named === "active" || named === "ignored")) return "all";
  return named ?? fallback;
}

/** The filters a page's menu offers: a basket's All already includes ignored items, so it has no Ignored choice. */
export function filterChoices(place: Place | null): ListFilter[] {
  return place?.t === "b" ? ["all", "fresh", "new", "toread", "inprogress", "finished"] : ["active", "fresh", "new", "toread", "inprogress", "finished", "ignored"];
}

/** A filter's name on this page: a basket calls its everything filter All. */
export function filterLabel(place: Place | null, f: ListFilter): string {
  return place?.t === "b" && f === "all" ? FILTER_LABELS.active : FILTER_LABELS[f];
}

/** The address value for a chosen filter: left out when it is the page's default. */
export function filterParam(ls: Pick<ListState, "defaultFilter">, f: ListFilter): ListFilter | undefined {
  return f === ls.defaultFilter ? undefined : f;
}

/** Whether the list is narrowed by anything beyond its workflow filter: a source, a type, a length. */
export function isNarrowed(ls: ListState): boolean {
  return !!(ls.source || ls.without || ls.types.length || ls.length || ls.captureFailed);
}

const TYPE_LABELS: Record<ItemTypeFilter, string> = { articles: "Articles", videos: "Videos", podcasts: "Podcasts" };
const TYPE_ORDER: readonly ItemTypeFilter[] = ["articles", "videos", "podcasts"];
const LENGTH_LABELS = { short: "Short (up to 5 min)", long: "Long (over 5 min)" } as const;

/** The filter menu's Type and Length choices. Items whose length is not known are in neither Short nor Long. */
export function typeLengthEntries(ls: ListState, patch: (p: Pick<ListSearch, "type" | "length">) => void): MenuEntry[] {
  const toggle = (t: ItemTypeFilter) => {
    const next = TYPE_ORDER.filter((x) => (x === t ? !ls.types.includes(t) : ls.types.includes(x)));
    patch({ type: next.length ? next.join(",") : undefined });
  };
  return [
    { type: "separator" },
    { type: "heading", label: "Type" },
    ...TYPE_ORDER.map<MenuEntry>((t) => ({ type: "check", label: TYPE_LABELS[t], on: ls.types.includes(t), onSelect: () => toggle(t) })),
    { type: "separator" },
    { type: "heading", label: "Length" },
    { type: "radio", label: "Any length", on: !ls.length, onSelect: () => patch({ length: undefined }) },
    { type: "radio", label: LENGTH_LABELS.short, on: ls.length === "short", onSelect: () => patch({ length: "short" }) },
    { type: "radio", label: LENGTH_LABELS.long, on: ls.length === "long", onSelect: () => patch({ length: "long" }) },
  ];
}

/** What the type and length choices add to the filter button, for example "Videos, Short"; empty when none is chosen. */
export function typeLengthSummary(ls: ListState): string {
  const parts = [ls.types.map((t) => TYPE_LABELS[t]).join(", "), ls.length ? LENGTH_LABELS[ls.length].split(" (")[0]! : ""].filter(Boolean);
  return parts.join(", ");
}

/** The item types an address names, in one fixed order so a bookmarked address means one list; undefined when it names none. */
export function typesParam(value: unknown): string | undefined {
  const given = typeof value === "string" ? value.split(",") : [];
  const kept = TYPE_ORDER.filter((t) => given.includes(t));
  return kept.length ? kept.join(",") : undefined;
}
