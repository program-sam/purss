import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import type { BasketDTO, ItemDTO } from "@purss/domain";
import { useNav } from "../nav.ts";
import type { ListSearch } from "../nav.ts";
import { leaveThen, leavesOn } from "../lib/leave.ts";
import { useNow } from "../lib/use-now.ts";
import { useItemActions } from "../state/actions.ts";
import { useItemMenus } from "../state/item-menus.tsx";
import { useQuickDownload } from "../player/quick-download.ts";
import { useSelection } from "../state/selection.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import type { RowCtx, RowMarks } from "./row-context.tsx";

function createMarks(active: string | undefined, selected: ReadonlySet<string>) {
  const listeners = new Set<() => void>();
  const state = { active, selected };
  const marks: RowMarks = {
    active: () => state.active,
    selected: () => state.selected,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const set = (a: string | undefined, s: ReadonlySet<string>) => {
    if (a === state.active && s === state.selected) return;
    state.active = a;
    state.selected = s;
    listeners.forEach((fn) => fn());
  };
  return { marks, set };
}

/**
 * Everything a page's rows need: which item is open, selection, menus and actions. `keeps` is the page's rule for
 * which items its list shows, so a change that takes an item out slides its row away first.
 */
export function useRowContextValue(basket: BasketDTO | null, keeps: (item: ItemDTO) => boolean): RowCtx {
  const nav = useNav();
  const ws = useWorkspace();
  const sel = useSelection();
  const actions = useItemActions();
  const menus = useItemMenus();
  const search = useSearch({ strict: false }) as ListSearch;
  const now = useNow();
  const download = useQuickDownload();
  const basketId = basket?.id ?? null;
  // Rows only show the basket's name; a new count for it shouldn't re-render them.
  const basketName = basket?.name;
  const rowBasket = useMemo(() => basket, [basketId, basketName]); // eslint-disable-line react-hooks/exhaustive-deps

  const [store] = useState(() => createMarks(search.item, sel.selected));
  useLayoutEffect(() => store.set(search.item, sel.selected), [store, search.item, sel.selected]);

  // The actions read the latest hooks through a ref, so they keep their identity and memoised rows stay put.
  const latest = useRef({ nav, sel, actions, menus, download, basketId });
  useLayoutEffect(() => { latest.current = { nav, sel, actions, menus, download, basketId }; });
  const handlers = useMemo(() => {
    const l = () => latest.current;
    return {
      onOpen: (item: ItemDTO) => { const { sel: s, nav: n } = l(); if (s.selecting) s.toggle(item.id); else n.patchSearch({ item: item.id }, false); },
      onMore: (item: ItemDTO, anchor: HTMLElement) => l().menus.openRowMenu(item, anchor, l().basketId),
      onBoardMore: (item: ItemDTO, anchor: HTMLElement) => l().menus.openBoardMenu(item, anchor),
      onKeep: (item: ItemDTO, anchor: HTMLElement) => l().menus.openKeep(item, anchor),
      onWorkflow: (item: ItemDTO, workflow: ItemDTO["workflow"]) => void leaveThen([item.id], workflow, () => l().actions.setWorkflow([item.id], workflow)),
      onDownload: (item: ItemDTO) => l().download(item),
      onRestore: (item: ItemDTO) => void leaveThen([item.id], "restore", () => l().actions.restore(item.id)),
      onRemove: (item: ItemDTO) => { const { basketId: b, actions: a } = l(); if (b) void leaveThen([item.id], "unkeep", () => a.keep(item.id, b, false)); },
    };
  }, []);
  // Rows show which changes take them out of the list, so this follows the page's filter and basket.
  const inBasket = basketId !== null;
  const leaves = useCallback((item: ItemDTO) => leavesOn(item, keeps, inBasket), [keeps, inBasket]);

  return useMemo<RowCtx>(() => ({
    marks: store.marks,
    selecting: sel.selecting,
    basket: rowBasket,
    timeZone: ws.prefs.timezone,
    now,
    ...handlers,
    leaves,
  }), [store, sel.selecting, rowBasket, ws.prefs.timezone, now, handlers, leaves]);
}
