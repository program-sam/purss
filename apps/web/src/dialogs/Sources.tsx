import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import type { SourceDTO } from "@purss/domain";
import { Avatar, Button, Check, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, messageOf, patch } from "../api/client.ts";
import { putSource, refreshPurss } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import type { UnfollowResult } from "../api/types.ts";
import { plural } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { usePurss } from "../state/purss.tsx";

const t = app.dialogs.sources;

/** Give a source a name of your own (feeds often have long or generic titles). */
export function RenameSourceDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = usePurss();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const s = ws.sourceById.get(id);
  const [title, setTitle] = useState(s?.title ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const before = s.title;
  async function save() {
    const next = title.trim();
    if (!next || next === before) { ov.close(); return; }
    setBusy(true); setError("");
    try {
      putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { title: next }));
      refreshPurss(qc);
      ov.close();
      toast(t.rename.renamed(isolate(next)), { undo: async () => { putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { title: before })); refreshPurss(qc); } });
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <Dialog title={t.rename.title} size="sm" onClose={ov.close} initialFocus="#rn-title"
      footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" type="submit" form="rn-form" disabled={busy || !title.trim()}>{app.words.save}</Button></>}>
      <form id="rn-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label={app.words.name} htmlFor="rn-title" hint={app.words.onlyYouSeeIt}>
          <TextInput id="rn-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
      </form>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

/** Choose the collections a source belongs to. A source may be in several, or none. */
export function MoveSourceDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = usePurss();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const s = ws.sourceById.get(id);
  const [ids, setIds] = useState<string[]>(s?.collectionIds ?? []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const options = ws.collections.filter((c) => c.mode === "sources");

  async function save() {
    if (!s) return;
    setBusy(true); setError("");
    try {
      putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { collectionIds: ids }));
      refreshPurss(qc);
      ov.close();
      const before = s.collectionIds;
      toast(ids.length ? t.move.isIn(isolate(s.title), ids.map((c) => ws.collectionById.get(c)?.name).filter((n): n is string => !!n).map(isolate).join(", ")) : t.move.noLonger(isolate(s.title)), {
        undo: async () => { putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { collectionIds: before })); refreshPurss(qc); },
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog title={t.move.title} size="sm" onClose={ov.close} footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" disabled={busy} onClick={save}>{app.words.save}</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}><Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={20} /> {s.title}</legend>
        {options.length ? (
          <div className="radiolist">
            {options.map((c) => {
              const on = ids.includes(c.id);
              return (
                <label key={c.id} className="rl">
                  <input type="checkbox" checked={on} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
                  <span className="cb" aria-hidden="true"><Icon name="check" /></span><span>{c.name}</span>
                  {s.collectionIds.includes(c.id) ? <span className="where">{app.words.current}</span> : null}
                </label>
              );
            })}
          </div>
        ) : <p className="fine">{t.move.none}</p>}
        <p className="fine">{t.move.note}</p>
      </fieldset>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

export function UnfollowDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = usePurss();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const s = ws.sourceById.get(id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteUnkept, setDeleteUnkept] = useState(false);
  if (!s) return null;

  async function go() {
    if (!s) return;
    setBusy(true); setError("");
    try {
      const out = await del<UnfollowResult>(`/api/sources/${encodeURIComponent(id)}${deleteUnkept ? "?deleteUnkept=1" : ""}`);
      refreshPurss(qc);
      ov.close();
      nav.go(s.collectionIds[0] ? { t: "c", id: s.collectionIds[0] } : { t: "home" });
      toast(`${t.unfollow.unfollowed(isolate(s.title))}${out.deletedItems ? t.unfollow.deletedUnkept(plural(out.deletedItems, app.words.item)) : ""}${out.keptItems ? t.unfollow.keptStay(plural(out.keptItems, app.words.keptItem)) : ""}`);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={t.unfollow.title(isolate(s.title))} size="sm" onClose={ov.close} initialFocus=".dlg-f .btn"
      footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="danger" disabled={busy} onClick={go}>{t.unfollow.unfollow}</Button></>}>
      <p className="hint">{t.unfollow.hint}</p>
      <Check checked={deleteUnkept} onChange={setDeleteUnkept} hint={t.unfollow.deleteHint}>{t.unfollow.alsoDelete}</Check>
      <p className="fine">{t.unfollow.followAgain}</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
