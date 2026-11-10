import { useEffect } from "react";
import { useSession } from "../api/hooks.ts";
import { onItemsChanged } from "../offline/signals.ts";
import { onBackOnline } from "../offline/status.ts";
import { platform } from "../platform/index.ts";

/** How often downloads are brought up to date while the app is open, besides the moments below. */
const EVERY_MS = 30 * 60_000;

/**
 * Renders nothing. In the apps, keeps downloads in step with the signed-in account: shortly after start,
 * after new items arrive, when the connection returns, when the app comes back to the front, and every
 * half hour. While the app is closed, the native background job (plan/38) does the same about hourly.
 */
export function DownloadsRunner() {
  const session = useSession();
  const known = session.data !== undefined;
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;

  useEffect(() => {
    const d = platform.downloads;
    if (!d || !known) return;
    d.setAccount(accountId);
    if (!accountId) return;
    let later: ReturnType<typeof setTimeout> | undefined;
    const run = () => { if (navigator.onLine !== false) void d.sync(); };
    const runIn = (ms: number) => { clearTimeout(later); later = setTimeout(run, ms); };
    runIn(3000);
    const offItems = onItemsChanged(() => runIn(20_000));
    const offOnline = onBackOnline(() => runIn(3000));
    const onVisible = () => { if (document.visibilityState === "visible") runIn(1500); };
    document.addEventListener("visibilitychange", onVisible);
    const every = setInterval(run, EVERY_MS);
    return () => {
      clearTimeout(later);
      clearInterval(every);
      offItems();
      offOnline();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [known, accountId]);
  return null;
}
