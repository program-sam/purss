import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeletePreview } from "@purss/domain";
import { Button, Check, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { DeleteResult } from "../api/types.ts";
import { bytesLabel, plural } from "../lib/format.ts";
import { useItemActions } from "../state/actions.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useSelection } from "../state/selection.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

/** Keep several items in one or more baskets at once. */
export function KeepInDialog({ itemIds }: { itemIds: string[] }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const actions = useItemActions();
  const sel = useSelection();
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    await actions.keepMany(itemIds, chosen);
    sel.clear();
    ov.close();
  }
  return (
    <Dialog title="Keep in a basket" size="sm" onClose={ov.close} footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={!chosen.length || busy} onClick={go}>Keep</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Keep {plural(itemIds.length, "item")} in</legend>
        {ws.data.baskets.length ? (
          <div className="radiolist">
            {ws.data.baskets.map((b) => (
              <label key={b.id} className="rl">
                <input type="checkbox" checked={chosen.includes(b.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id))} />
                <span className="cb" aria-hidden="true"><Icon name="check" /></span><span>{b.name}</span>
                {b.captureMode === "text" ? <span className="where">Readable text</span> : null}
              </label>
            ))}
          </div>
        ) : <p className="fine">You don't have a basket yet. <button type="button" className="link" onClick={() => ov.open({ kind: "basket-form" })}>Create one</button> first.</p>}
      </fieldset>
      <p className="fine">Keeping saves the link, title and summary. The original page may change or disappear.</p>
    </Dialog>
  );
}

/** Permanent deletion: shows what goes, names the baskets for kept items, and needs an explicit tick for those. */
export function DeleteItemsDialog({ itemIds }: { itemIds: string[] }) {
  const ov = useOverlays();
  const qc = useQueryClient();
  const sel = useSelection();
  const { toast } = useToasts();
  const preview = useQuery({ queryKey: ["delete-preview", itemIds], queryFn: () => post<DeletePreview>("/api/items/delete-preview", { itemIds }), gcTime: 0, staleTime: 0 });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const p = preview.data;
  const needsAck = !!p && (p.keptItems.length > 0 || p.annotatedItems.length > 0);
  const notes = p?.annotatedItems.reduce((n, a) => n + a.annotations, 0) ?? 0;

  async function go() {
    if (!p) return;
    setBusy(true); setError("");
    try {
      const out = await post<DeleteResult>("/api/items/delete", { confirmToken: p.confirmToken });
      refreshWorkspace(qc);
      sel.clear();
      ov.close();
      toast(`Deleted ${plural(out.deleted, "item")}. ${out.releasedBytes ? `${bytesLabel(out.releasedBytes)} freed.` : ""}`.trim());
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={`Delete ${plural(itemIds.length, "item")} permanently?`} size="sm" onClose={ov.close} initialFocus=".dlg-f .btn"
      footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="danger" disabled={!p || busy || (needsAck && !ack)} onClick={go}>Delete permanently</Button></>}>
      {preview.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Checking what this removes…</p> : null}
      {preview.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(preview.error)}</span></p> : null}
      {p ? (
        <>
          <p className="hint">This deletes your copy and frees about {bytesLabel(p.releasesBytes)}. It can't be undone.</p>
          {p.keptItems.length ? (
            <div className="p-warn" role="group" aria-label="Kept items">
              <Icon name="alert" />
              <span style={{ display: "grid", gap: 6 }}>
                <b>{plural(p.keptItems.length, "of these items is", "of these items are")} kept in a basket</b>
                <span>Deleting removes the kept copy too:</span>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "grid", gap: 3 }}>
                  {p.keptItems.slice(0, 8).map((k) => <li key={k.id}><b>{k.title}</b> <span className="fine">in {k.baskets.join(", ")}</span></li>)}
                  {p.keptItems.length > 8 ? <li className="fine">and {p.keptItems.length - 8} more</li> : null}
                </ul>
              </span>
            </div>
          ) : null}
          {p.annotatedItems.length ? (
            <div className="p-warn" role="group" aria-label="Items with your notes">
              <Icon name="alert" />
              <span style={{ display: "grid", gap: 6 }}>
                <b>{plural(p.annotatedItems.length, "of these items has", "of these items have")} your highlights or notes</b>
                <span>Deleting removes {plural(notes, "highlight or note", "highlights and notes")} you wrote:</span>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "grid", gap: 3 }}>
                  {p.annotatedItems.slice(0, 8).map((k) => <li key={k.id}><b>{k.title}</b> <span className="fine">{plural(k.annotations, "highlight or note", "highlights and notes")}</span></li>)}
                  {p.annotatedItems.length > 8 ? <li className="fine">and {p.annotatedItems.length - 8} more</li> : null}
                </ul>
              </span>
            </div>
          ) : null}
          {needsAck ? (
            <Check checked={ack} onChange={setAck}>
              {p.keptItems.length && p.annotatedItems.length ? "I understand kept items will be removed from their baskets and my highlights and notes will be deleted"
                : p.keptItems.length ? "I understand kept items will be removed from their baskets" : "I understand my highlights and notes on these items will be deleted"}
            </Check>
          ) : null}
        </>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
