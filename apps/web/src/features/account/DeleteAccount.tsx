import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { app } from "@purss/copy/app";
import type { DeletionRequested } from "@purss/domain";
import { Button, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { wipeOfflineCopies } from "../../offline/worker-link.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { clearHints } from "../../state/ui-store.ts";
import { downloadFile } from "../shared/download.ts";
import { useStepUp } from "../shared/step-up.tsx";

const t = app.account.deleteAccount;

/** What the owner types to confirm: the display name, or the word "delete" for an account without one (as the server checks). */
export const confirmWord = (displayName: string | null | undefined): string => displayName?.trim() || "delete";

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ov = useOverlays();
  const stepUp = useStepUp({ returnTo: "/?dialog=account" });
  const word = confirmWord(useSession().data?.account?.displayName);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [exported, setExported] = useState(false);

  async function exportFirst() {
    setExporting(true); setError("");
    try { await downloadFile("/api/export", "purss-export.json"); setExported(true); } catch (err) { setError(messageOf(err)); } finally { setExporting(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<DeletionRequested>("/api/account/deletion", { confirm: typed }));
      if (!out) { setBusy(false); return; }
      // Signed out everywhere: nothing of PURSS stays on this device.
      await wipeOfflineCopies();
      clearHints();
      qc.clear();
      ov.close();
      void navigate({ to: "/signin", search: { notice: "deletion_requested", due: out.dueAt } });
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <>
      <Dialog title={t.dialogTitle} size="sm" onClose={onClose} initialFocus="#da-confirm"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant="danger" disabled={busy || typed.trim() !== word} onClick={() => void remove()}>{busy ? t.deleting : t.deleteAccount}</Button></>}>
        <p className="hint">{t.afterSevenDays}</p>
        <p className="fine">{t.signedOutEverywhere}</p>
        <div className="field">
          <p className="fine">{t.copyFirst}</p>
          <div><Button disabled={exporting} onClick={() => void exportFirst()}><Icon name="download" size="sm" />{exporting ? t.preparing : exported ? t.exportAgain : t.exportFirst}</Button></div>
        </div>
        <Field label={word === "delete" ? t.typeDelete : t.typeName(word)} htmlFor="da-confirm">
          <TextInput id="da-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" />
        </Field>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/** Settings → Account: deleting the account, with a grace period and an export offered first. */
export function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const selfHosted = useSession().data?.installation.mode === "self";
  return (
    <section className="field" aria-labelledby="acct-del">
      <div className="lbl" id="acct-del">{t.section.label}</div>
      <p className="fine">{t.section.hint}{selfHosted ? t.section.lastAdministrator : ""}</p>
      <div><Button variant="danger" onClick={() => setOpen(true)}>{t.section.button}</Button></div>
      {open ? <DeleteAccountDialog onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
