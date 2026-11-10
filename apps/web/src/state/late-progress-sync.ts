import { useEffect } from "react";
import type { ItemDetail } from "@purss/domain";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { get, patch } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { putItem } from "../api/queries.ts";
import type { StateChangeResult } from "../api/types.ts";
import { clearLateWrites, lateStore, worthRetrying } from "../lib/late-writes.ts";
import { onResume } from "../offline/status.ts";
import { outbox } from "../outbox/instance.ts";
import { serial } from "../outbox/serial.ts";
import { sendLateProgress } from "./late-progress.ts";

/** This account's reading progress that couldn't be sent yet. */
export const progressStore = (accountId: string) => lateStore<number>("progress", accountId);

export function syncLateProgress(qc: QueryClient, accountId: string): Promise<void> {
  return sendLateProgress({
    store: progressStore(accountId),
    read: async (id) => {
      const item = await get<ItemDetail>(`/api/items/${encodeURIComponent(id)}`);
      return { progress: item.progress, revision: item.revision };
    },
    write: (id, progress, expectedRevision) => serial(id, async () => {
      const res = await patch<StateChangeResult>(`/api/items/${encodeURIComponent(id)}/state`, { progress, expectedRevision });
      outbox.noteOwnWrite(id, expectedRevision, res.item.revision);
      putItem(qc, res.item);
    }),
    worthRetrying,
  });
}

/**
 * Renders nothing. Sends reading progress kept on this device: at start, when the connection returns,
 * when the page is shown again, and every ten seconds while any waits. In a browser, other accounts'
 * unsent progress and playback positions are deleted when someone signs in; the apps keep them
 * (`keepOtherAccounts`) for when that account connects again.
 */
export function LateProgressSync({ keepOtherAccounts = false }: { keepOtherAccounts?: boolean }) {
  const qc = useQueryClient();
  const session = useSession();
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;
  useEffect(() => {
    if (!accountId) return;
    if (!keepOtherAccounts) clearLateWrites(undefined, accountId);
    const send = () => void syncLateProgress(qc, accountId);
    send();
    const stop = onResume(send);
    const timer = setInterval(() => {
      if (navigator.onLine !== false && Object.keys(progressStore(accountId).all()).length) send();
    }, 10_000);
    return () => { stop(); clearInterval(timer); };
  }, [qc, accountId, keepOtherAccounts]);
  return null;
}
