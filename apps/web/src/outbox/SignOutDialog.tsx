import { app } from "@purss/translations/app";
import { Button, Dialog, Icon } from "@purss/ui";
import { plural } from "../lib/format.ts";
import type { SignOutChoice } from "./sign-out.ts";

const t = app.outbox.signOutDialog;

/** Shown when signing out with changes that have not been sent. Closing it (Esc) means staying signed in. */
export function SignOutDialog({ count, failed, busy, onChoose }: { count: number; failed: boolean; busy: boolean; onChoose: (c: SignOutChoice) => void }) {
  return (
    <Dialog title={t.title} size="sm" onClose={() => { if (!busy) onChoose("stay"); }} initialFocus=".dlg-f .btn.primary"
      footer={<><Button disabled={busy} onClick={() => onChoose("stay")}>{t.stay}</Button><Button variant="danger" disabled={busy} onClick={() => onChoose("discard")}>{t.discard}</Button><Button variant="primary" disabled={busy} onClick={() => onChoose("send")}>{busy ? app.words.sending : t.sendFirst}</Button></>}>
      <p className="hint">{t.waiting(plural(count, app.words.change), count === 1 ? app.words.is : app.words.are)}</p>
      {failed ? <p className="state note" role="alert"><Icon name="info" /><span>{t.failed}</span></p> : null}
      <p className="fine">{t.note}</p>
    </Dialog>
  );
}
