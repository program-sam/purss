import { Suspense, createElement, lazy, useEffect } from "react";
import type { Attributes, ComponentType } from "react";
import { OpmlFileRoute, ShareRoute } from "../features/lazy.tsx";
import { useOverlays } from "../state/overlays.tsx";
import { SharedDialog } from "../share/ShareIntake.tsx";

/*
 * The popups load on their own, so PURSS starts with less code. Their code is fetched once the page has
 * settled; a popup whose code is here opens at once, and one opened sooner shows when its code arrives.
 */
const preloads: (() => Promise<void>)[] = [];

function popup<M, P extends object>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>): ComponentType<P> {
  let ready: ComponentType<P> | null = null;
  const Lazy = lazy(() => load().then((m) => ({ default: (ready = pick(m)) })));
  preloads.push(() => load().then((m) => { ready = pick(m); }));
  return function Popup(props: P) {
    return createElement(ready ?? Lazy, props as P & Attributes);
  };
}

const AddSourceDialog = popup(() => import("./AddSource.tsx"), (m) => m.AddSourceDialog);
const BasketDeleteDialog = popup(() => import("./Baskets.tsx"), (m) => m.BasketDeleteDialog);
const BasketFormDialog = popup(() => import("./Baskets.tsx"), (m) => m.BasketFormDialog);
const CollectionSettingsDialog = popup(() => import("./Collections.tsx"), (m) => m.CollectionSettingsDialog);
const NewCollectionDialog = popup(() => import("./Collections.tsx"), (m) => m.NewCollectionDialog);
const CustomiseHomeDialog = popup(() => import("./CustomiseHome.tsx"), (m) => m.CustomiseHomeDialog);
const DeleteItemsDialog = popup(() => import("./Items.tsx"), (m) => m.DeleteItemsDialog);
const KeepInDialog = popup(() => import("./Items.tsx"), (m) => m.KeepInDialog);
const KeepPageDialog = popup(() => import("./KeepPage.tsx"), (m) => m.KeepPageDialog);
const PaletteDialog = popup(() => import("./Palette.tsx"), (m) => m.PaletteDialog);
const SettingsDialog = popup(() => import("./Settings.tsx"), (m) => m.SettingsDialog);
const ShortcutsDialog = popup(() => import("./Shortcuts.tsx"), (m) => m.ShortcutsDialog);
const MoveSourceDialog = popup(() => import("./Sources.tsx"), (m) => m.MoveSourceDialog);
const RenameSourceDialog = popup(() => import("./Sources.tsx"), (m) => m.RenameSourceDialog);
const UnfollowDialog = popup(() => import("./Sources.tsx"), (m) => m.UnfollowDialog);
const AiFilterDialog = popup(() => import("./AiFilter.tsx"), (m) => m.AiFilterDialog);

/** Fetch every popup's code when the browser is idle after start-up. */
function preloadPopups(): () => void {
  const run = () => { for (const p of preloads) void p().catch(() => undefined); };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 4000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 1500);
  return () => clearTimeout(id);
}

/** Renders whichever popup is open. Keyed so reopening the same kind starts fresh. */
export function OverlayHost() {
  const { overlay: o } = useOverlays();
  useEffect(preloadPopups, []);
  if (!o) return null;
  return <Suspense fallback={null}><Overlay o={o} /></Suspense>;
}

function Overlay({ o }: { o: NonNullable<ReturnType<typeof useOverlays>["overlay"]> }) {
  const { close } = useOverlays();
  switch (o.kind) {
    case "add-source": return <AddSourceDialog key="add" collectionId={o.collectionId} url={o.url} />;
    case "new-collection": return <NewCollectionDialog key="newcol" />;
    case "collection-settings": return <CollectionSettingsDialog key={`cs-${o.id}`} id={o.id} />;
    case "customise-home": return <CustomiseHomeDialog key="home" />;
    case "basket-form": return <BasketFormDialog key={`bf-${o.id ?? "new"}`} id={o.id} keepItemId={o.keepItemId} />;
    case "basket-delete": return <BasketDeleteDialog key={`bd-${o.id}`} id={o.id} />;
    case "settings": return <SettingsDialog key="settings" tab={o.tab} />;
    case "shortcuts": return <ShortcutsDialog key="keys" />;
    case "palette": return <PaletteDialog key="pal" query={o.query} />;
    case "keep-page": return <KeepPageDialog key="keep-page" url={o.url} title={o.title} />;
    case "move-source": return <MoveSourceDialog key={`mv-${o.id}`} id={o.id} />;
    case "rename-source": return <RenameSourceDialog key={`rn-${o.id}`} id={o.id} />;
    case "unfollow": return <UnfollowDialog key={`uf-${o.id}`} id={o.id} />;
    case "ai-filter": return <AiFilterDialog key={`aif-${o.sourceId ?? o.collectionId}`} scope={o.sourceId ? { sourceId: o.sourceId } : { collectionId: o.collectionId! }} />;
    case "keep-in": return <KeepInDialog key="keep" itemIds={o.itemIds} />;
    case "delete-items": return <DeleteItemsDialog key="del" itemIds={o.itemIds} />;
    case "share": return <ShareRoute key={`share-${o.targetId}`} kind={o.target} id={o.targetId} name={o.name} onClose={close} />;
    case "shared": return <SharedDialog key={`shared-${o.url}`} url={o.url} title={o.title} />;
    case "opml-file": return <OpmlFileRoute key={`opml-${o.name}`} name={o.name} text={o.text} onClose={close} />;
  }
}
