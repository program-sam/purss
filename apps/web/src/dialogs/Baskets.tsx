import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BasketDTO } from "@purss/domain";
import { Button, Dialog, Icon, TextInput } from "@purss/ui";
import { messageOf, patch, post, put } from "../api/client.ts";
import type { BasketDeletePreview, KeepResult } from "../api/types.ts";
import { keys, putBasket, putItem, refreshWorkspace } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import { plural } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

const MODES: { value: BasketDTO["captureMode"]; label: string; blurb: string }[] = [
  { value: "metadata", label: "Keep link and summary", blurb: "Keeps the link, title and summary. No copy of the page text." },
  { value: "text", label: "Keep readable text too", blurb: "Keeps the link, title and summary, plus the page's readable text if it can be fetched when you keep the item." },
];

/** Create a basket, or change its name and what it saves. Opened from an item's keep controls, the new basket keeps that item. */
export function BasketFormDialog({ id, keepItemId }: { id?: string; keepItemId?: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const existing = id ? ws.basketById.get(id) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [mode, setMode] = useState<BasketDTO["captureMode"]>(existing?.captureMode ?? "metadata");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError("");
    try {
      if (existing) {
        await patch(`/api/baskets/${encodeURIComponent(existing.id)}`, { name: name.trim(), captureMode: mode });
        refreshWorkspace(qc);
        ov.close();
        toast("Saved basket settings", { undo: async () => { await patch(`/api/baskets/${encodeURIComponent(existing.id)}`, { name: existing.name, captureMode: existing.captureMode }); refreshWorkspace(qc); } });
      } else {
        const b = await post<BasketDTO>("/api/baskets", { name: name.trim(), captureMode: mode });
        putBasket(qc, b);
        ov.close();
        const open = { actions: [{ label: "Open", onSelect: () => nav.go({ t: "b", id: b.id }) }] };
        if (!keepItemId) {
          refreshWorkspace(qc, { items: false });
          toast(`Created the basket ${isolate(b.name)}`, open);
          return;
        }
        try {
          const out = await put<KeepResult>(`/api/items/${encodeURIComponent(keepItemId)}/baskets/${encodeURIComponent(b.id)}`);
          // The item shows as kept straight away, without waiting for the lists to be fetched again.
          putItem(qc, out.item);
          void qc.invalidateQueries({ queryKey: keys.item(keepItemId) });
          toast(`Created ${isolate(b.name)} and kept the item in it${out.captureNote ? `. ${out.captureNote}` : ""}`, open);
        } catch (err) {
          toast(`Created ${isolate(b.name)}, but the item couldn't be kept in it: ${messageOf(err)}`, { tone: "error", ...open });
        } finally { refreshWorkspace(qc); }
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog title={existing ? "Basket settings" : "New basket"} size="sm" onClose={ov.close} initialFocus="#bk-name"
      footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={submit}>{existing ? "Save changes" : "Create basket"}</Button></>}>
      <div className="field"><label htmlFor="bk-name">Name</label>
        <TextInput id="bk-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" placeholder="Weekend reading, Thesis references"
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) void submit(); }} /></div>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>What this basket saves</legend>
        <div className="radiolist">
          {MODES.map((m) => (
            <label key={m.value} className="rl" style={{ alignItems: "flex-start", padding: "10px" }}>
              <input type="radio" name="bk-mode" checked={mode === m.value} onChange={() => setMode(m.value)} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{m.label}</span><span className="fine">{m.blurb}</span></span>
            </label>
          ))}
        </div>
        {keepItemId && !existing ? <p className="fine">The item you chose is kept in this basket once it's created.</p> : null}
        <p className="fine">Pictures aren't saved. They load from the original site and can disappear if the site removes them.</p>
        <p className="fine">The original page may change or disappear. A basket doesn't guarantee the page stays available.{existing ? " Changes apply to items you keep from now on." : ""}</p>
      </fieldset>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

/** Deleting a basket shows what it holds first, and what is kept nowhere else. */
export function BasketDeleteDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const basket = ws.basketById.get(id);
  const preview = useQuery({ queryKey: ["basket-delete-preview", id], queryFn: () => post<BasketDeletePreview>(`/api/baskets/${encodeURIComponent(id)}/delete-preview`), gcTime: 0, staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!basket) return null;

  async function confirm() {
    if (!preview.data) return;
    setBusy(true); setError("");
    try {
      await post(`/api/baskets/${encodeURIComponent(id)}/delete`, { confirmToken: preview.data.confirmToken });
      refreshWorkspace(qc);
      ov.close();
      nav.go({ t: "home" });
      toast(`Deleted the basket ${isolate(basket!.name)}`);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  const p = preview.data;
  return (
    <Dialog title={`Delete ${basket.name}?`} size="sm" onClose={ov.close}
      footer={<><Button onClick={ov.close}>Keep the basket</Button><Button variant="danger" disabled={!p || busy} onClick={confirm}>Delete basket</Button></>}>
      {preview.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Checking what's inside…</p> : null}
      {preview.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(preview.error)}</span></p> : null}
      {p ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p className="hint">This basket holds {plural(p.items, "item")}. Deleting it removes the basket. The items stay in your PURSS.</p>
          <p className="hint">{p.onlyHere > 0
            ? <>{plural(p.onlyHere, "item")} {p.onlyHere === 1 ? "is" : "are"} kept in no other basket. {p.onlyHere === 1 ? "It loses its" : "They lose their"} protection, so a later clean-up of old items could remove {p.onlyHere === 1 ? "it" : "them"}.</>
            : "Everything in it is also kept in another basket, so nothing loses its protection."}</p>
        </div>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
