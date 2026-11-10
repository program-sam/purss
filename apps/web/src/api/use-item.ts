import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ItemDTO } from "@purss/domain";
import { findItem } from "./queries.ts";

/** The latest cached copy of an item, re-read whenever any query cache changes. */
export function useCachedItem(id: string | undefined): ItemDTO | undefined {
  const qc = useQueryClient();
  return useSyncExternalStore(
    (cb) => qc.getQueryCache().subscribe(cb),
    () => (id ? findItem(qc, id) : undefined),
    () => undefined,
  );
}
