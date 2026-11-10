import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MenuEntry } from "@purss/ui";
import { messageOf, patch } from "../api/client.ts";
import { findItem, refreshWorkspace } from "../api/queries.ts";
import { workflowLabel } from "../lib/constants.ts";
import { canRetrySource } from "../lib/sources.ts";
import { retrySource } from "../state/source-actions.ts";
import { appPathname, placeOf, useNav } from "../nav.ts";
import { useItemMenus } from "../state/item-menus.tsx";
import { useItemActions } from "../state/actions.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { platform } from "../platform/index.ts";

/**
 * Right-click menus for items, sources, collections, baskets and empty space, built from the
 * same actions as the ⋯ menus. The browser's own menu stays for text fields, selected text and
 * links inside an article, and whenever Shift is held.
 */
export function ContextMenus() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const popups = usePopups();
  const overlays = useOverlays();
  const actions = useItemActions();
  const { itemEntries } = useItemMenus();
  const { toast } = useToasts();
  const anchorRef = useRef<HTMLElement | null>(null);

  // Everything the handler needs, current at the time of the click.
  const latest = useRef({ ws, qc, nav, popups, overlays, actions, itemEntries, toast });
  latest.current = { ws, qc, nav, popups, overlays, actions, itemEntries, toast };

  useEffect(() => {
    // One invisible element at the pointer; menus position themselves against it.
    const anchor = document.createElement("span");
    anchor.setAttribute("aria-hidden", "true");
    anchor.style.cssText = "position:fixed;width:1px;height:1px;pointer-events:none;";
    document.body.appendChild(anchor);
    anchorRef.current = anchor;

    function onContextMenu(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t || e.shiftKey) return;
      if (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .prose a, .prose img")) return;
      if (String(window.getSelection() ?? "").trim()) return;
      if (t.closest(".dlg, .pop, [role='menu']")) return;
      const entries = entriesFor(t);
      if (!entries) return;
      e.preventDefault();
      anchor.style.left = `${e.clientX}px`;
      anchor.style.top = `${e.clientY}px`;
      latest.current.popups.menu(anchor, entries.items, entries.label);
    }

    function entriesFor(t: HTMLElement): { items: MenuEntry[]; label: string } | null {
      const { ws, qc, nav, overlays, actions, itemEntries, toast } = latest.current;
      const itemEl = t.closest<HTMLElement>("[data-item]");
      if (itemEl) {
        const item = findItem(qc, itemEl.dataset.item!);
        if (!item) return null;
        const place = placeOf(appPathname());
        const basketId = place && place.t === "b" ? place.id : null;
        const states = (["new", "toread", "inprogress", "finished"] as const).map<MenuEntry>((k) => ({
          type: "radio", label: workflowLabel(k, item.kind), on: item.workflow === k,
          onSelect: () => void actions.setWorkflow([item.id], k),
        }));
        const rest = itemEntries(item, anchor, basketId).filter((x) => !("label" in x) || !["To read", "To watch", "To listen", "Mark finished"].includes(String(x.label)));
        return {
          label: `Actions for ${item.title}`,
          items: [{ label: "Open", onSelect: () => nav.openItem(item.id) }, { type: "separator" }, { type: "heading", label: "State" }, ...states, ...rest],
        };
      }
      const sourceEl = t.closest<HTMLElement>("[data-source]");
      if (sourceEl) {
        const s = ws.sourceById.get(sourceEl.dataset.source!);
        if (!s) return null;
        const set = async (body: Record<string, unknown>, done: string) => {
          try { await patch(`/api/sources/${encodeURIComponent(s.id)}`, body); refreshWorkspace(qc, { items: false }); toast(done); } catch (err) { toast(messageOf(err), { tone: "error" }); }
        };
        return {
          label: `Actions for ${s.title}`,
          items: [
            { label: "Open", onSelect: () => nav.go({ t: "s", id: s.id }) },
            { type: "separator" },
            { label: "Rename…", onSelect: () => overlays.open({ kind: "rename-source", id: s.id }) },
            { label: "Change collections…", onSelect: () => overlays.open({ kind: "move-source", id: s.id }) },
            { label: "Smart filter…", onSelect: () => overlays.open({ kind: "ai-filter", sourceId: s.id }) },
            ...(canRetrySource(s) ? [{ label: "Try again", onSelect: () => void retrySource(qc, toast, s.id, s.title) } as MenuEntry] : []),
            s.paused ? { label: "Resume collecting", onSelect: () => void set({ paused: false }, `Resumed ${s.title}`) } : { label: "Pause collecting", onSelect: () => void set({ paused: true }, `Paused ${s.title}`) },
            s.notify === "muted" ? { label: "Unmute notifications", onSelect: () => void set({ notify: "default" }, `Notifications on for ${s.title}`) } : { label: "Mute notifications", onSelect: () => void set({ notify: "muted" }, `Muted ${s.title}`) },
            ...(s.fullTextAvailable ? [s.fullText
              ? { label: "Stop fetching full articles", onSelect: () => void set({ fullText: false }, `Stopped fetching full articles for ${s.title}`) }
              : { label: "Fetch full articles", onSelect: () => void set({ fullText: true }, `Fetching full articles for ${s.title}`) } as MenuEntry] : []),
            ...(s.siteUrl ? [{ label: "Open website", icon: "ext" as const, onSelect: () => platform.openExternal(s.siteUrl!) } as MenuEntry] : []),
            { type: "separator" },
            { label: "Unfollow…", icon: "trash", onSelect: () => overlays.open({ kind: "unfollow", id: s.id }) },
          ],
        };
      }
      const colEl = t.closest<HTMLElement>("[data-collection]");
      if (colEl) {
        const c = ws.collectionById.get(colEl.dataset.collection!);
        if (!c) return null;
        return {
          label: `Actions for ${c.name}`,
          items: [
            { label: "Open", onSelect: () => nav.go({ t: "c", id: c.id }) },
            ...(c.mode === "sources" ? [{ label: "Add a source here…", icon: "plus" as const, onSelect: () => overlays.open({ kind: "add-source", collectionId: c.id }) } as MenuEntry] : []),
            { type: "separator" },
            { label: "Collection settings…", onSelect: () => overlays.open({ kind: "collection-settings", id: c.id }) },
            ...(c.mode === "sources" ? [{ label: "Smart filter…", onSelect: () => overlays.open({ kind: "ai-filter", collectionId: c.id }) } as MenuEntry] : []),
            { label: c.showOnHome ? "Hide from Home" : "Show on Home", onSelect: () => void patch(`/api/collections/${encodeURIComponent(c.id)}`, { showOnHome: !c.showOnHome }).then(() => refreshWorkspace(qc, { items: false }), (err) => toast(messageOf(err), { tone: "error" })) },
            { label: "Mark all as seen", onSelect: () => void actions.clearFresh(`collection:${c.id}`) },
          ],
        };
      }
      const basketEl = t.closest<HTMLElement>("[data-basket]");
      if (basketEl) {
        const b = ws.data.baskets.find((x) => x.id === basketEl.dataset.basket);
        if (!b) return null;
        return {
          label: `Actions for ${b.name}`,
          items: [
            { label: "Open", onSelect: () => nav.go({ t: "b", id: b.id }) },
            { type: "separator" },
            { label: "Basket settings…", onSelect: () => overlays.open({ kind: "basket-form", id: b.id }) },
            { label: "Delete basket…", icon: "trash", onSelect: () => overlays.open({ kind: "basket-delete", id: b.id }) },
          ],
        };
      }
      // Empty space inside PURSS: the common "new" actions.
      if (!t.closest(".app")) return null;
      return {
        label: "PURSS",
        items: [
          { label: "Add source…", icon: "plus", onSelect: () => overlays.open({ kind: "add-source" }) },
          { label: "New collection…", onSelect: () => overlays.open({ kind: "new-collection" }) },
          { label: "New basket…", onSelect: () => overlays.open({ kind: "basket-form" }) },
          { type: "separator" },
          { label: "Search…", icon: "search", onSelect: () => overlays.open({ kind: "palette" }) },
        ],
      };
    }

    document.addEventListener("contextmenu", onContextMenu);
    return () => { document.removeEventListener("contextmenu", onContextMenu); anchor.remove(); };
  }, []);

  return null;
}
