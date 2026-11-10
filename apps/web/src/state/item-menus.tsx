import { appUrl } from "@purss/domain/paths";
import { appPathname } from "../nav.ts";
import { useCallback } from "react";
import type { ItemDTO } from "@purss/domain";
import { Icon } from "@purss/ui";
import type { MenuEntry } from "@purss/ui";
import { useCachedItem } from "../api/use-item.ts";
import { workflowLabel } from "../lib/constants.ts";
import { copyLinkEntries } from "../lib/copy-link.ts";
import { safeHref } from "../lib/items.ts";
import { platform } from "../platform/index.ts";
import { useItemActions } from "./actions.ts";
import { useOverlays } from "./overlays.tsx";
import { usePopups } from "./popups.tsx";
import { useToasts } from "./toasts.tsx";
import { useWorkspace } from "./workspace.tsx";

/** The baskets list shown from the bookmark button, a menu of checkable items. Stays open so several baskets can be ticked. */
function KeepList({ itemId, onClose }: { itemId: string; onClose: (restore?: boolean) => void }) {
  const ws = useWorkspace();
  const actions = useItemActions();
  const overlays = useOverlays();
  const item = useCachedItem(itemId);
  if (!item) return null;
  return (
    <>
      <div className="menu-h">Keep in</div>
      {ws.data.baskets.map((b) => {
        const on = item.basketIds.includes(b.id);
        return (
          <button key={b.id} type="button" className="mi" role="menuitemcheckbox" aria-checked={on} onClick={() => void actions.keep(itemId, b.id, !on)}>
            <span className="cb" aria-hidden="true"><Icon name="check" /></span><span className="nm" dir="auto">{b.name}</span><span className="n">{b.captureMode === "text" ? "saves text" : "saves link"}</span>
          </button>
        );
      })}
      {!ws.data.baskets.length ? <p className="fine" style={{ padding: "6px 10px" }}>No baskets yet. A basket keeps items you choose, even after their source drops them.</p> : null}
      <hr className="mhr" />
      <button type="button" className="mi" role="menuitem" onClick={() => { onClose(false); overlays.open({ kind: "basket-form", keepItemId: itemId }); }}><Icon name="plus" /><span className="nm">New basket…</span></button>
    </>
  );
}

/** Builds and opens the per-item menus (row actions, Keep, board "Move to"). */
export function useItemMenus() {
  const actions = useItemActions();
  const popups = usePopups();
  const overlays = useOverlays();
  const { toast } = useToasts();

  const copy = useCallback(async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); toast(message); } catch { toast("Couldn't copy the link."); }
  }, [toast]);
  /** "Copy link" (the original address) and "Copy link to this item in your PURSS". */
  const linkEntries = useCallback((item: ItemDTO): MenuEntry[] => copyLinkEntries(item, {
    workspaceLink: `${platform.publicOrigin()}${appUrl(appPathname())}?item=${encodeURIComponent(item.id)}`,
    copy: (text, message) => void copy(text, message),
  }), [copy]);

  const common = useCallback((item: ItemDTO, anchor: HTMLElement, basketId: string | null): MenuEntry[] => {
    const href = safeHref(item.url);
    return [
      { label: workflowLabel("toread", item.kind), disabled: item.workflow === "toread", hint: item.workflow === "toread" ? "Current" : undefined, onSelect: () => void actions.setWorkflow([item.id], "toread") },
      { label: "Mark finished", disabled: item.workflow === "finished", hint: item.workflow === "finished" ? "Current" : undefined, onSelect: () => void actions.setWorkflow([item.id], "finished") },
      // Ignoring is for what arrives; an item in a basket was saved on purpose, and Remove from basket takes it out.
      ...(basketId ? [] : [item.workflow === "ignored" ? { label: "Restore", onSelect: () => void actions.restore(item.id) } : { label: "Ignore", onSelect: () => void actions.setWorkflow([item.id], "ignored") }]),
      { type: "separator" },
      { label: "Keep in…", onSelect: () => setTimeout(() => popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" }), 0) },
      ...(basketId ? [{ label: "Remove from basket", onSelect: () => void actions.keep(item.id, basketId, false) } as MenuEntry] : []),
      { type: "separator" },
      ...(href ? [{ label: "Open original", icon: "ext" as const, onSelect: () => platform.openExternal(href) } as MenuEntry] : []),
      ...linkEntries(item),
      { type: "separator" },
      { label: "Delete permanently…", icon: "trash", onSelect: () => overlays.open({ kind: "delete-items", itemIds: [item.id] }) },
    ];
  }, [actions, popups, overlays, linkEntries]);

  const openRowMenu = useCallback((item: ItemDTO, anchor: HTMLElement, basketId: string | null) => {
    popups.menu(anchor, common(item, anchor, basketId), `Actions for ${item.title}`);
  }, [popups, common]);

  /** Board cards put "Move to" first: the keyboard and touch alternative to dragging. */
  const openBoardMenu = useCallback((item: ItemDTO, anchor: HTMLElement) => {
    const moves: MenuEntry[] = (["new", "toread", "inprogress", "finished"] as const).map((k) => ({
      type: "radio", label: workflowLabel(k, item.kind), on: item.workflow === k, onSelect: () => void actions.setWorkflow([item.id], k),
    }));
    const href = safeHref(item.url);
    popups.menu(anchor, [
      { type: "heading", label: "Move to" }, ...moves,
      item.workflow === "ignored" ? { label: "Restore", onSelect: () => void actions.restore(item.id) } : { label: "Ignore", onSelect: () => void actions.setWorkflow([item.id], "ignored") },
      { type: "separator" },
      { label: "Keep in…", onSelect: () => setTimeout(() => popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" }), 0) },
      ...(href ? [{ label: "Open original", icon: "ext" as const, onSelect: () => platform.openExternal(href) } as MenuEntry] : []),
      ...linkEntries(item),
      { type: "separator" },
      { label: "Delete permanently…", icon: "trash", onSelect: () => overlays.open({ kind: "delete-items", itemIds: [item.id] }) },
    ], `Move or act on ${item.title}`);
  }, [popups, actions, linkEntries, overlays]);

  const openKeep = useCallback((item: ItemDTO, anchor: HTMLElement) => {
    popups.panel(anchor, "Keep in a basket", (close) => <KeepList itemId={item.id} onClose={close} />, { role: "menu" });
  }, [popups]);

  return { openRowMenu, openBoardMenu, openKeep, linkEntries, itemEntries: common };
}
