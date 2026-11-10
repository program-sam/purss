import { useSyncExternalStore } from "react";
import { createOpenHold } from "../lib/open-hold.ts";

/** The item open in the panel that lists keep showing as New until it closes (see lib/open-hold.ts). In memory only. */
export const openHold = createOpenHold();

export function useOpenHold(): string | null {
  return useSyncExternalStore(openHold.subscribe, openHold.get, () => null);
}
