import { useLayoutEffect, useRef } from "react";
import { Icon, useBreakpoint } from "@purss/ui";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { HeaderAccount } from "../auth/HeaderAccount.tsx";
import { useOfflineStatus, showsSavedCopy } from "../offline/status.ts";
import { usePendingCount } from "../outbox/hooks.ts";
import { NotificationsPanel } from "./Notifications.tsx";
import { useCrumbs } from "./crumbs.tsx";
import { useCurrentPlace } from "./place.ts";

/** Lines the breadcrumbs up with the left edge of the page's content column, whatever its width,
 *  by setting --crumb-l on the bar. The sidebar toggle stays at the window edge. */
function useColumnAlign(shown: boolean) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const main = document.getElementById("main");
    if (!bar || !main) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      const col = main.querySelector<HTMLElement>(".col");
      const crumbs = bar.querySelector<HTMLElement>(".crumbs");
      if (!col || !crumbs) { bar.style.removeProperty("--crumb-l"); return; }
      const left = col.getBoundingClientRect().left + parseFloat(getComputedStyle(col).paddingLeft);
      const al = Math.max(0, left - (crumbs.getBoundingClientRect().left - parseFloat(getComputedStyle(crumbs).marginLeft)));
      bar.style.setProperty("--crumb-l", `${Math.round(al)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit); };
    fit();
    const ro = new ResizeObserver(schedule);
    ro.observe(bar);
    ro.observe(main);
    const mo = new MutationObserver(schedule);
    mo.observe(main, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); if (frame) cancelAnimationFrame(frame); bar.style.removeProperty("--crumb-l"); };
  }, [shown]);
  return ref;
}

/** The top of the page area: the notifications bell in the corner, and on phones and tablets, where the sidebar
 *  is a drawer, a slim bar with its toggle and the way back. Desktop pages carry their own heading and tools. */
export function Header({ drawerOpen, overlaySidebar, onToggleSidebar }: { drawerOpen: boolean; overlaySidebar: boolean; onToggleSidebar: () => void }) {
  const ws = useWorkspace();
  const place = useCurrentPlace();
  const overlays = useOverlays();
  const popups = usePopups();
  const bp = useBreakpoint();
  const crumbs = useCrumbs();
  // No badge while notifications are off, even for ones that arrived before.
  const unread = ws.prefs.notifications.frequency === "off" ? 0 : ws.data.unreadNotifications;
  const offline = useOfflineStatus();
  const savedCopy = showsSavedCopy(offline);
  const waiting = usePendingCount();
  const showBar = overlaySidebar;
  const barRef = useColumnAlign(showBar);

  // A zero-height layer, so the bell takes no row of its own: over the bar's right end, or over the page's top corner.
  // Settings (on a phone) and Sign out (on a shared computer) sit beside the bell.
  const corner = (
    <div className={`corner${showBar ? "" : " float"}`}>
      <div className="cbtns">
        <HeaderAccount />
        <button type="button" className="ibtn bell" aria-haspopup="dialog" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          onClick={(e) => popups.panel(e.currentTarget, "Notifications", (close) => <NotificationsPanel onClose={() => close()} />, { className: "notif-pop" })}>
          <Icon name="bell" />{unread ? <span className="bell-n" aria-hidden="true">{unread > 9 ? "9+" : unread}</span> : null}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {showBar ? corner : null}
      {showBar ? <header ref={barRef} className="bar al">
        <button type="button" className="ibtn" data-fk="tside" aria-label="Open sidebar" aria-expanded={drawerOpen} onClick={onToggleSidebar}><Icon name="sidebar" /></button>
        {bp === "xs" && place?.t === "home" ? (
          // On a phone the Home page carries its own title, so the bar names the app instead.
          <span className="brand crumbs"><span className="mark" aria-hidden="true"><Icon name="mark" /></span>PURSS</span>
        ) : bp === "xs" && crumbs.length > 1 ? (
          // A phone has room for one step back and where you are, not the whole trail.
          <nav className="crumbs xs" aria-label="Breadcrumb">
            {crumbs[crumbs.length - 2]!.to ? (
              // The page names itself in its heading; the bar says where Back goes.
              <button type="button" className="crumb-back" onClick={crumbs[crumbs.length - 2]!.to}><Icon name="back" /><span className="sr">Back to </span><bdi>{crumbs[crumbs.length - 2]!.label}</bdi></button>
            ) : <span className="here" aria-current="page"><bdi>{crumbs[crumbs.length - 1]!.label}</bdi></span>}
          </nav>
        ) : (
          <nav className="crumbs" aria-label="Breadcrumb">
            <ol>
              {crumbs.map((c, i) => i === crumbs.length - 1
                ? <li key={i} aria-current="page"><bdi>{c.label}</bdi></li>
                : <li key={i}>{c.to ? <button type="button" onClick={c.to}><bdi>{c.label}</bdi></button> : <bdi>{c.label}</bdi>}</li>)}
            </ol>
          </nav>
        )}
        {bp !== "xs" ? <button type="button" className="btn primary bar-add" style={{ height: 32 }} onClick={() => overlays.open({ kind: "add-source", collectionId: place?.t === "c" ? place.id : undefined })}><Icon name="plus" size="sm" />Add source</button> : null}
      </header> : null}
      {savedCopy || (waiting > 0 && !offline.browserOnline) ? (
        <div className="offline-note" role="status"><Icon name="info" size="sm" />
          <span>{savedCopy ? "Offline · showing what this device saved" : "Offline"}{waiting > 0 ? ` · ${waiting === 1 ? "1 change saved on this device. It'll" : `${waiting} changes saved on this device. They'll`} be sent when you're back online.` : ""}</span>
        </div>
      ) : null}
      {showBar ? null : corner}
    </>
  );
}
