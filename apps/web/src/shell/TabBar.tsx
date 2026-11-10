import { Icon } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { useCurrentPlace } from "./place.ts";

/** Phone navigation at thumb height: Home, everything you follow and keep, Search and Add source. */
export function TabBar({ drawerOpen, onBrowse }: { drawerOpen: boolean; onBrowse: () => void }) {
  const nav = useNav();
  const overlays = useOverlays();
  const ws = useWorkspace();
  const place = useCurrentPlace();
  const home = place?.t === "home" && !drawerOpen;
  const browsing = drawerOpen || place?.t === "c" || place?.t === "s" || place?.t === "b";
  const addTo = place?.t === "c" ? place.id : place?.t === "s" ? ws.sourceById.get(place.id)?.collectionIds[0] : undefined;
  const tab = (icon: IconName, label: string, onClick: () => void, opts: { current?: boolean; expanded?: boolean } = {}) => (
    <button type="button" className="tab" aria-current={opts.current ? "page" : undefined} aria-expanded={opts.expanded} onClick={onClick}>
      <span className="ti"><Icon name={icon} /></span><span className="tl">{label}</span>
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab("home", "Home", () => nav.go({ t: "home" }), { current: home })}
      {tab("folder", "Collections", onBrowse, { expanded: drawerOpen, current: browsing })}
      {tab("search", "Search", () => overlays.open({ kind: "palette" }))}
      {tab("plus", "Add source", () => overlays.open({ kind: "add-source", collectionId: addTo }))}
    </nav>
  );
}
