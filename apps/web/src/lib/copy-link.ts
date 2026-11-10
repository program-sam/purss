import type { ItemDTO } from "@purss/domain";
import type { MenuEntry } from "@purss/ui";
import { safeHref } from "./items.ts";

/**
 * The two ways to copy a link to an item, as menu entries. "Copy link" is the original page's address (the one to send to
 * someone), only when the item has one; "Copy link to this item in your PURSS" opens the item here, for the person who
 * is signed in.
 */
export function copyLinkEntries(item: Pick<ItemDTO, "url">, o: { workspaceLink: string; copy: (text: string, message: string) => void }): MenuEntry[] {
  const original = safeHref(item.url);
  return [
    ...(original ? [{ label: "Copy link", icon: "copy" as const, onSelect: () => o.copy(original, "Link copied") }] : []),
    { label: "Copy link to this item in your PURSS", icon: "copy" as const, onSelect: () => o.copy(o.workspaceLink, "Link to this item in your PURSS copied. Only you can open it.") },
  ];
}
