import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BasketDTO, UrlLookup } from "@purss/domain";
import { Button, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { get, messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { ManualKeepResult } from "../api/types.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

const NEW = "__new";

/** What keeping a link did, for the toast. */
export function keptMessage(out: ManualKeepResult, basketName: string, noun: "link" | "video" = "link"): string {
  const what = !out.existing ? `Kept the ${noun} in ${basketName}`
    : out.alreadyInBasket ? `You already had this page in ${basketName}` : `You already had this page; kept it in ${basketName}`;
  return `${what}${out.captureNote ? `. ${out.captureNote}` : ""}`;
}

const webAddress = (raw: string): string | null => {
  try { const u = new URL(raw); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
};

/**
 * Keep a page handed over by a deep link (?dialog=keep&url=…&title=…, from the browser extension or the
 * "Keep this page" bookmarklet) or shared into the phone apps. Nothing is kept until the person picks a basket and confirms; checking
 * what PURSS already has reads only PURSS, never the page.
 */
export function KeepPageDialog({ url: raw, title: initialTitle }: { url: string; title?: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const url = webAddress(raw);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [basketChoice, setBasketChoice] = useState<string>(ws.data.baskets[0]?.id ?? NEW);
  const [newBasket, setNewBasket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lookup = useQuery({ queryKey: ["url-lookup", url], queryFn: () => get<UrlLookup>("/api/items/lookup", { url: url! }), enabled: !!url, staleTime: 0, gcTime: 0 });
  const have = lookup.data?.item;

  async function keep() {
    if (!url) return;
    setBusy(true); setError("");
    try {
      let basketId = basketChoice;
      let basketName = ws.basketById.get(basketChoice)?.name ?? "";
      if (basketChoice === NEW) {
        if (!newBasket.trim()) { setError("Name the new basket first."); setBusy(false); return; }
        const b = await post<BasketDTO>("/api/baskets", { name: newBasket.trim(), captureMode: "metadata" });
        basketId = b.id; basketName = b.name;
      }
      const out = await post<ManualKeepResult>("/api/items/manual", { url, basketId, ...(title.trim() ? { title: title.trim() } : {}) });
      refreshWorkspace(qc);
      ov.close();
      toast(keptMessage(out, basketName), { actions: [{ label: "Open", onSelect: () => nav.go({ t: "b", id: basketId }, { item: out.itemId }) }] });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const footer = <><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={busy || !url} onClick={keep}>Keep</Button></>;
  return (
    <Dialog title="Keep this page" onClose={ov.close} footer={footer} initialFocus="#kp-b">
      {!url ? <p className="state note" role="alert"><Icon name="info" /><span>That link can't be kept: <b style={{ wordBreak: "break-all" }}>{raw}</b></span></p> : (
        <div style={{ display: "grid", gap: 14 }}>
          <p className="hint" style={{ wordBreak: "break-all" }}>{url}</p>
          <div aria-live="polite">
            {lookup.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Checking your PURSS…</p> : null}
            {lookup.isError ? <p className="state note"><Icon name="info" /><span>{messageOf(lookup.error)}</span></p> : null}
            {have?.baskets.length ? <p className="state note"><Icon name="check" /><span>Already kept in {have.baskets.map((b) => b.name).join(", ")}.</span></p>
              : have ? <p className="fine">This page is already in your PURSS. Keeping it keeps that copy.</p> : null}
            {lookup.data?.followedSources.length ? <p className="fine">You follow {lookup.data.followedSources.map((s) => s.title).join(", ")}, which publishes on this site.</p> : null}
          </div>
          <Field label="Basket" htmlFor="kp-b">
            <SelectInput id="kp-b" value={basketChoice} onChange={(e) => setBasketChoice(e.target.value)}>
              {ws.data.baskets.map((b) => <option key={b.id} value={b.id}>{b.name}{have?.baskets.some((x) => x.id === b.id) ? " (already there)" : ""}</option>)}
              <option value={NEW}>New basket…</option>
            </SelectInput>
            {basketChoice === NEW ? <input className="in" placeholder="Name your basket" aria-label="New basket name" value={newBasket} onChange={(e) => setNewBasket(e.target.value)} autoFocus /> : null}
          </Field>
          {have ? null : <Field label="Title (optional)" htmlFor="kp-t"><TextInput id="kp-t" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoComplete="off" /></Field>}
          <p className="fine">Keeping saves the link and its title. The original page may change or disappear.</p>
          {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        </div>
      )}
    </Dialog>
  );
}
