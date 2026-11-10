import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PACK_CHANGE_INTERVAL_MS, PACK_MIN_INTERVAL_MS, packWait } from "./pack.ts";
import { runPack } from "./pack-runner.ts";
import { refreshPackStatus, setPackRunning } from "./pack-status.ts";
import { onItemsChanged, onReadingChanged } from "./signals.ts";
import { onBackOnline } from "./status.ts";
import { readRecord, savedItemIds } from "./store.ts";
import { syncWorkerState, whenControlled } from "./worker-link.ts";

/** How often, and how many times, to look again for the worker taking charge of the page when it hasn't yet. */
const CONTROL_RETRY_MS = 15_000;
const CONTROL_RETRIES = 40;
/** After the person marks something To read or keeps something, wait this long (for more changes in a row) before saving again. */
const CHANGE_DELAY_MS = 4_000;

type Kind = "full" | "light";

/**
 * Keeps the reading queue saved while offline reading is on and someone is signed in. The queue is saved once the worker
 * is in charge of the page (looked for again every fifteen seconds if it isn't yet), at once when the device has lost
 * copies the record says it saved, soon after the person marks something To read or keeps something (the changed queue
 * only, not the pages), after new items arrive, when the connection returns, and otherwise every fifteen minutes. Saves
 * are at least fifteen minutes apart, except for the cases of lost copies (at least ten seconds apart) and changes (at least
 * half a minute apart); the very first save on a device, or after the copies were removed, starts at once.
 */
export function usePack(accountId: string | null, enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!accountId || !enabled) return;
    const stop = new AbortController();
    const timers: Record<Kind | "retry", ReturnType<typeof setTimeout> | undefined> = { full: undefined, light: undefined, retry: undefined };
    const planned: Record<Kind, number> = { full: 0, light: 0 };
    let ready = false;
    let running = false;
    /** A change came while a save was running: save the changed queue again soon after it. */
    let again = false;

    const run = async (kind: Kind) => {
      if (stop.signal.aborted) return;
      if (running) { if (kind === "light") again = true; return; }
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      running = true;
      setPackRunning(true);
      try { await runPack(qc, accountId, stop.signal, { light: kind === "light" }); } catch { /* the connection dropped or the server is busy: the next trigger tries again */ }
      running = false;
      setPackRunning(false);
      if (stop.signal.aborted) return;
      if (again) { again = false; plan("light", CHANGE_DELAY_MS, PACK_CHANGE_INTERVAL_MS); }
      plan("full", PACK_MIN_INTERVAL_MS);
    };

    /** Start in `minimum` ms or, if later, when `floor` ms have passed since the last start; the floor is ten seconds at most when the copies are gone. */
    const plan = (kind: Kind, minimum: number, floor: number = PACK_MIN_INTERVAL_MS) => {
      if (!ready) return;
      const mine = ++planned[kind];
      void (async () => {
        const record = readRecord(accountId);
        const present = await savedItemIds(accountId);
        if (stop.signal.aborted || mine !== planned[kind]) return;
        const wait = packWait(record, present, Date.now(), minimum, floor);
        clearTimeout(timers[kind]);
        timers[kind] = setTimeout(() => void run(kind), wait);
      })();
    };

    /** The worker must know who is signed in and be in charge of this page before anything is fetched, or nothing is kept. */
    const begin = async (attempt: number) => {
      if (stop.signal.aborted) return;
      const worker = (await syncWorkerState(accountId, true)) && !stop.signal.aborted && (await whenControlled());
      if (stop.signal.aborted) return;
      if (!worker) {
        if (attempt < CONTROL_RETRIES) timers.retry = setTimeout(() => void begin(attempt + 1), CONTROL_RETRY_MS);
        return;
      }
      ready = true;
      void refreshPackStatus(accountId);
      plan("full", 1500);
    };
    void begin(0);

    const offItems = onItemsChanged(() => plan("full", 20_000));
    const offReading = onReadingChanged(() => plan("light", CHANGE_DELAY_MS, PACK_CHANGE_INTERVAL_MS));
    const offOnline = onBackOnline(() => plan("full", 3000));
    const onVisible = () => { if (document.visibilityState === "visible") plan("full", 1500); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop.abort();
      Object.values(timers).forEach((t) => clearTimeout(t));
      offItems();
      offReading();
      offOnline();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc, accountId, enabled]);
}
