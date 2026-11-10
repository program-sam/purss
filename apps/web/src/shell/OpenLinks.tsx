import { useEffect, useRef } from "react";
import { useNav } from "../nav.ts";
import { platform } from "../platform/index.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { notificationPlace } from "./notification-target.ts";

/**
 * Renders nothing. In the apps, a tapped home-screen widget row (plan/38) or notification (plan/37) opens
 * what it is about: its item (in its source when the link names one), the source, or Home. The link only
 * navigates; it never changes anything in PURSS.
 */
export function OpenLinks() {
  const nav = useNav();
  const ws = useWorkspace();
  const overlays = useOverlays();
  const latest = useRef({ nav, sources: ws.sourceById, overlays });
  latest.current = { nav, sources: ws.sourceById, overlays };
  useEffect(() => platform.onOpen((target) => {
    const { nav: n, sources, overlays: o } = latest.current;
    o.close(); // what was open (Settings, a dialog) gives way to what was tapped
    const to = notificationPlace(target, (id) => sources.has(id));
    if (to) n.go(to.place, to.search);
    else n.go({ t: "home" });
  }), []);
  return null;
}
