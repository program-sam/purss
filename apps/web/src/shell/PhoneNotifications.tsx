import { useCallback, useEffect, useState } from "react";
import { Button, Check, Icon } from "@purss/ui";
import { messageOf } from "../api/client.ts";
import { platform } from "../platform/index.ts";
import type { PushStatus } from "../platform/types.ts";

/** Notifications on this phone (plan/37): its status, and turning them on or off. Only in the apps. */
export function usePhonePush() {
  const push = platform.push;
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!push) return;
    let live = true;
    push.status().then((s) => { if (live) setStatus(s); }, (e: unknown) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [push]);
  const set = useCallback(async (on: boolean): Promise<boolean> => {
    if (!push) return false;
    setBusy(true);
    setError(null);
    try { setStatus(await (on ? push.enable() : push.disable())); return true; } catch (e) { setError(messageOf(e)); return false; } finally { setBusy(false); }
  }, [push]);
  return { available: !!push, status, busy, error, set };
}

const OFFER_KEY = "purss:push-offer";

/** Settings → This device: the switch, with what it does and what others learn. */
export function PhoneNotificationsSection() {
  const p = usePhonePush();
  if (!p.available) return null;
  const s = p.status;
  const blocked = s?.state === "unavailable";
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Notifications on this phone</legend>
      <Check checked={s?.state === "on"} disabled={!s || p.busy || blocked} onChange={(v) => void p.set(v)}
        hint="When something new reaches the bell, following your notification settings and quiet hours. The phone asks your PURSS for the text; Google or Apple only pass on that there is something new.">
        Notifications on this phone
      </Check>
      {s?.detail ? <p className="state note"><Icon name="info" /><span>{s.detail}</span></p> : null}
      {p.error ? <p className="state note" role="alert"><Icon name="info" /><span>{p.error}</span></p> : null}
    </fieldset>
  );
}

/** In the bell, in the apps: a one-time offer to have these on the phone too. Turning it on brings the system's prompt. */
export function PhoneNotificationsOffer() {
  const p = usePhonePush();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(OFFER_KEY) !== null; } catch { return true; } });
  if (!p.available || dismissed || p.status?.state !== "off") return null;
  const dismiss = () => { try { localStorage.setItem(OFFER_KEY, "1"); } catch { /* shown again next time */ } setDismissed(true); };
  return (
    <div className="fine" style={{ padding: "8px 12px", display: "grid", gap: 6 }}>
      <span>Get these as notifications on this phone too?</span>
      {p.error ? <span role="alert">{p.error}</span> : null}
      <div className="fx-acts-row">
        <Button variant="primary" disabled={p.busy} onClick={() => void p.set(true).then((done) => { if (done) dismiss(); })}>Turn on</Button>
        <Button onClick={dismiss}>Not now</Button>
      </div>
    </div>
  );
}
