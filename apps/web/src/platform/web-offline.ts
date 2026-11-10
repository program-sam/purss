import { APP_BASE } from "../app-base.ts";
import type { PageMessage } from "../sw/protocol.ts";
import type { OfflineHost } from "./types.ts";

/**
 * Offline reading on the web: a service worker (src/sw) keeps copies of API answers in the browser's
 * Cache Storage. This is the page's side: registering it, messaging it, and switching builds.
 */

/** Running as an installed app (its own window), not in a browser tab. */
function installed(): boolean {
  try {
    return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

/** Needs a worker and saved copies, which browsers allow only over HTTPS (or localhost). The development server has no worker. */
function supported(): boolean {
  return !import.meta.env.DEV && typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof caches !== "undefined" && window.isSecureContext;
}

let registered: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register the worker once. Does nothing where it can't run (insecure address, the development server). */
function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  registered ??= (async () => {
    if (!supported()) return null;
    try {
      const reg = await navigator.serviceWorker.register(`${APP_BASE}sw.js`, { scope: APP_BASE, updateViaCache: "none" });
      // A long-lived window never reloads on its own, so look for a new build now and then.
      const check = () => { void reg.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      setInterval(check, 60 * 60_000);
      return reg;
    } catch {
      return null;
    }
  })();
  return registered;
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function activeWorker(): Promise<ServiceWorker | null> {
  if (!(await registerWorker())) return null;
  return (await within(navigator.serviceWorker.ready, 8000))?.active ?? null;
}

/** Send a message to the worker and wait for it to say it has acted. False when there is no worker to tell. */
async function tell(message: PageMessage): Promise<boolean> {
  const worker = await activeWorker();
  if (!worker) return false;
  const channel = new MessageChannel();
  const acknowledged = new Promise<true>((resolve) => { channel.port1.onmessage = () => resolve(true); });
  worker.postMessage(message, [channel.port2]);
  return (await within(acknowledged, 4000)) === true;
}

async function whenControlled(timeoutMs: number): Promise<boolean> {
  if (!(await registerWorker())) return false;
  await within(navigator.serviceWorker.ready, timeoutMs);
  if (navigator.serviceWorker.controller) return true;
  return (await within(new Promise<true>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true })), timeoutMs)) === true;
}

function onUpdateReady(callback: () => void): () => void {
  let stopped = false;
  let stopWatching = () => {};
  void registerWorker().then((reg) => {
    if (!reg || stopped) return;
    const check = () => { if (reg.waiting && navigator.serviceWorker.controller) callback(); };
    const onFound = () => reg.installing?.addEventListener("statechange", check);
    check();
    reg.addEventListener("updatefound", onFound);
    stopWatching = () => reg.removeEventListener("updatefound", onFound);
  });
  return () => { stopped = true; stopWatching(); };
}

let reloading = false;

/** Switch to the waiting build and reload once. */
function applyUpdate(): void {
  void registerWorker().then((reg) => {
    const waiting = reg?.waiting;
    if (!waiting) { location.reload(); return; }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    waiting.postMessage({ type: "skip-waiting" } satisfies PageMessage);
  });
}

export const webOffline: OfflineHost = {
  supported,
  installed,
  start: async () => (await registerWorker()) !== null,
  tell,
  whenControlled,
  onUpdateReady,
  applyUpdate,
  caches: () => (typeof caches === "undefined" ? null : caches),
};
