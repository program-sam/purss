import type { QueryClient } from "@tanstack/react-query";
import type { SourceDTO } from "@purss/domain";
import { messageOf, post } from "../api/client.ts";
import { activityQuery } from "../api/home-queries.ts";
import { keys, putSource } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import type { ToastOptions } from "./toasts.tsx";

/** Ask PURSS to try following a failed source again. It then shows as collecting; the answer says if it can't be retried. */
export async function retrySource(qc: QueryClient, toast: (message: string, opts?: ToastOptions) => void, id: string, title: string): Promise<boolean> {
  try {
    putSource(qc, await post<SourceDTO>(`/api/sources/${encodeURIComponent(id)}/retry`));
    void qc.invalidateQueries({ queryKey: keys.bootstrap });
    void qc.invalidateQueries({ queryKey: activityQuery.queryKey });
    toast(`Trying again to collect ${isolate(title)}.`);
    return true;
  } catch (err) {
    toast(messageOf(err), { tone: "error" });
    return false;
  }
}
