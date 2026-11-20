import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/copy/app";
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

const t = app.dialogs.items;

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
    <Dialog title={t.keepIn.title} size="sm" onClose={ov.close} footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" disabled={!chosen.length || busy} onClick={go}>{app.words.keep}</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.keepIn.legend.before}{plural(itemIds.length, app.words.item)}{t.keepIn.legend.after}</legend>
        {ws.data.baskets.length ? (
          <div className="radiolist">
            {ws.data.baskets.map((b) => (
              <label key={b.id} className="rl">
                <input type="checkbox" checked={chosen.includes(b.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id))} />
                <span className="cb" aria-hidden="true"><Icon name="check" /></span><span>{b.name}</span>
                {b.captureMode === "text" ? <span className="where">{t.keepIn.readableText}</span> : null}
              </label>
            ))}
          </div>
        ) : <p className="fine">{t.keepIn.noBasket.before}<button type="button" className="link" onClick={() => ov.open({ kind: "basket-form" })}>{t.keepIn.noBasket.link}</button>{t.keepIn.noBasket.after}</p>}
      </fieldset>
      <p className="fine">{t.keepIn.note}</p>
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
      toast(t.deleteItems.deleted(plural(out.deleted, app.words.item), out.releasedBytes ? t.deleteItems.freed(bytesLabel(out.releasedBytes)) : "").trim());
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={t.deleteItems.title(plural(itemIds.length, app.words.item))} size="sm" onClose={ov.close} initialFocus=".dlg-f .btn"
      footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="danger" disabled={!p || busy || (needsAck && !ack)} onClick={go}>{t.deleteItems.deletePermanently}</Button></>}>
      {preview.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{t.deleteItems.checking}</p> : null}
      {preview.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(preview.error)}</span></p> : null}
      {p ? (
        <>
          <p className="hint">{t.deleteItems.releases(bytesLabel(p.releasesBytes))}</p>
          {p.keptItems.length ? (
            <div className="p-warn" role="group" aria-label="Kept items">
              <Icon name="alert" />
              <span style={{ display: "grid", gap: 6 }}>
                <b>{t.deleteItems.keptHeading(plural(p.keptItems.length, t.deleteItems.keptIsAre.one, t.deleteItems.keptIsAre.many))}</b>
                <span>{t.deleteItems.keptRemoves}</span>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "grid", gap: 3 }}>
                  {p.keptItems.slice(0, 8).map((k) => <li key={k.id}><b>{k.title}</b> <span className="fine">{t.deleteItems.inBaskets(k.baskets.join(", "))}</span></li>)}
                  {p.keptItems.length > 8 ? <li className="fine">{t.deleteItems.andMore(p.keptItems.length - 8)}</li> : null}
                </ul>
              </span>
            </div>
          ) : null}
          {p.annotatedItems.length ? (
            <div className="p-warn" role="group" aria-label="Items with your notes">
              <Icon name="alert" />
              <span style={{ display: "grid", gap: 6 }}>
                <b>{t.deleteItems.notesHeading(plural(p.annotatedItems.length, t.deleteItems.hasHave.one, t.deleteItems.hasHave.many))}</b>
                <span>{t.deleteItems.notesRemoves(plural(notes, app.words.highlightOrNote, app.words.highlightsAndNotes))}</span>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "grid", gap: 3 }}>
                  {p.annotatedItems.slice(0, 8).map((k) => <li key={k.id}><b>{k.title}</b> <span className="fine">{plural(k.annotations, app.words.highlightOrNote, app.words.highlightsAndNotes)}</span></li>)}
                  {p.annotatedItems.length > 8 ? <li className="fine">{t.deleteItems.andMore(p.annotatedItems.length - 8)}</li> : null}
                </ul>
              </span>
            </div>
          ) : null}
          {needsAck ? (
            <Check checked={ack} onChange={setAck}>
              {p.keptItems.length && p.annotatedItems.length ? t.deleteItems.ackBoth
                : p.keptItems.length ? t.deleteItems.ackKept : t.deleteItems.ackNotes}
            </Check>
          ) : null}
        </>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
