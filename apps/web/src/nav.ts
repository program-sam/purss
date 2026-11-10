import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ListFilter } from "./lib/constants.ts";
import type { Sort, ViewMode } from "@purss/domain";
import { withinApp } from "./app-base.ts";

/** A place inside PURSS. */
/** "r" is the reading list (/r/toread): every To read item, across collections. */
export type Place = { t: "home" } | { t: "c" | "s" | "b" | "r"; id: string };

/** `dialog` with `url`, `title` or `q` are deep links: the shell opens the popup they name and removes them from the address. */
export type ListSearch = {
  item?: string; view?: ViewMode; filter?: ListFilter; sort?: Sort; source?: string; dialog?: string; url?: string; title?: string; q?: string;
  /** A source left out of the list, the item types and length it is limited to, and whether items that match muted words show. */
  without?: string; type?: string; length?: "short" | "long"; muted?: "show";
  /** Only items whose text could not be saved (opened from a "Couldn't save the text" notification). */
  capture?: "failed";
};

export function pathFor(p: Place): string {
  return p.t === "home" ? "/" : `/${p.t}/${encodeURIComponent(p.id)}`;
}

/** The page's path inside the app, without the build's base (/app on a PURSS). */
export function appPathname(): string {
  return withinApp(location.pathname);
}

export function placeOf(path: string): Place | null {
  if (path === "/") return { t: "home" };
  const m = /^\/(c|s|b|r)\/([^/]+)$/.exec(path);
  return m ? { t: m[1] as "c" | "s" | "b" | "r", id: decodeURIComponent(m[2]!) } : null;
}

/** The source or collection a statistics page is about, from its address. */
export type StatsPlace = { t: "c" | "s"; id: string };

export function statsPathFor(p: StatsPlace): string {
  return `${pathFor(p)}/stats`;
}

export function statsPlaceOf(path: string): StatsPlace | null {
  const m = /^\/(c|s)\/([^/]+)\/stats$/.exec(path);
  return m ? { t: m[1] as "c" | "s", id: decodeURIComponent(m[2]!) } : null;
}

/**
 * Navigation in one place. The URL is the source of truth: the open item, view, filter and sort
 * are search parameters, so every state can be bookmarked and the back button behaves.
 */
export function useNav() {
  const navigate = useNavigate();
  // The route tree is code-based and not registered for static route typing, so paths are plain strings here.
  const nav = navigate as unknown as (opts: { to: string; search?: unknown; replace?: boolean; resetScroll?: boolean }) => Promise<void>;

  const go = useCallback((place: Place, search?: ListSearch) => {
    void nav({ to: pathFor(place), search: search ?? {} });
  }, [nav]);

  const goPath = useCallback((to: string, search?: Record<string, unknown>) => { void nav({ to, search: search ?? {} }); }, [nav]);

  /** Merge into the current page's search parameters. */
  const patchSearch = useCallback((patch: Partial<ListSearch>, replace = true) => {
    void nav({ to: ".", search: (prev: Record<string, unknown>) => cleaned({ ...prev, ...patch }), replace, resetScroll: false } as never);
  }, [nav]);

  const openItem = useCallback((id: string | undefined) => patchSearch({ item: id }, true), [patchSearch]);

  return useMemo(() => ({ go, goPath, patchSearch, openItem }), [go, goPath, patchSearch, openItem]);
}

function cleaned(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}
