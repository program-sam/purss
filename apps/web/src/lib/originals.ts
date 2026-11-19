import { queryOptions } from "@tanstack/react-query";
import { get } from "../api/client.ts";

/*
 * Pages from other sites in the reader. In a browser the reader frames a page only when its own headers allow
 * PURSS to (the server reads them: /api/frame-check); otherwise it opens in a new tab as before. The desktop app shows
 * any page in its own web view, which is drawn over the page: `placeWebView` keeps it clear of PURSS's menus, dialogs
 * and messages.
 */

/** The server's answer: frame `url` (where the page's redirects end), or don't. */
export type FrameCheck = { frame: true; url: string } | { frame: false };

export const frameCheckQuery = (url: string) => queryOptions({
  queryKey: ["frame-check", url] as const,
  queryFn: ({ signal }) => get<FrameCheck>("/api/frame-check", { url }, signal),
  staleTime: 6 * 60 * 60 * 1000,
  gcTime: 6 * 60 * 60 * 1000,
  retry: false,
});

export type Box = { x: number; y: number; width: number; height: number };

/** Below this height the web view isn't worth showing; it waits until the place is free again. */
const MIN_HEIGHT = 120;

/**
 * Where the web view goes in `pane` with these of PURSS's elements on screen: something low in the pane (a message at the
 * bottom) shortens it to end above that; anything else over it (a menu, a dialog) hides it (null) until it closes.
 */
export function placeWebView(pane: Box, covers: Box[]): Box | null {
  let bottom = pane.y + pane.height;
  for (const c of covers) {
    const overlaps = c.width > 0 && c.height > 0 && c.x < pane.x + pane.width && c.x + c.width > pane.x && c.y < bottom && c.y + c.height > pane.y;
    if (!overlaps) continue;
    if (c.y >= pane.y + pane.height / 2) bottom = Math.min(bottom, c.y - 6);
    else return null;
  }
  const height = bottom - pane.y;
  return height >= MIN_HEIGHT && pane.width >= 1 ? { x: pane.x, y: pane.y, width: pane.width, height } : null;
}

/** What may lie over the web view: popups, dialogs, messages. Elements inside `own` (the pane itself) don't count. */
const COVERS = "[role=menu],[role=dialog],[role=alertdialog],[role=listbox],dialog[open],.pop,.dlg-scrim,.toast";

export function coversOver(own: Element): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll(COVERS)) {
    if (own.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
}

/** The address as the pane shows it: the site, then the rest of the address. */
export function addressParts(url: string): { site: string; rest: string; secure: boolean } {
  try {
    const u = new URL(url);
    return { site: u.host.replace(/^www\./, ""), rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}`, secure: u.protocol === "https:" };
  } catch {
    return { site: url, rest: "", secure: false };
  }
}
