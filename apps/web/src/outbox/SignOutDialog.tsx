import { Button, Dialog, Icon } from "@purss/ui";
import { plural } from "../lib/format.ts";
import type { SignOutChoice } from "./sign-out.ts";

/** Shown when signing out with changes that have not been sent. Closing it (Esc) means staying signed in. */
export function SignOutDialog({ count, failed, busy, onChoose }: { count: number; failed: boolean; busy: boolean; onChoose: (c: SignOutChoice) => void }) {
  return (
    <Dialog title="Some changes haven't been sent" size="sm" onClose={() => { if (!busy) onChoose("stay"); }} initialFocus=".dlg-f .btn.primary"
      footer={<><Button disabled={busy} onClick={() => onChoose("stay")}>Stay signed in</Button><Button variant="danger" disabled={busy} onClick={() => onChoose("discard")}>Discard them</Button><Button variant="primary" disabled={busy} onClick={() => onChoose("send")}>{busy ? "Sending…" : "Send them first"}</Button></>}>
      <p className="hint">{plural(count, "change")} you made {count === 1 ? "is" : "are"} still waiting to be sent to PURSS. They are kept on this device, so you can send them first or throw them away.</p>
      {failed ? <p className="state note" role="alert"><Icon name="info" /><span>They couldn't be sent just now; PURSS can't be reached. You can stay signed in and try again later, or discard them.</span></p> : null}
      <p className="fine">Discarded changes are gone for good. Nothing already saved in PURSS is touched.</p>
    </Dialog>
  );
}
