import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImportPreview, ImportResult } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { fkeys } from "../shared/api.ts";
import { effects, inFile, resultLines } from "./import-summary.ts";

const t = app.data.importDialog;

/** Preview what an export file would change, then apply it. Nothing is written until the person confirms. */
export function ImportDialog({ preview, fileName, onClose }: { preview: ImportPreview; fileName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function apply() {
    setBusy(true); setError("");
    try {
      setResult(await post<ImportResult>("/api/import", { token: preview.token }));
      refreshWorkspace(qc);
      void qc.invalidateQueries({ queryKey: fkeys.shares });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  if (result) {
    return (
      <Dialog title={t.finishedTitle} size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{app.words.done}</Button>}>
        <ul className="fx-lines">{resultLines(result).map((l) => <li key={l}>{l}</li>)}</ul>
        {result.reconnectRequired ? <p className="fine">{t.reconnectLater}</p> : null}
      </Dialog>
    );
  }

  const rows = inFile(preview.counts);
  const lines = effects(preview.counts);
  return (
    <Dialog title={t.previewTitle} size="md" onClose={onClose} initialFocus=".dlg-f .btn.primary:not([disabled]),.dlg-f .btn"
      footer={<><Button onClick={onClose}>{app.words.cancel}</Button><Button variant="primary" disabled={busy || !preview.fits || preview.overPlan !== null} onClick={() => void apply()}>{busy ? t.importing : t.import}</Button></>}>
      <p className="hint"><b style={{ wordBreak: "break-all" }}>{fileName}</b>{t.isExport}</p>
      {rows.length ? (
        <dl className="fx-count-grid" aria-label="What the file holds">
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.n}</dd></div>)}
        </dl>
      ) : <p className="fine">{t.nothingToImport}</p>}
      {lines.length ? <ul className="fx-lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
      {preview.conflicts.length ? (
        <div className="field"><div className="lbl">{t.alreadyExists}</div>
          <ul className="fx-lines">{preview.conflicts.map((c) => <li key={c}>{c}</li>)}</ul></div>
      ) : null}
      {preview.overPlan || !preview.fits ? (
        <p className="state note" role="alert">
          <Icon name="alert" />
          <span>{preview.overPlan ?? t.tooLarge}{t.nothingImported}</span>
        </p>
      ) : null}
      {preview.omitted.length ? (
        <details className="fx-details"><summary>{t.leavesOut}</summary>
          <ul className="fx-lines">{preview.omitted.map((o) => <li key={o}>{o}</li>)}</ul></details>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
