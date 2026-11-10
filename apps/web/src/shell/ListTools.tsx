import { useQueryClient } from "@tanstack/react-query";
import type { Sort, ViewMode } from "@purss/domain";
import { Icon, useBreakpoint } from "@purss/ui";
import type { MenuEntry } from "@purss/ui";
import { patch } from "../api/client.ts";
import { SORT_LABELS, SORT_ORDER, VIEW_LABELS } from "../lib/constants.ts";
import { filterChoices, filterLabel, filterParam, typeLengthEntries, typeLengthSummary } from "../lib/list-filters.ts";
import { useNav } from "../nav.ts";
import type { Place } from "../nav.ts";
import { useListState } from "../pages/list-state.ts";
import { useSelection } from "../state/selection.tsx";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { useMainWidth } from "../lib/use-now.ts";

/** A list page's view, filter, sort and select controls; the page places them in its own header. */
export function ListTools({ place }: { place: Exclude<Place, { t: "home" }> }) {
  const ws = useWorkspace();
  const nav = useNav();
  const overlays = useOverlays();
  const popups = usePopups();
  const sel = useSelection();
  const qc = useQueryClient();
  const ls = useListState(place);
  const mainWidth = useMainWidth();
  const bp = useBreakpoint();

  const setView = (v: ViewMode) => {
    nav.patchSearch({ view: v });
    if (place.t === "c" && ws.collectionById.get(place.id)?.view !== v) {
      // Remembered per collection: the collection's default view follows the last one chosen.
      void patch(`/api/collections/${encodeURIComponent(place.id)}`, { view: v }).then(() => qc.invalidateQueries({ queryKey: ["bootstrap"] }), () => undefined);
    }
  };

  const filterEntries = (): MenuEntry[] => {
    const radios = filterChoices(place).map<MenuEntry>((f) => ({
      type: "radio", label: filterLabel(place, f), on: ls.filter === f || (f === "active" && ls.filter === "all"), onSelect: () => nav.patchSearch({ filter: filterParam(ls, f) }),
    }));
    // A basket has nothing to ignore: its All already shows everything kept in it.
    if (place.t === "b") return [...radios, ...typeLengthEntries(ls, nav.patchSearch)];
    const canToggle = ls.filter === "active" || ls.filter === "all";
    return [...radios, { type: "separator" }, { type: "check", label: "Show ignored items", on: ls.filter === "all", disabled: !canToggle, onSelect: () => nav.patchSearch({ filter: filterParam(ls, ls.filter === "all" ? "active" : "all") }) }, ...typeLengthEntries(ls, nav.patchSearch)];
  };
  const sortEntries = (): MenuEntry[] =>
    SORT_ORDER.filter((s) => s !== "kept" || place.t === "b").map<MenuEntry>((s: Sort) => ({ type: "radio", label: SORT_LABELS[s], on: ls.sort === s, onSelect: () => nav.patchSearch({ sort: s === "newest" ? undefined : s }) }));

  const moreEntries = (): MenuEntry[] => {
    if (place.t === "c") {
      const c = ws.collectionById.get(place.id);
      return [
        { label: "Collection settings…", icon: "gear", onSelect: () => overlays.open({ kind: "collection-settings", id: place.id }) },
        ...(c?.mode === "sources" ? [
          { label: "Add source here", icon: "plus" as const, onSelect: () => overlays.open({ kind: "add-source", collectionId: place.id }) },
          { label: "Smart filter…", icon: "filter" as const, onSelect: () => overlays.open({ kind: "ai-filter", collectionId: place.id }) },
        ] : []),
      ];
    }
    if (place.t === "b") return [{ label: "Basket settings…", icon: "gear", onSelect: () => overlays.open({ kind: "basket-form", id: place.id }) }, { label: "Delete basket…", icon: "trash", onSelect: () => overlays.open({ kind: "basket-delete", id: place.id }) }];
    return [];
  };
  const menuLabel = place.t === "c" ? "More for this collection" : place.t === "b" ? "More for this basket" : "More";

  // On a phone Select joins the menu, so the toolbar fits on one line.
  const menu = (): MenuEntry[] => {
    const more = moreEntries();
    if (bp !== "xs") return more;
    const select: MenuEntry = { type: "check", label: "Select items", on: sel.selecting, onSelect: () => sel.setSelecting(!sel.selecting) };
    return more.length ? [select, { type: "separator" }, ...more] : [select];
  };

  return (
    <div className="bar-tools ltools" role="toolbar" aria-label="List options">
      {mainWidth >= 740 ? (
        <div className="seg" role="group" aria-label="View">
          {ls.modes.map((m) => <button key={m} type="button" aria-pressed={ls.view === m} onClick={() => setView(m)}>{VIEW_LABELS[m]}</button>)}
        </div>
      ) : (
        <button type="button" className="mbtn" aria-haspopup="menu" aria-label={`View: ${VIEW_LABELS[ls.view]}`}
          onClick={(e) => popups.menu(e.currentTarget, ls.modes.map<MenuEntry>((m) => ({ type: "radio", label: VIEW_LABELS[m], on: ls.view === m, onSelect: () => setView(m) })), "View")}>
          <span className="k">View</span>{VIEW_LABELS[ls.view]}<Icon name="chev" size="sm" />
        </button>
      )}
      <button type="button" className="mbtn" aria-haspopup="menu" aria-label={`Filter: ${filterLabel(place, ls.filter)}${typeLengthSummary(ls) ? `, ${typeLengthSummary(ls)}` : ""}`} onClick={(e) => popups.menu(e.currentTarget, filterEntries(), "Filter items")}>
        <Icon name="filter" /><span className="k">Show</span>{filterLabel(place, ls.filter)}{typeLengthSummary(ls) ? ` · ${typeLengthSummary(ls)}` : ""}<Icon name="chev" size="sm" />
      </button>
      <button type="button" className="mbtn" aria-haspopup="menu" aria-label={`Sort: ${SORT_LABELS[ls.sort]}`} onClick={(e) => popups.menu(e.currentTarget, sortEntries(), "Sort items")}>
        <Icon name="sort" />{SORT_LABELS[ls.sort]}<Icon name="chev" size="sm" />
      </button>
      {bp !== "xs" ? <button type="button" className="mbtn" aria-pressed={sel.selecting} onClick={() => sel.setSelecting(!sel.selecting)}><Icon name="selectsq" />Select</button> : null}
      {menu().length ? <button type="button" className="ibtn" aria-haspopup="menu" aria-label={menuLabel} onClick={(e) => popups.menu(e.currentTarget, menu(), menuLabel)}><Icon name="more" /><span className="ml" aria-hidden="true">More</span></button> : null}
    </div>
  );
}
