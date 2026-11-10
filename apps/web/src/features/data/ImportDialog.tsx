import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImportPreview, ImportResult } from "@purss/domain";
import { Button, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { fkeys } from "../shared/api.ts";
import { effects, inFile, resultLines } from "./import-summary.ts";

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
      <Dialog title="Import finished" size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <ul className="fx-lines">{resultLines(result).map((l) => <li key={l}>{l}</li>)}</ul>
        {result.reconnectRequired ? <p className="fine">Reconnect private sources further down this page, by pasting each source's link again.</p> : null}
      </Dialog>
    );
  }

  const rows = inFile(preview.counts);
  const lines = effects(preview.counts);
  return (
    <Dialog title="Import preview" size="md" onClose={onClose} initialFocus=".dlg-f .btn.primary:not([disabled]),.dlg-f .btn"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !preview.fits || preview.overPlan !== null} onClick={() => void apply()}>{busy ? "Importing…" : "Import"}</Button></>}>
      <p className="hint"><b style={{ wordBreak: "break-all" }}>{fileName}</b> is a PURSS export. Nothing has been imported yet, and nothing here is ever deleted by an import.</p>
      {rows.length ? (
        <dl className="fx-count-grid" aria-label="What the file holds">
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.n}</dd></div>)}
        </dl>
      ) : <p className="fine">The file doesn't contain anything to import.</p>}
      {lines.length ? <ul className="fx-lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
      {preview.conflicts.length ? (
        <div className="field"><div className="lbl">What already exists here</div>
          <ul className="fx-lines">{preview.conflicts.map((c) => <li key={c}>{c}</li>)}</ul></div>
      ) : null}
      {preview.overPlan || !preview.fits ? (
        <p className="state note" role="alert">
          <Icon name="alert" />
          <span>{preview.overPlan ?? "This export is larger than the space this PURSS has left."} Nothing was imported and nothing was changed.</span>
        </p>
      ) : null}
      {preview.omitted.length ? (
        <details className="fx-details"><summary>What the file leaves out</summary>
          <ul className="fx-lines">{preview.omitted.map((o) => <li key={o}>{o}</li>)}</ul></details>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
