import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@purss/ui";
import { platform } from "../platform/index.ts";
import { whereToGet } from "../platform/native/app-updates.ts";
import type { AppUpdates, AppUpdateState, InterfaceUpdateState } from "../platform/types.ts";
import { useToasts } from "../state/toasts.tsx";

/*
 * New versions of the phone app itself (plan/39): the screens update from the server, the app around them from where
 * it was installed. Announced once in a message, and kept in Settings → This device while it applies.
 */

const noSubscribe = () => () => {};
const noState = () => null;

function useAppUpdates(): { updates: AppUpdates; state: AppUpdateState; needed: boolean } | null {
  const updates = platform.appUpdates;
  const state = useSyncExternalStore(updates?.subscribe ?? noSubscribe, updates?.state ?? noState);
  const iu = platform.interfaceUpdates;
  const ius: InterfaceUpdateState | null = useSyncExternalStore(iu?.subscribe ?? noSubscribe, iu?.state ?? noState);
  return updates && state ? { updates, state, needed: ius?.needsNewerApp ?? false } : null;
}

/** What to say, and the way to get it; null when there is nothing to say. */
function describe(state: AppUpdateState, needed: boolean): { kind: "newer" | "needed"; short: string; long: string; action: { label: string; url: string } | null } | null {
  if (!state.known) return null;
  const where = whereToGet(state.source);
  if (state.newer) {
    return {
      kind: "newer",
      short: `Version ${state.newer} of the app is out`,
      long: `Version ${state.newer} is out${state.installed ? ` (this app is ${state.installed})` : ""}. Download it and open the file to install it over this one; what the app keeps on this phone stays.`,
      action: where.url ? { label: "Download", url: where.url } : null,
    };
  }
  if (!needed || state.source === "github") return null;
  const update = where.name ? `Update it in ${where.name}.` : "Update it from where you installed it.";
  return {
    kind: "needed",
    short: `This server's newest screens need a newer version of the app. ${update}`,
    long: `This server's newest screens need a newer version of the app than this one, so the app shows the screens it was installed with. ${update}`,
    action: where.url ? { label: `Open ${where.name}`, url: where.url } : null,
  };
}

/** Renders nothing: announces a newer version of the app once, in a message that stays until closed. */
export function AppUpdateNotice() {
  const u = useAppUpdates();
  const { toast } = useToasts();
  const updates = u?.updates;
  const said = u ? describe(u.state, u.needed) : null;
  const key = said ? `${said.kind}:${said.short}` : null;
  useEffect(() => {
    if (!updates || !said) return;
    // Read now, not from the render: StrictMode runs this twice with the same values.
    const now = updates.state();
    if (said.kind === "newer" ? now.toldNewer : now.toldNeeded) return;
    const { action } = said;
    toast(said.short, { sticky: true, tone: "none", actions: action ? [{ label: action.label, onSelect: () => platform.openExternal(action.url) }] : [] });
    updates.markTold(said.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `said`, which is rebuilt every render
  }, [updates, key, toast]);
  return null;
}

/** Settings → This device, while a newer version of the app is out or the server's screens need one. */
export function AppUpdateSection() {
  const u = useAppUpdates();
  const said = u ? describe(u.state, u.needed) : null;
  const waiting = u && !said && u.needed && u.state.source === "github";
  if (!said && !waiting) return null;
  return (
    <section className="field" aria-labelledby="dv-app-version">
      <div className="lbl" id="dv-app-version">New version of the app</div>
      {said ? <>
        <p className="fine">{said.long}</p>
        {said.action ? <div><Button variant="primary" onClick={() => platform.openExternal(said.action!.url)}>{said.kind === "newer" ? `Download version ${u!.state.newer}` : said.action.label}</Button></div> : null}
      </> : <p className="fine">This server's newest screens need a newer version of the app than this one. It isn't out yet; the app says so when it is.</p>}
    </section>
  );
}
