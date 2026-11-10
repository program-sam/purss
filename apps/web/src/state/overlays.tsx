import type { ShareTarget } from "@purss/domain";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/** Every popup the app can show. Only one is open at a time; opening another replaces it. */
export type Overlay =
  /** `url` prefills the link; nothing is looked up until the person presses Find. */
  | { kind: "add-source"; collectionId?: string; url?: string }
  /** A link shared into the apps from another app. */
  | { kind: "shared"; url: string; title: string }
  /** An OPML file opened with the desktop app (plan/42): its feeds, to choose which to follow. */
  | { kind: "opml-file"; name: string; text: string }
  | { kind: "new-collection" }
  | { kind: "collection-settings"; id: string }
  | { kind: "customise-home" }
  | { kind: "basket-form"; id?: string; keepItemId?: string }
  | { kind: "basket-delete"; id: string }
  | { kind: "settings"; tab?: "general" | "notifications" | "security" | "apps" | "assistants" | "device" | "account" }
  | { kind: "shortcuts" }
  | { kind: "palette"; query?: string }
  | { kind: "keep-page"; url: string; title?: string }
  | { kind: "move-source"; id: string }
  | { kind: "rename-source"; id: string }
  | { kind: "unfollow"; id: string }
  | { kind: "ai-filter"; sourceId?: string; collectionId?: string }
  | { kind: "keep-in"; itemIds: string[] }
  | { kind: "delete-items"; itemIds: string[] }
  | { kind: "share"; target: ShareTarget; targetId: string; name: string };

type Ctx = { overlay: Overlay | null; open: (o: Overlay) => void; close: () => void };
const OverlayCtx = createContext<Ctx | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const open = useCallback((o: Overlay) => setOverlay(o), []);
  const close = useCallback(() => setOverlay(null), []);
  const value = useMemo(() => ({ overlay, open, close }), [overlay, open, close]);
  return <OverlayCtx.Provider value={value}>{children}</OverlayCtx.Provider>;
}

export function useOverlays(): Ctx {
  const v = useContext(OverlayCtx);
  if (!v) throw new Error("OverlayProvider is missing");
  return v;
}
