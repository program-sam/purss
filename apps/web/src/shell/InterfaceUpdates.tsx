import { app } from "@purss/translations/app";
import { useSyncExternalStore } from "react";
import { Button, Check, Dialog } from "@purss/ui";
import { platform } from "../platform/index.ts";
import type { InterfaceUpdates, InterfaceUpdateState } from "../platform/types.ts";
import { usePurss } from "../state/purss.tsx";

const t = app.shell.interfaceUpdates;

/** Updates of the app's interface from the connected server. Only in the apps; null elsewhere. */
function useInterfaceUpdates(): { updates: InterfaceUpdates; state: InterfaceUpdateState } | null {
  const updates = platform.interfaceUpdates;
  const state = useSyncExternalStore(updates?.subscribe ?? noSubscribe, updates?.state ?? noState);
  return updates && state ? { updates, state } : null;
}
const noSubscribe = () => () => {};
const noState = () => null;

/** What the question is about; read when shown, since the platform is chosen after this module loads. */
const what = () => platform.connection?.device === "computer" ? t.whatDesktop : t.whatPhone;

/**
 * Asked once per server other than the official one, the first time it offers an update, after the first-visit
 * question has been answered. Closing the question counts as not allowing; Settings → This device can change it.
 */
export function InterfaceUpdateQuestion() {
  const u = useInterfaceUpdates();
  const ws = usePurss();
  if (!u?.state.asking || !ws.data.preferences.welcomeAsked || !platform.connection) return null;
  const answer = (allow: boolean) => void u.updates.answer(allow);
  return (
    <Dialog title={t.title} size="sm" onClose={() => answer(false)}
      footer={<><Button onClick={() => answer(false)}>{app.words.donTAllow}</Button><Button variant="primary" onClick={() => answer(true)}>{t.allow}</Button></>}>
      <p><b style={{ wordBreak: "break-all" }}>{platform.connection.origin}</b>{t.offers}</p>
      <p className="fine">{what()}{t.changeInSettings}</p>
    </Dialog>
  );
}

/** Settings → This device, for a server other than the official one that has been asked about. */
export function InterfaceUpdatesSection() {
  const u = useInterfaceUpdates();
  if (!u || u.state.official || u.state.consent === null) return null;
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.legend}</legend>
      <Check checked={u.state.consent === "yes"} onChange={(v) => void u.updates.answer(v)} hint={t.hint(what())}>
        {t.label}
      </Check>
    </fieldset>
  );
}
