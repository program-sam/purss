import type { MenuItem } from "./browser.ts";
import type { BasketRef } from "./store.ts";

/*
 * The right-click menu: "Keep page in ›" and "Keep link in ›", one entry per basket, or a way to
 * connect when the extension isn't connected yet.
 */

/** Long menus are hard to use; the popup offers every basket. */
const MAX_BASKETS = 12;

export function menuItems(connected: boolean, baskets: BasketRef[]): MenuItem[] {
  if (!connected) return [{ id: "connect", title: "Connect to your PURSS…", contexts: ["page", "link"] }];
  if (!baskets.length) return [{ id: "no-baskets", title: "Create a basket in your PURSS to keep pages", contexts: ["page", "link"], enabled: false }];
  const shown = baskets.slice(0, MAX_BASKETS);
  return [
    { id: "keep-page", title: "Keep page in", contexts: ["page"] },
    ...shown.map((b) => ({ id: `keep-page:${b.id}`, parentId: "keep-page", title: b.name, contexts: ["page"] })),
    { id: "keep-link", title: "Keep link in", contexts: ["link"] },
    ...shown.map((b) => ({ id: `keep-link:${b.id}`, parentId: "keep-link", title: b.name, contexts: ["link"] })),
  ];
}

export type MenuAction = { kind: "connect" } | { kind: "keep"; what: "page" | "link"; basketId: string };

export function menuAction(id: string | number): MenuAction | null {
  if (id === "connect") return { kind: "connect" };
  const m = /^keep-(page|link):(.+)$/.exec(String(id));
  return m ? { kind: "keep", what: m[1] as "page" | "link", basketId: m[2]! } : null;
}
