import type { KeyValue } from "../../downloads/manager.ts";

/*
 * What the phone apps (native/index.tsx) and the desktop app (desktop/index.tsx, plan/42) do the same way at start:
 * local storage as a key-value store, the notice and the stuck flag a disconnection leaves for the next start, and
 * sending links to other sites out of the app's page.
 */

export const localKv: KeyValue = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* full: kept for this run */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* nothing */ } },
  keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
};

const NOTICE_KEY = "purss:connect-notice";
/** Set when the connection couldn't be removed from secure storage, so the next start doesn't use it. */
const STUCK_KEY = "purss:connect-stuck";

/** Leave the first screen's notice (and whether the connection is stuck) for the start after the reload. */
export function leaveNotice(notice: string, stuck: boolean): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, notice);
    if (stuck) sessionStorage.setItem(STUCK_KEY, "1");
  } catch { /* shown or not */ }
}

/** The notice left by the last start, once. */
export function takeNotice(): string | null {
  try { const notice = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); return notice; } catch { return null; }
}

/** Whether the last start couldn't remove the connection, once. */
export function takeStuck(): boolean {
  try { const stuck = sessionStorage.getItem(STUCK_KEY) !== null; sessionStorage.removeItem(STUCK_KEY); return stuck; } catch { return false; }
}

/** Links to other sites go to `open` (the system browser), never inside the app's own page. */
export function sendLinksOut(open: (url: string) => void): void {
  const out = (url: string) => { if (/^https?:\/\//i.test(url)) open(url); };
  window.open = ((url?: string | URL) => { if (url) out(String(url)); return null; }) as typeof window.open;
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented) return;
    const href = a.href;
    if (/^https?:\/\//i.test(href) && new URL(href).origin !== location.origin) { e.preventDefault(); out(href); }
  }, true);
}

export function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
