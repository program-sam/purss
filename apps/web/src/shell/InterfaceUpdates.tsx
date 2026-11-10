import { useSyncExternalStore } from "react";
import { Button, Check, Dialog } from "@purss/ui";
import { platform } from "../platform/index.ts";
import type { InterfaceUpdates, InterfaceUpdateState } from "../platform/types.ts";
import { useWorkspace } from "../state/workspace.tsx";

/** Updates of the app's interface from the connected server (plan/39). Only in the apps; null elsewhere. */
function useInterfaceUpdates(): { updates: InterfaceUpdates; state: InterfaceUpdateState } | null {
  const updates = platform.interfaceUpdates;
  const state = useSyncExternalStore(updates?.subscribe ?? noSubscribe, updates?.state ?? noState);
  return updates && state ? { updates, state } : null;
}
const noSubscribe = () => () => {};
const noState = () => null;

/** What the question is about; read when shown, since the platform is chosen after this module loads. */
const what = () => platform.desktop
  ? "The server can update the app's screens to match the PURSS it runs, without a new version of the app. That code runs in the app with your sign-in on this computer and can use what the app can (notifications, the downloads folder, starting when you sign in), so allow it only for a server you trust."
  : "The server can update the app's screens to match the PURSS it runs, without an update from the app store. That code runs in the app with your sign-in on this phone, so allow it only for a server you trust.";

/**
 * Asked once per server other than the official one, the first time it offers an update, after the first-visit
 * question has been answered. Closing the question counts as not allowing; Settings → This device can change it.
 */
export function InterfaceUpdateQuestion() {
  const u = useInterfaceUpdates();
  const ws = useWorkspace();
  if (!u?.state.asking || !ws.data.preferences.welcomeAsked || !platform.connection) return null;
  const answer = (allow: boolean) => void u.updates.answer(allow);
  return (
    <Dialog title="Let this server update the app?" size="sm" onClose={() => answer(false)}
      footer={<><Button onClick={() => answer(false)}>Don't allow</Button><Button variant="primary" onClick={() => answer(true)}>Allow updates</Button></>}>
      <p><b style={{ wordBreak: "break-all" }}>{platform.connection.origin}</b> offers an update of this app's screens.</p>
      <p className="fine">{what()} You can change this in Settings → This device.</p>
    </Dialog>
  );
}

/** Settings → This device, for a server other than the official one that has been asked about. */
export function InterfaceUpdatesSection() {
  const u = useInterfaceUpdates();
  if (!u || u.state.official || u.state.consent === null) return null;
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Updates of the app</legend>
      <Check checked={u.state.consent === "yes"} onChange={(v) => void u.updates.answer(v)} hint={`${what()} Turned off, the app goes back to the screens it was installed with the next time it starts.`}>
        Updates from this server
      </Check>
    </fieldset>
  );
}
