import { isWidgetList } from "../device/widget.ts";

/**
 * `purss://open` links: what a home-screen panel's tap (plan/38) and a tapped notification (plan/37) ask
 * the app to show. One reader for both, and navigation only: an item, a source, a panel's list, or Home.
 * Anything else in the link is ignored and ids or lists that don't look like them are dropped, so another
 * app opening such a link can't make the app do anything.
 */
export type OpenTarget = { itemId: string | null; sourceId: string | null; list: string | null };

const ID = /^[a-z]{1,8}_[0-9a-z]{26}$/;

/** Where a `purss://open` link leads, or null for any other address. Read by hand: some WebViews parse a custom scheme without a host. */
export function readOpenLink(url: string): OpenTarget | null {
  const m = /^purss:\/\/open\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(url.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? "");
  const id = (v: string | null) => (v && ID.test(v) ? v : null);
  const list = q.get("list");
  return { itemId: id(q.get("item")), sourceId: id(q.get("source")), list: isWidgetList(list) ? list : null };
}
