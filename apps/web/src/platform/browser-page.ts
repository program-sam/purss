import { api } from "../api/client.ts";
import { deviceWrites } from "../lib/unsent-writes.ts";
import { wipeOfflineCopies } from "../offline/service-worker-link.ts";
import { clearHints } from "../state/ui-store.ts";
import type { Page } from "./connected-app.ts";
import { leaveNotice, localKv, sendLinksOut, takeNotice, takeStuck, timeout } from "./native/app-start.ts";

/** The page of the app, as the apps start it (connected-app.ts). */
export const browserPage: Page = {
  get origin() { return location.origin; },
  store: localKv,
  sendLinksOut,
  limitTo(policy) {
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    document.head.prepend(meta);
  },
  onShown(listener) {
    let hiddenAt: number | null = null;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      listener(away);
    });
  },
  notices: { leave: leaveNotice, take: takeNotice, takeStuck },
  resetAddress() {
    try { history.replaceState(null, "", "/"); } catch { /* the interface's reload starts at the root anyway */ }
  },
  replaceWithRoot: () => location.replace("/"),
  reload: () => location.reload(),
  revokeDevice: async () => { await timeout(api("/api/connect/device", { method: "DELETE" }), 8000); },
  data: {
    wipeCopies: wipeOfflineCopies,
    unsent: deviceWrites,
    clearHints,
  },
};
