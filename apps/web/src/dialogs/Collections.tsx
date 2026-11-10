import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CollectionDTO, ViewMode } from "@purss/domain";
import { Button, Check, Dialog, Field, SelectInput, Segmented, TextInput } from "@purss/ui";
import { del, messageOf, patch, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import { VIEW_LABELS, VIEW_MODES } from "../lib/constants.ts";
import { plural } from "../lib/format.ts";
import { EMPTY_DRAFT, draftToQuery, queryToDraft } from "../lib/query-builder.ts";
import type { QueryDraft } from "../lib/query-builder.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { EmojiField, QueryBuilder, SourcePicks } from "./parts.tsx";

type Mode = CollectionDTO["mode"];

export function NewCollectionDialog() {
  const ov = useOverlays();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [mode, setMode] = useState<Mode>("sources");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<QueryDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setError("");
    let query = null;
    if (mode === "query") {
      const r = draftToQuery(draft);
      if (!r.ok) { setError(r.message); return; }
      query = r.query;
    }
    setBusy(true);
    try {
      const c = await post<CollectionDTO>("/api/collections", { name: name.trim(), emoji: emoji.trim() || null, mode, sourceIds: mode === "sources" ? sourceIds : [], query, view: "list" });
      refreshWorkspace(qc);
      ov.close();
      toast(`Created ${c.name}${mode === "sources" && sourceIds.length ? ` with ${plural(sourceIds.length, "source")}` : ""}`, {
        undo: async () => { await del(`/api/collections/${encodeURIComponent(c.id)}`); refreshWorkspace(qc); },
        actions: [{ label: "Open", onSelect: () => nav.go({ t: "c", id: c.id }) }],
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog title="New collection" onClose={ov.close} size="md" initialFocus="#nc-name"
      footer={<><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={create}>Create collection</Button></>}>
      <div className="field"><label htmlFor="nc-name">Name</label>
        <TextInput id="nc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" placeholder="News, Science, Friends' blogs"
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy && mode !== "query") void create(); }} /></div>
      <EmojiField value={emoji} onChange={setEmoji} />
      <div className="field"><div className="lbl" id="nc-mode">What goes in it</div>
        <Segmented labelledBy="nc-mode" value={mode} onChange={setMode} style={{ justifySelf: "start" }}
          options={[{ value: "sources", label: "Sources" }, { value: "query", label: "Filter" }]} /></div>
      {mode === "sources" ? (
        <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Sources to include</legend>
          <SourcePicks selected={sourceIds} onChange={setSourceIds} />
          <p className="fine">A source can be in several collections. All its items appear here.</p></fieldset>
      ) : null}
      {mode === "query" ? <QueryBuilder draft={draft} onChange={setDraft} /> : null}
      {error ? <p className="state note" role="alert">{error}</p> : null}
    </Dialog>
  );
}

export function CollectionSettingsDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const c = ws.collectionById.get(id);
  const parsed = c ? queryToDraft(c.query) : { editable: true as const, draft: EMPTY_DRAFT };
  const [name, setName] = useState(c?.name ?? "");
  const [emoji, setEmoji] = useState(c?.emoji ?? "");
  const [view, setView] = useState<ViewMode>(c?.view ?? "list");
  const [onHome, setOnHome] = useState(c?.showOnHome ?? true);
  const [sourceIds, setSourceIds] = useState<string[]>(c?.sourceIds ?? []);
  const [draft, setDraft] = useState<QueryDraft>(parsed.editable ? parsed.draft : EMPTY_DRAFT);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!c) return null;

  async function save() {
    if (!c) return;
    setError("");
    const body: Record<string, unknown> = { name: name.trim() || c.name, emoji: emoji.trim() || null, view, showOnHome: onHome };
    if (c.mode === "sources") body.sourceIds = sourceIds;
    if (c.mode === "query" && parsed.editable) {
      const r = draftToQuery(draft);
      if (!r.ok) { setError(r.message); return; }
      body.query = r.query;
    }
    // What it was, in the same shape the server accepts for this kind of collection.
    const before: Record<string, unknown> = { name: c.name, emoji: c.emoji, view: c.view, showOnHome: c.showOnHome };
    if (c.mode === "sources") before.sourceIds = c.sourceIds;
    if (c.mode === "query") before.query = c.query;
    setBusy(true);
    try {
      await patch(`/api/collections/${encodeURIComponent(id)}`, body);
      refreshWorkspace(qc);
      ov.close();
      toast("Saved collection settings", { undo: async () => { await patch(`/api/collections/${encodeURIComponent(id)}`, before); refreshWorkspace(qc); } });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  async function remove() {
    if (!c) return;
    setBusy(true);
    try {
      await del(`/api/collections/${encodeURIComponent(id)}`);
      refreshWorkspace(qc);
      ov.close();
      nav.go({ t: "home" });
      toast(`Deleted the collection ${c.name}. Its sources and items are still here.`);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title="Collection settings" onClose={ov.close} size="md" initialFocus="#cs-name"
      footer={confirmDelete ? (
        <><span className="fine lft" style={{ marginRight: "auto", alignSelf: "center" }}>Sources and items stay; only this grouping goes.</span><Button onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" disabled={busy} onClick={remove}>Delete collection</Button></>
      ) : (
        <><Button className="lft" onClick={() => setConfirmDelete(true)}>Delete…</Button><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>Save changes</Button></>
      )}>
      <div className="field"><label htmlFor="cs-name">Name</label><TextInput id="cs-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" /></div>
      <EmojiField value={emoji} onChange={setEmoji} />
      <Field label="Default view" htmlFor="cs-view">
        <SelectInput id="cs-view" value={view} onChange={(e) => setView(e.target.value as ViewMode)}>{VIEW_MODES.map((m) => <option key={m} value={m}>{VIEW_LABELS[m]}</option>)}</SelectInput>
      </Field>
      {c.mode === "sources" ? (
        <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Sources</legend>
          <SourcePicks selected={sourceIds} onChange={setSourceIds} />
          <p className="fine">Sources you untick are still followed.</p></fieldset>
      ) : null}
      {c.mode === "query" ? (parsed.editable ? <QueryBuilder draft={draft} onChange={setDraft} />
        : <p className="state note">This collection's filter can't be edited here. It keeps working. You can rename it or change its view.</p>) : null}
      <Check checked={onHome} onChange={setOnHome}>Show on Home</Check>
      {error ? <p className="state note" role="alert">{error}</p> : null}
    </Dialog>
  );
}
