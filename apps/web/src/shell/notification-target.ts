import type { Place, ListSearch } from "../nav.ts";

/**
 * Where a notification leads, from the bell or from a notification tapped on the phone: its item in its
 * source, the source, or the item on Home when the source is gone. Nothing (null) when it names neither.
 */
export function notificationPlace(t: { itemId: string | null; sourceId: string | null }, hasSource: (id: string) => boolean): { place: Place; search?: ListSearch } | null {
  const src = t.sourceId && hasSource(t.sourceId) ? t.sourceId : null;
  if (t.itemId && src) return { place: { t: "s", id: src }, search: { item: t.itemId } };
  if (src) return { place: { t: "s", id: src } };
  if (t.itemId) return { place: { t: "home" }, search: { item: t.itemId } };
  return null;
}
