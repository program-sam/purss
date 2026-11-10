import { ContextMenus } from "./ContextMenu.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Outlet, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, TipLayer, useBreakpoint } from "@purss/ui";
import { messageOf } from "../api/client.ts";
import { bootstrapQuery, findItem } from "../api/queries.ts";
import { useCachedItem } from "../api/use-item.ts";
import { focusPageHeading } from "../lib/page-focus.ts";
import { TO_READ_TITLE } from "../lib/constants.ts";
import { Header } from "./Header.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { TabBar } from "./TabBar.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useBrowserNotifications } from "./BrowserNotifier.ts";
import { useCurrentPlace, usePathname } from "./place.ts";
import { OverlayHost } from "../dialogs/OverlayHost.tsx";
import { actionForKey, isTypingTarget, stepIndex } from "../lib/keys.ts";
import { deepLinkOverlay } from "../lib/deep-links.ts";
import { statsPlaceOf, useNav } from "../nav.ts";
import type { ListSearch } from "../nav.ts";
import { pageFor } from "../plugins.ts";
import { useItemActions } from "../state/actions.ts";
import { useLiveUpdates } from "../state/live.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { PopupProvider } from "../state/popups.tsx";
import { useApplyAppearance, useSavePreferences } from "../state/prefs.ts";
import { PageNav } from "../components/PageNav.tsx";
import { useDisplayMode } from "../lib/display.ts";
import { SelectionProvider, useSelection } from "../state/selection.tsx";
import { setHints, useHints } from "../state/ui-store.ts";
import { WorkspaceProvider, useWorkspace } from "../state/workspace.tsx";
import { PlayerProvider, usePlayer } from "../player/PlayerProvider.tsx";
import { DeviceRunner } from "../device/DeviceRunner.tsx";
import { PlayerBar, focusPlayer } from "../player/PlayerBar.tsx";
import { DownloadsRunner } from "../downloads/DownloadsRunner.tsx";
import { ShareIntake } from "../share/ShareIntake.tsx";
import { platform } from "../platform/index.ts";
import { OpenLinks } from "./OpenLinks.tsx";
import { SetupBanner } from "../auth/SetupBanner.tsx";
import { leaveThen } from "../lib/leave.ts";


function Splash({ children }: { children: ReactNode }) {
  return <div className="splash" role="status">{children}</div>;
}

/** The signed-in frame: sidebar, header, main, item panel and the popups. */
export function Shell() {
  const q = useQuery(bootstrapQuery);
  if (q.isPending) return <Splash><span className="spin" aria-hidden="true" />Loading your PURSS…</Splash>;
  if (q.isError || !q.data) {
    return (
      <Splash>
        <div className="empty card-like" style={{ maxWidth: 440 }}>
          <h2>Couldn't load your PURSS</h2>
          <p>{messageOf(q.error)}</p>
          <Button variant="primary" onClick={() => void q.refetch()}>Try again</Button>
        </div>
      </Splash>
    );
  }
  return (
    <WorkspaceProvider data={q.data}>
      <SelectionProvider>
        <PopupProvider>
          <PlayerProvider>
            <ShellFrame />
          </PlayerProvider>
        </PopupProvider>
      </SelectionProvider>
    </WorkspaceProvider>
  );
}

function ShellFrame() {
  const ws = useWorkspace();
  const nav = useNav();
  const qc = useQueryClient();
  const bp = useBreakpoint();
  const hints = useHints();
  const place = useCurrentPlace();
  const pathname = usePathname();
  const overlays = useOverlays();
  const popups = usePopups();
  const sel = useSelection();
  const actions = useItemActions();
  const search = useSearch({ strict: false }) as ListSearch;
  const itemId = search.item;
  const [drawer, setDrawer] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const playerOpen = !!usePlayer().snap.now;
  const display = useDisplayMode();

  useApplyAppearance(ws.prefs);
  // An account that has no time zone yet takes this device's, once; Settings can change it later.
  const savePrefs = useSavePreferences();
  const zoneUnset = ws.data.preferences.timezone === null;
  useEffect(() => { if (zoneUnset) void savePrefs({ timezone: ws.prefs.timezone }); }, [zoneUnset]); // eslint-disable-line react-hooks/exhaustive-deps
  const onNotification = useBrowserNotifications();
  // The bell's unread count on the desktop app's icon (plan/42); none while notifications are off, as on the bell.
  const unread = ws.prefs.notifications.frequency === "off" ? 0 : ws.data.unreadNotifications;
  useEffect(() => { platform.badge?.(unread); }, [unread]);
  useLiveUpdates(onNotification);

  const overlaySb = bp === "sm" || bp === "xs";
  // A laptop with the reader docked: the sidebar steps back to its rail while the item is open, so the
  // list keeps room for its titles and toolbar. Expanding it again holds until the reader closes.
  const [splitFull, setSplitFull] = useState(false);
  const narrowLaptop = useNarrowLaptop();
  const splitRail = bp === "lg" && narrowLaptop && !!itemId && !splitFull;
  useEffect(() => { if (!itemId) setSplitFull(false); }, [itemId]);
  const sbMode: "full" | "rail" | "drawer" = overlaySb ? "drawer" : splitRail ? "rail" : hints.sidebar ?? (bp === "md" ? "rail" : "full");

  // A new page starts clean: no selection, drawer closed, scrolled to the top.
  useEffect(() => { sel.setSelecting(false); setDrawer(false); mainRef.current?.scrollTo({ top: 0 }); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!overlaySb) setDrawer(false); }, [overlaySb]);

  // Deep links such as ?dialog=settings open the popup, then tidy the address. The browser extension and
  // the bookmarklets hand a page over with ?dialog=add&url=… (Add source, filled in: nothing is looked up
  // until the person presses Find) and ?dialog=keep&url=…&title=… (Keep this page, after confirming).
  useEffect(() => {
    if (!search.dialog) return;
    const o = deepLinkOverlay(search);
    if (o) overlays.open(o);
    nav.patchSearch({ dialog: undefined, url: undefined, title: undefined, q: undefined });
  }, [search.dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page title: the open item first, then the page it sits on.
  const openItemTitle = useCachedItem(itemId)?.title;
  useEffect(() => {
    let name = "Home";
    if (place?.t === "c") name = ws.collectionById.get(place.id)?.name ?? "Collection";
    else if (place?.t === "s") name = ws.sourceById.get(place.id)?.title ?? "Source";
    else if (place?.t === "b") name = ws.basketById.get(place.id)?.name ?? "Basket";
    else if (place?.t === "r") name = TO_READ_TITLE;
    else if (!place) {
      const sp = statsPlaceOf(pathname);
      if (sp) name = `Statistics · ${sp.t === "c" ? ws.collectionById.get(sp.id)?.name ?? "Collection" : ws.sourceById.get(sp.id)?.title ?? "Source"}`;
      else name = pageFor(pathname)?.title ?? "Home";
    }
    document.title = `${openItemTitle ? `${openItemTitle} · ` : ""}${name} · PURSS`;
  }, [place, pathname, ws, openItemTitle]);

  // Going to another page puts focus on its heading, so it is announced and the next Tab starts inside the page. The
  // first page of a visit gets the same when the person arrived by signing in or signing up (not on a plain page load).
  const pageFocused = useRef<string | null>(null);
  useEffect(() => {
    const first = pageFocused.current === null;
    pageFocused.current = pathname;
    if (first && !arrivedInApp()) return;
    if (!itemId) return focusPageHeading(mainRef.current);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus: the panel moves focus to its heading when an item opens (see ItemPanel). When it closes, focus goes back
  // to the row that opened it, unless the person has already moved on to something else.
  const prevItem = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = prevItem.current;
    prevItem.current = itemId;
    if (itemId || !was) return;
    const now = document.activeElement;
    const lost = !now || now === document.body || !!now.closest(".panel");
    if (!lost) return;
    const row = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(was)}"] [data-act="open"], [data-item="${CSS.escape(was)}"][data-act="open"]`);
    (row ?? mainRef.current)?.focus({ preventScroll: true });
  }, [itemId]);

  const closeItem = useCallback(() => nav.openItem(undefined), [nav]);

  // Keyboard shortcuts (never plain arrow keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const layerOpen = !!overlays.overlay || !!popups.anchor;
      if (e.key === "Escape" && !layerOpen) {
        if (sel.selecting) { sel.setSelecting(false); e.preventDefault(); }
        else if (itemId) { closeItem(); e.preventDefault(); }
        else if (drawer) { setDrawer(false); e.preventDefault(); }
        return;
      }
      const action = actionForKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey }, { typing: isTypingTarget(e.target), layerOpen });
      if (!action) return;
      const current = () => {
        const a = document.activeElement as HTMLElement | null;
        return a?.closest<HTMLElement>("[data-item]")?.dataset.item ?? itemId;
      };
      switch (action) {
        case "palette": case "search": e.preventDefault(); overlays.open({ kind: "palette" }); break;
        case "help": e.preventDefault(); overlays.open({ kind: "shortcuts" }); break;
        case "player": if (focusPlayer()) e.preventDefault(); break;
        case "next": case "prev": {
          const rows = [...(mainRef.current?.querySelectorAll<HTMLElement>("[data-act='open']") ?? [])];
          if (!rows.length) return;
          const i = rows.indexOf(document.activeElement as HTMLElement);
          const n = rows[stepIndex(i, rows.length, action === "next" ? 1 : -1)];
          e.preventDefault(); n?.focus(); n?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "open": {
          if (e.key === "Enter") return; // Enter already activates the focused button
          const id = current();
          if (id) { e.preventDefault(); if (sel.selecting) sel.toggle(id); else nav.patchSearch({ item: id }, false); }
          break;
        }
        case "finished": case "toread": case "ignore": {
          const id = current();
          const it = id ? findItem(qc, id) : undefined;
          // A basket has no Ignore: what is in it was saved on purpose.
          if (!id || !it || (action === "ignore" && place?.t === "b")) return;
          e.preventDefault();
          if (action === "ignore") void (it.workflow === "ignored" ? leaveThen([id], "restore", () => actions.restore(id)) : leaveThen([id], "ignored", () => actions.setWorkflow([id], "ignored")));
          else { const to = action === "finished" ? "finished" : "toread"; void leaveThen([id], to, () => actions.setWorkflow([id], to)); }
          break;
        }
        case "select": {
          const id = current();
          if (!id) return;
          e.preventDefault();
          if (!sel.selecting) { sel.setSelecting(true); sel.toggle(id); } else sel.toggle(id);
          break;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlays, popups.anchor, sel, itemId, drawer, closeItem, nav, qc, actions, place]);

  const toggleSidebar = () => {
    if (overlaySb) { setDrawer((d) => !d); if (!drawer) requestAnimationFrame(() => document.querySelector<HTMLElement>("#side [data-fk='add']")?.focus()); }
    else if (bp === "lg" && narrowLaptop && itemId) setSplitFull(sbMode === "rail");
    else setHints({ sidebar: sbMode === "full" ? "rail" : "full" });
  };

  // Resizable panel.
  // While dragging, the panel's width is set straight on it once a frame; the width is saved when the drag ends.
  const dragRef = useRef<{ x: number; w: number; next: number | null; frame: number } | null>(null);
  const panelWidthNow = () => hints.readerWidth ?? document.querySelector<HTMLElement>(".panel")?.offsetWidth ?? 400;
  const clampW = (w: number) => Math.round(Math.min(Math.max(w, 340), Math.min(960, window.innerWidth * 0.5)));
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = { x: e.clientX, w: panelWidthNow(), next: null, frame: 0 }; };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    d.next = clampW(d.w + (d.x - e.clientX));
    const panel = e.currentTarget.parentElement;
    if (!d.frame && panel) d.frame = requestAnimationFrame(() => { d.frame = 0; if (d.next !== null) panel.style.setProperty("--panel-w", `${d.next}px`); });
  };
  const onResizeUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    if (d.next !== null) setHints({ readerWidth: d.next });
  };
  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setHints({ readerWidth: clampW(panelWidthNow() + (e.key === "ArrowLeft" ? 24 : -24)) }); }
  };

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      {playerOpen ? <a className="skip" href="#player" onClick={(e) => { e.preventDefault(); focusPlayer(); }}>Skip to the player</a> : null}
      <ContextMenus />
      <div className="app" data-sb={sbMode} data-bp={bp} data-drawer={overlaySb && drawer ? "open" : "closed"} data-panel={itemId ? "open" : "closed"} data-player={playerOpen ? "open" : "closed"}>
        <aside className="side" id="side" aria-label="Sidebar"><Sidebar mode={sbMode === "rail" ? "rail" : "full"} onToggle={overlaySb ? undefined : () => { toggleSidebar(); requestAnimationFrame(() => document.querySelector<HTMLElement>("#side [data-fk='tside']")?.focus()); }} /></aside>
        <div className="navscrim" onClick={() => setDrawer(false)} />
        <div className="pscrim" onClick={closeItem} />
        <div className="stage">
          <SetupBanner />
          <Header drawerOpen={drawer} overlaySidebar={overlaySb} onToggleSidebar={toggleSidebar} />
          <main className="main" id="main" ref={mainRef} tabIndex={-1}><Outlet /></main>
          {display === "eink" ? <PageNav target={mainRef} what="list" /> : null}
        </div>
        {bp === "xs" ? <TabBar drawerOpen={drawer} onBrowse={() => setDrawer((d) => !d)} /> : null}
        <aside className="panel" aria-label="Item details" hidden={!itemId} style={hints.readerWidth ? { "--panel-w": `${hints.readerWidth}px` } as CSSProperties : undefined}>
          <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize details panel" aria-valuenow={hints.readerWidth ?? undefined} aria-valuemin={340} aria-valuemax={960} tabIndex={0}
            onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} onKeyDown={onResizeKey} />
          <div id="panel-in">{itemId ? <ItemPanel key={itemId} itemId={itemId} /> : null}</div>
        </aside>
        <PlayerBar />
      </div>
      <OverlayHost />
      <ShareIntake />
      <OpenLinks />
      <DownloadsRunner />
      <DeviceRunner />
      <TipLayer />
    </>
  );
}

/** True when the page was reached by moving through the app (signing in or up ends on PURSS), not loaded fresh. */
function arrivedInApp(): boolean {
  const index = (history.state as { __TSR_index?: number } | null)?.__TSR_index;
  return typeof index === "number" && index > 0;
}

/** True below 1440px wide, where a docked reader leaves the list little room beside a full sidebar. */
function useNarrowLaptop(): boolean {
  const q = "(max-width: 1439px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}
