import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SourceDTO } from "@purss/domain";
import { Avatar, Button, Check, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, messageOf, patch } from "../api/client.ts";
import { putSource, refreshWorkspace } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import type { UnfollowResult } from "../api/types.ts";
import { plural } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

/** Give a source a name of your own (feeds often have long or generic titles). */
export function RenameSourceDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
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
      refreshWorkspace(qc);
      ov.close();
      toast(`Renamed to ${isolate(next)}`, { undo: async () => { putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { title: before })); refreshWorkspace(qc); } });
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <Dialog title="Rename source" size="sm" onClose={ov.close} initialFocus="#rn-title"
      footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="primary" type="submit" form="rn-form" disabled={busy || !title.trim()}>Save</Button></>}>
      <form id="rn-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" htmlFor="rn-title" hint="Only changes the name you see. The feed is unchanged.">
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
  const ws = useWorkspace();
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
      refreshWorkspace(qc);
      ov.close();
      const before = s.collectionIds;
      toast(ids.length ? `${isolate(s.title)} is in ${ids.map((c) => ws.collectionById.get(c)?.name).filter((n): n is string => !!n).map(isolate).join(", ")}` : `${isolate(s.title)} is no longer in a collection`, {
        undo: async () => { putSource(qc, await patch<SourceDTO>(`/api/sources/${encodeURIComponent(id)}`, { collectionIds: before })); refreshWorkspace(qc); },
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog title="Collections for this source" size="sm" onClose={ov.close} footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>Save</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}><Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={20} /> {s.title}</legend>
        {options.length ? (
          <div className="radiolist">
            {options.map((c) => {
              const on = ids.includes(c.id);
              return (
                <label key={c.id} className="rl">
                  <input type="checkbox" checked={on} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
                  <span className="cb" aria-hidden="true"><Icon name="check" /></span><span>{c.name}</span>
                  {s.collectionIds.includes(c.id) ? <span className="where">Current</span> : null}
                </label>
              );
            })}
          </div>
        ) : <p className="fine">You have no collections that group sources yet. Create one from the sidebar.</p>}
        <p className="fine">A source can be in several collections, or none. You follow it either way.</p>
      </fieldset>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

export function UnfollowDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
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
      refreshWorkspace(qc);
      ov.close();
      nav.go(s.collectionIds[0] ? { t: "c", id: s.collectionIds[0] } : { t: "home" });
      toast(`Unfollowed ${isolate(s.title)}.${out.deletedItems ? ` Deleted ${plural(out.deletedItems, "item")} you hadn't kept.` : ""}${out.keptItems ? ` ${plural(out.keptItems, "kept item")} stay in your baskets.` : ""}`);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={`Unfollow ${isolate(s.title)}?`} size="sm" onClose={ov.close} initialFocus=".dlg-f .btn"
      footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="danger" disabled={busy} onClick={go}>Unfollow</Button></>}>
      <p className="hint">You'll get no new items, and the source leaves your collections. Kept items stay in their baskets. Items with your highlights or notes stay findable. All other items disappear from your lists and search.</p>
      <Check checked={deleteUnkept} onChange={setDeleteUnkept} hint="Frees storage. This can't be undone. Kept items, shared items and items with your highlights or notes are never deleted.">Also delete the items you haven't kept</Check>
      <p className="fine">You can follow it again later by pasting its link in Add source.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
