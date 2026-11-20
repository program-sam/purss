import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/copy/app";
import type { BasketDTO, UrlLookup } from "@purss/domain";
import { Button, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { get, messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { ManualKeepResult } from "../api/types.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

const t = app.dialogs.keepPage;

const NEW = "__new";

/** What keeping a link did, for the toast. */
export function keptMessage(out: ManualKeepResult, basketName: string, noun: "link" | "video" = "link"): string {
  const what = !out.existing ? t.kept(t.nouns[noun], basketName)
    : out.alreadyInBasket ? t.alreadyInBasket(basketName) : t.alreadyKept(basketName);
  return `${what}${out.captureNote ? t.captureNote(out.captureNote) : ""}`;
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
        if (!newBasket.trim()) { setError(t.nameBasketFirst); setBusy(false); return; }
        const b = await post<BasketDTO>("/api/baskets", { name: newBasket.trim(), captureMode: "metadata" });
        basketId = b.id; basketName = b.name;
      }
      const out = await post<ManualKeepResult>("/api/items/manual", { url, basketId, ...(title.trim() ? { title: title.trim() } : {}) });
      refreshWorkspace(qc);
      ov.close();
      toast(keptMessage(out, basketName), { actions: [{ label: t.open, onSelect: () => nav.go({ t: "b", id: basketId }, { item: out.itemId }) }] });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const footer = <><Button onClick={ov.close}>{t.cancel}</Button><Button variant="primary" disabled={busy || !url} onClick={keep}>{t.keep}</Button></>;
  return (
    <Dialog title={t.title} onClose={ov.close} footer={footer} initialFocus="#kp-b">
      {!url ? <p className="state note" role="alert"><Icon name="info" /><span>{t.cannotKeep}<b style={{ wordBreak: "break-all" }}>{raw}</b></span></p> : (
        <div style={{ display: "grid", gap: 14 }}>
          <p className="hint" style={{ wordBreak: "break-all" }}>{url}</p>
          <div aria-live="polite">
            {lookup.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{t.checking}</p> : null}
            {lookup.isError ? <p className="state note"><Icon name="info" /><span>{messageOf(lookup.error)}</span></p> : null}
            {have?.baskets.length ? <p className="state note"><Icon name="check" /><span>{t.alreadyKeptIn.before}{have.baskets.map((b) => b.name).join(", ")}{t.alreadyKeptIn.after}</span></p>
              : have ? <p className="fine">{t.alreadyHave}</p> : null}
            {lookup.data?.followedSources.length ? <p className="fine">{t.followedSources.before}{lookup.data.followedSources.map((s) => s.title).join(", ")}{t.followedSources.after}</p> : null}
          </div>
          <Field label={t.basket} htmlFor="kp-b">
            <SelectInput id="kp-b" value={basketChoice} onChange={(e) => setBasketChoice(e.target.value)}>
              {ws.data.baskets.map((b) => <option key={b.id} value={b.id}>{b.name}{have?.baskets.some((x) => x.id === b.id) ? t.alreadyThere : ""}</option>)}
              <option value={NEW}>{t.newBasket}</option>
            </SelectInput>
            {basketChoice === NEW ? <input className="in" placeholder={t.newBasketPlaceholder} aria-label="New basket name" value={newBasket} onChange={(e) => setNewBasket(e.target.value)} autoFocus /> : null}
          </Field>
          {have ? null : <Field label={t.titleOptional} htmlFor="kp-t"><TextInput id="kp-t" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoComplete="off" /></Field>}
          <p className="fine">{t.keepNote}</p>
          {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        </div>
      )}
    </Dialog>
  );
}
