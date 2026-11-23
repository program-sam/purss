import { app } from "@purss/translations/app";
import type { ItemDTO } from "@purss/domain";
import type { MenuEntry } from "@purss/ui";
import { originalLink } from "./items.ts";

/**
 * The two ways to copy a link to an item, as menu entries. "Copy link to the original" is the original page's address (the one to send to
 * someone), only when the item has one: an episode whose link is only its audio file has no page to copy; "Copy your private
 * link to this item" opens the item here, for the person who is signed in.
 */
export function copyLinkEntries(item: Pick<ItemDTO, "url" | "media" | "linkIsMedia">, o: { purssLink: string; copy: (text: string, message: string) => void }): MenuEntry[] {
  const original = originalLink(item)?.href ?? null;
  const t = app.lib.copyLink;
  return [
    ...(original ? [{ label: t.original, icon: "copy" as const, onSelect: () => o.copy(original, t.originalCopied) }] : []),
    { label: t.private, icon: "copy" as const, onSelect: () => o.copy(o.purssLink, t.privateCopied) },
  ];
}
