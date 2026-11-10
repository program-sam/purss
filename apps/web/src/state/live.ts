import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EventMessage } from "@purss/domain";
import { keys } from "../api/queries.ts";
import { emitItemsChanged } from "../offline/signals.ts";
import { platform } from "../platform/index.ts";
import { refreshActivity } from "./activity.ts";

/**
 * Server-sent events keep PURSS current: new items, source health, storage and
 * notifications. Bursts are collapsed so a busy sync causes one refresh, not hundreds.
 * `onNotification` is called (once per event) so the browser-notification layer can react.
 */
export function useLiveUpdates(onNotification: () => void): void {
  const qc = useQueryClient();
  const cb = useRef(onNotification);
  cb.current = onNotification;

  useEffect(() => {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      refreshActivity(qc); // what the engine is doing changes with every event; asked for at most every 30 seconds
      if (pending.has("bootstrap")) void qc.invalidateQueries({ queryKey: keys.bootstrap });
      if (pending.has("items")) { void qc.invalidateQueries({ queryKey: keys.items }); void qc.invalidateQueries({ queryKey: ["item"] }); void qc.invalidateQueries({ queryKey: keys.stats }); emitItemsChanged(); }
      if (pending.has("notifications")) void qc.invalidateQueries({ queryKey: keys.notifications });
      pending.clear();
    };
    const queue = (...what: string[]) => { what.forEach((w) => pending.add(w)); if (!timer) timer = setTimeout(flush, 600); };

    const stop = platform.transport.events((data) => {
      let msg: EventMessage;
      try { msg = JSON.parse(data) as EventMessage; } catch { return; }
      switch (msg.type) {
        case "items": queue("bootstrap", "items"); break;
        case "source": queue("bootstrap", "items"); break;
        case "storage": queue("bootstrap"); break;
        case "notification": queue("bootstrap", "notifications"); cb.current(); break;
        case "jobs": break;
        case "annotations": void qc.invalidateQueries({ queryKey: keys.annotations(msg.itemId) }); break;
      }
    });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [qc]);
}
