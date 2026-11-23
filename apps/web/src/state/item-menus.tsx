import { app } from "@purss/translations/app";
import { itemPath } from "@purss/domain/paths";
import { useCallback } from "react";
import type { ItemDTO } from "@purss/domain";
import { Icon } from "@purss/ui";
import type { MenuEntry } from "@purss/ui";
import { useCachedItem } from "../api/use-item.ts";
import { workflowLabel } from "../lib/constants.ts";
import { copyLinkEntries } from "../lib/copy-link.ts";
import { originalLink } from "../lib/items.ts";
import { platform } from "../platform/index.ts";
import { useItemActions } from "./actions.ts";
import { useOverlays } from "./overlays.tsx";
import { usePopups } from "./popups.tsx";
import { useToasts } from "./toasts.tsx";
import { usePurss } from "./purss.tsx";

const t = app.state.itemMenus;

/** The baskets list shown from the bookmark button, a menu of checkable items. Stays open so several baskets can be ticked. */
function KeepList({ itemId, onClose }: { itemId: string; onClose: (restore?: boolean) => void }) {
  const ws = usePurss();
  const actions = useItemActions();
  const overlays = useOverlays();
  const item = useCachedItem(itemId);
  if (!item) return null;
  return (
    <>
      <div className="menu-h">{t.keepIn}</div>
      {ws.data.baskets.map((b) => {
        const on = item.basketIds.includes(b.id);
        return (
          <button key={b.id} type="button" className="mi" role="menuitemcheckbox" aria-checked={on} onClick={() => void actions.keep(itemId, b.id, !on)}>
            <span className="cb" aria-hidden="true"><Icon name="check" /></span><span className="nm" dir="auto">{b.name}</span><span className="n">{b.captureMode === "text" ? t.savesText : t.savesLink}</span>
          </button>
        );
      })}
      {!ws.data.baskets.length ? <p className="fine" style={{ padding: "6px 10px" }}>{t.noBaskets}</p> : null}
      <hr className="mhr" />
      <button type="button" className="mi" role="menuitem" onClick={() => { onClose(true); overlays.open({ kind: "basket-form", keepItemId: itemId }); }}><Icon name="plus" /><span className="nm">{app.words.newBasketMenu}</span></button>
    </>
  );
}

/** Builds and opens the per-item menus (row actions, Keep, board "Move to"). */
export function useItemMenus() {
  const actions = useItemActions();
  const popups = usePopups();
  const overlays = useOverlays();
  const { toast } = useToasts();
  const { sourceById } = usePurss();

  const copy = useCallback(async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); toast(message); } catch { toast(t.couldntCopy); }
  }, [toast]);
  /** "Copy link to the original" and "Copy your private link to this item". */
  const linkEntries = useCallback((item: ItemDTO): MenuEntry[] => copyLinkEntries(item, {
    purssLink: `${platform.publicOrigin()}${itemPath(item.number)}`,
    copy: (text, message) => void copy(text, message),
  }), [copy]);

  /** "Open original": the item's own page, or its show's website when its link is only the audio or video file; nothing when there is neither. */
  const originalEntries = useCallback((item: ItemDTO): MenuEntry[] => {
    const original = originalLink(item, item.sourceId ? sourceById.get(item.sourceId) : null);
    return original ? [{ label: original.of === "show" ? app.words.openTheShowSWebsite : app.words.openOriginal, icon: "ext", onSelect: () => platform.openExternal(original.href) }] : [];
  }, [sourceById]);

  const common = useCallback((item: ItemDTO, anchor: HTMLElement, basketId: string | null): MenuEntry[] => {
    return [
      { label: workflowLabel("toread", item.kind), disabled: item.workflow === "toread", hint: item.workflow === "toread" ? app.words.current : undefined, onSelect: () => void actions.setWorkflow([item.id], "toread") },
      { label: t.mark(workflowLabel("finished", item.kind)), disabled: item.workflow === "finished", hint: item.workflow === "finished" ? app.words.current : undefined, onSelect: () => void actions.setWorkflow([item.id], "finished") },
      // Ignoring is for what arrives; an item in a basket was saved on purpose, and Remove from basket takes it out.
      ...(basketId ? [] : [item.workflow === "ignored" ? { label: app.words.restore, onSelect: () => void actions.restore(item.id) } : { label: app.words.ignore, onSelect: () => void actions.setWorkflow([item.id], "ignored") }]),
      { type: "separator" },
      { label: app.words.keepIn, onSelect: () => setTimeout(() => popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" }), 0) },
      ...(basketId ? [{ label: t.removeFromBasket, onSelect: () => void actions.keep(item.id, basketId, false) } as MenuEntry] : []),
      { type: "separator" },
      ...originalEntries(item),
      ...linkEntries(item),
      { type: "separator" },
      { label: t.deletePermanently, icon: "trash", onSelect: () => overlays.open({ kind: "delete-items", itemIds: [item.id] }) },
    ];
  }, [actions, popups, overlays, linkEntries, originalEntries]);

  const openRowMenu = useCallback((item: ItemDTO, anchor: HTMLElement, basketId: string | null) => {
    popups.menu(anchor, common(item, anchor, basketId), `Actions for ${item.title}`);
  }, [popups, common]);

  /** Board cards put "Move to" first: the keyboard and touch alternative to dragging. */
  const openBoardMenu = useCallback((item: ItemDTO, anchor: HTMLElement) => {
    const moves: MenuEntry[] = (["new", "toread", "inprogress", "finished"] as const).map((k) => ({
      type: "radio", label: workflowLabel(k, item.kind), on: item.workflow === k, onSelect: () => void actions.setWorkflow([item.id], k),
    }));
    popups.menu(anchor, [
      { type: "heading", label: t.moveTo }, ...moves,
      item.workflow === "ignored" ? { label: app.words.restore, onSelect: () => void actions.restore(item.id) } : { label: app.words.ignore, onSelect: () => void actions.setWorkflow([item.id], "ignored") },
      { type: "separator" },
      { label: app.words.keepIn, onSelect: () => setTimeout(() => popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" }), 0) },
      ...originalEntries(item),
      ...linkEntries(item),
      { type: "separator" },
      { label: t.deletePermanently, icon: "trash", onSelect: () => overlays.open({ kind: "delete-items", itemIds: [item.id] }) },
    ], `Move or act on ${item.title}`);
  }, [popups, actions, linkEntries, originalEntries, overlays]);

  const openKeep = useCallback((item: ItemDTO, anchor: HTMLElement) => {
    popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" });
  }, [popups]);

  return { openRowMenu, openBoardMenu, openKeep, linkEntries, itemEntries: common };
}
