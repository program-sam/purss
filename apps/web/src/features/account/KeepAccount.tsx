import { useState } from "react";
import { app } from "@purss/copy/app";
import { Button, Icon } from "@purss/ui";
import { del, messageOf, post } from "../../api/client.ts";
import { shortDate } from "../../lib/format.ts";

const t = app.account.keepAccount;

/** Signed in during an account's deletion grace period: keep the account, or leave it to be deleted. */
export function KeepAccount({ dueAt, onKept, onLeft }: { dueAt: string; onKept: () => Promise<void>; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function keep() {
    setBusy(true); setError("");
    try { await post("/api/auth/deletion/cancel"); await onKept(); } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  async function leave() {
    setBusy(true);
    try { await del("/api/auth/deletion"); } catch { /* the chance to keep it expires by itself */ }
    onLeft();
  }
  return (
    <div style={{ display: "grid", gap: 14 }} role="region" aria-label="Your account is being deleted">
      <p className="p-warn"><Icon name="alert" /><span>{t.beingDeleted(shortDate(dueAt))}</span></p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <Button variant="primary" large disabled={busy} onClick={() => void keep()} style={{ width: "100%" }}>{t.keep}</Button>
      <Button disabled={busy} onClick={() => void leave()} style={{ width: "100%" }}>{t.leave}</Button>
      <p className="fine">{t.sharedPagesOff}</p>
    </div>
  );
}
