import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { messageOf } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { homeOverviewKey } from "../api/home-queries.ts";
import { dropFromScope, findItem, keys, putItem, refreshPurss } from "../api/queries.ts";
import { createItemWriter } from "../outbox/item-writer.ts";
import type { ItemCache } from "../outbox/item-writer.ts";
import { itemRequests, outbox } from "../outbox/instance.ts";
import { seenNotices } from "./seen-notice.ts";
import { progressStore } from "./late-progress-sync.ts";
import { useToasts } from "./toasts.tsx";
import { usePurss } from "./purss.tsx";

function staleLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: keys.bootstrap });
  void qc.invalidateQueries({ queryKey: keys.items, refetchType: "none" });
  refillSoon(qc);
}

let refillTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Home's boxes hold a few spare items, so one taken out is replaced at once. After a run of changes they are fetched
 * again to top the spares up, once the changes pause, so rows don't reorder under the pointer while sorting.
 */
function refillSoon(qc: QueryClient): void {
  clearTimeout(refillTimer);
  refillTimer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: [...keys.items, "preview"], refetchType: "active" });
    void qc.invalidateQueries({ queryKey: homeOverviewKey, refetchType: "active" });
  }, 1500);
}

/** The page's query cache as the item writer sees it. */
function queryItemCache(qc: QueryClient): ItemCache {
  return {
    find: (id) => findItem(qc, id),
    put: (item) => putItem(qc, item),
    dropFromBasket: (basketId, id) => dropFromScope(qc, `basket:${basketId}`, id),
    readAgain: (id) => {
      void qc.invalidateQueries({ queryKey: keys.item(id) });
      void qc.invalidateQueries({ queryKey: keys.items });
    },
    readItemAgain: (id) => void qc.invalidateQueries({ queryKey: keys.item(id) }),
    readListsAgain: () => void qc.invalidateQueries({ queryKey: keys.items }),
    listsStale: () => staleLists(qc),
    newCleared: () => {
      void qc.invalidateQueries({ queryKey: keys.bootstrap });
      void qc.invalidateQueries({ queryKey: homeOverviewKey });
    },
    readEverythingAgain: () => refreshPurss(qc),
  };
}

/** All item-changing actions, each with an Undo message (see outbox/item-writer.ts). */
export function useItemActions() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const ws = usePurss();
  const session = useSession();
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;

  return useMemo(() => createItemWriter({
    cache: queryItemCache(qc),
    outbox,
    requests: itemRequests,
    say: toast,
    messageOf,
    basketName: (basketId) => ws.basketById.get(basketId)?.name,
    unsentProgress: () => (accountId ? progressStore(accountId) : null),
    seen: seenNotices,
  }), [qc, toast, ws, accountId]);
}
