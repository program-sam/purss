import { useBreakpoint } from "@purss/ui";
import { statsPlaceOf, useNav } from "../nav.ts";
import { TO_READ_TITLE } from "../lib/constants.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { pageFor } from "../plugins.ts";
import { useCurrentPlace, usePathname } from "./place.ts";

export type Crumb = { label: string; to?: () => void };

/** Where the current page sits: its ancestors, then the page itself. */
export function useCrumbs(): Crumb[] {
  const ws = useWorkspace();
  const nav = useNav();
  const place = useCurrentPlace();
  const pathname = usePathname();
  const goHome = () => nav.go({ t: "home" });
  const crumbs: Crumb[] = [];
  if (place?.t === "home") crumbs.push({ label: "Home" });
  else if (place?.t === "c") crumbs.push({ label: "Collections", to: goHome }, { label: ws.collectionById.get(place.id)?.name ?? "Collection" });
  else if (place?.t === "s") {
    const s = ws.sourceById.get(place.id);
    const c = s ? ws.collectionById.get(s.collectionIds[0] ?? "") : undefined;
    crumbs.push({ label: "Collections", to: goHome });
    if (c) crumbs.push({ label: c.name, to: () => nav.go({ t: "c", id: c.id }) });
    crumbs.push({ label: s?.title ?? "Source" });
  } else if (place?.t === "b") crumbs.push({ label: "Baskets" }, { label: ws.basketById.get(place.id)?.name ?? "Basket" });
  else if (place?.t === "r") crumbs.push({ label: TO_READ_TITLE });
  else if (statsPlaceOf(pathname)) {
    const sp = statsPlaceOf(pathname)!;
    crumbs.push({ label: "Collections", to: goHome });
    if (sp.t === "c") crumbs.push({ label: ws.collectionById.get(sp.id)?.name ?? "Collection", to: () => nav.go(sp) });
    else {
      const s = ws.sourceById.get(sp.id);
      const c = s ? ws.collectionById.get(s.collectionIds[0] ?? "") : undefined;
      if (c) crumbs.push({ label: c.name, to: () => nav.go({ t: "c", id: c.id }) });
      crumbs.push({ label: s?.title ?? "Source", to: () => nav.go(sp) });
    }
    crumbs.push({ label: "Statistics" });
  } else {
    const page = pageFor(pathname);
    if (page?.parent) crumbs.push({ label: page.parent.label, to: () => nav.goPath(page.parent!.to) });
    crumbs.push({ label: page?.title ?? "Home" });
  }
  return crumbs;
}

/** The way back up, as a small line above the page's heading. Without a bar the page names itself in its heading,
 *  so only the ancestors you can go to are shown, and not the Collections root: Home is always one click away.
 *  Phones and tablets show the trail in their bar instead. */
export function Trail() {
  const crumbs = useCrumbs();
  const bp = useBreakpoint();
  if (bp === "sm" || bp === "xs") return null;
  const up = crumbs.slice(0, -1).filter((c, i) => c.to && !(i === 0 && c.label === "Collections"));
  if (!up.length) return null;
  return (
    <nav className="trail" aria-label="Breadcrumb">
      <ol>{up.map((c, i) => <li key={i}><button type="button" onClick={c.to}><bdi>{c.label}</bdi></button></li>)}</ol>
    </nav>
  );
}
