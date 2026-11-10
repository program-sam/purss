/**
 * `purss://open` links: what a home-screen widget's tap (plan/38) and a tapped notification (plan/37) ask
 * the app to show. One reader for both, and navigation only: an item, a source, or Home. Anything else in
 * the link is ignored and ids that don't look like ids are dropped, so another app opening such a link
 * can't make the app do anything.
 */
export type OpenTarget = { itemId: string | null; sourceId: string | null };

const ID = /^[a-z]{1,8}_[0-9a-z]{26}$/;

/** Where a `purss://open` link leads, or null for any other address. Read by hand: some WebViews parse a custom scheme without a host. */
export function readOpenLink(url: string): OpenTarget | null {
  const m = /^purss:\/\/open\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(url.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? "");
  const id = (v: string | null) => (v && ID.test(v) ? v : null);
  return { itemId: id(q.get("item")), sourceId: id(q.get("source")) };
}
