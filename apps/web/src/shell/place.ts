import { useLocation } from "@tanstack/react-router";
import type { Place } from "../nav.ts";
import { placeOf } from "../nav.ts";

/** Where in PURSS the URL currently points (null on pages outside the main map). */
export function useCurrentPlace(): Place | null {
  const path = useLocation({ select: (l) => l.pathname });
  return placeOf(path);
}

export function usePathname(): string {
  return useLocation({ select: (l) => l.pathname });
}
