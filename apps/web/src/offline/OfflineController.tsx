import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "../api/hooks.ts";
import { outbox } from "../outbox/instance.ts";
import { useToasts } from "../state/toasts.tsx";
import { useOfflineReading } from "./device.ts";
import "./install.ts";
import { refreshPackStatus } from "./pack-status.ts";
import { emitReadingChanged } from "./signals.ts";
import { clearRecords } from "./store.ts";
import { onBackOnline, refreshBrowserOnline, showsSavedCopy, useOfflineStatus } from "./status.ts";
import { usePack } from "./use-pack.ts";
import { applyUpdate, onUpdateReady, registerWorker, syncWorkerState } from "./worker-link.ts";

/**
 * Renders nothing. Registers the service worker, offers a new build when one is waiting, keeps the
 * worker told who is signed in and whether offline reading is on (it wipes the copies when nobody is
 * or the setting is off), runs the offline pack, and refreshes what was shown from copies when the
 * connection comes back or every ten seconds while copies are on screen.
 */
export function OfflineController() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const session = useSession();
  const enabled = useOfflineReading();
  const known = session.data !== undefined;
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;

  useEffect(() => {
    void registerWorker();
    return onUpdateReady(() => toast("A new version is ready", { sticky: true, tone: "none", actions: [{ label: "Reload", onSelect: applyUpdate }] }));
  }, [toast]);

  // Nobody signed in, or the setting off: nothing may stay saved. (usePack tells the worker in the other case.)
  useEffect(() => {
    if (!known || (accountId && enabled)) return;
    clearRecords();
    void refreshPackStatus(null);
    void syncWorkerState(accountId, enabled);
  }, [known, accountId, enabled]);

  // What the person reads or keeps just changed (To read, a keep, an undo): the saved queue follows soon after.
  useEffect(() => outbox.onOutcome((o) => { if (o.status === "sent" && o.result.kind !== "clearFresh") emitReadingChanged(); }), []);

  usePack(accountId, enabled);

  useEffect(() => onBackOnline(() => { void qc.invalidateQueries(); }), [qc]);

  // While saved copies are on screen, look again now and then: a slow connection or a missed "online" event
  // must not leave the notice up once the real answers are available.
  const savedCopy = showsSavedCopy(useOfflineStatus());
  useEffect(() => {
    if (!savedCopy) return;
    const timer = setInterval(() => {
      refreshBrowserOnline();
      if (navigator.onLine !== false) void qc.invalidateQueries();
    }, 10_000);
    return () => clearInterval(timer);
  }, [savedCopy, qc]);
  return null;
}
