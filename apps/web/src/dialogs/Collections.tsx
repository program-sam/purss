import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import type { CollectionDTO, ViewMode } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, SelectInput, Segmented, TextInput } from "@purss/ui";
import { del, messageOf, patch, post } from "../api/client.ts";
import { refreshPurss } from "../api/queries.ts";
import { VIEW_LABELS, VIEW_MODES } from "../lib/constants.ts";
import { plural } from "../lib/format.ts";
import { capacityOf, collectionLimitNote } from "../lib/plan-limits.ts";
import { useAlertFocus } from "../lib/use-focus.ts";
import { EMPTY_DRAFT, draftToQuery, queryToDraft } from "../lib/query-builder.ts";
import type { QueryDraft } from "../lib/query-builder.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { usePurss } from "../state/purss.tsx";
import { EmojiField, QueryBuilder, SourcePicks } from "./parts.tsx";

const t = app.dialogs.collections;

type Mode = CollectionDTO["mode"];

export function NewCollectionDialog() {
  const ov = useOverlays();
  const ws = usePurss();
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
  const alertRef = useAlertFocus<HTMLParagraphElement>(error);
  // A plan with no room left is said before the form is filled in, not after it is sent.
  const limit = collectionLimitNote(capacityOf(ws.data));

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
      refreshPurss(qc);
      ov.close();
      toast(t.newCollection.created(c.name, mode === "sources" && sourceIds.length ? t.newCollection.withSources(plural(sourceIds.length, app.words.sourceLower)) : ""), {
        undo: async () => { await del(`/api/collections/${encodeURIComponent(c.id)}`); refreshPurss(qc); },
        actions: [{ label: app.words.open, onSelect: () => nav.go({ t: "c", id: c.id }) }],
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  if (limit) {
    return (
      <Dialog title={app.words.newCollection} onClose={ov.close} size="md" initialFocus="dialog"
        footer={<><Button onClick={ov.close}>{app.words.close}</Button><Button variant="primary" onClick={() => ov.open({ kind: "settings", tab: "plan" })}>{app.words.seePlans}</Button></>}>
        <p className="state note"><Icon name="info" /><span>{limit}</span></p>
      </Dialog>
    );
  }

  return (
    <Dialog title={app.words.newCollection} onClose={ov.close} size="md" initialFocus="#nc-name"
      footer={<><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={create}>{t.newCollection.create}</Button></>}>
      <p className="fine">{t.newCollection.intro}</p>
      <div className="field"><label htmlFor="nc-name">{app.words.name}</label>
        <TextInput id="nc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" placeholder={t.newCollection.placeholder}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy && mode !== "query") void create(); }} /></div>
      <EmojiField value={emoji} onChange={setEmoji} />
      <div className="field"><div className="lbl" id="nc-mode">{t.newCollection.whatGoesIn}</div>
        <Segmented labelledBy="nc-mode" value={mode} onChange={setMode} style={{ justifySelf: "start" }}
          options={[{ value: "sources", label: t.newCollection.sourcesIPick }, { value: "query", label: t.newCollection.itemsMatching }]} /></div>
      {mode === "sources" ? (
        <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.newCollection.sourcesToInclude}</legend>
          <SourcePicks selected={sourceIds} onChange={setSourceIds} />
          <p className="fine">{t.newCollection.severalCollections}</p></fieldset>
      ) : null}
      {mode === "query" ? <QueryBuilder draft={draft} onChange={setDraft} /> : null}
      {error ? <p ref={alertRef} tabIndex={-1} className="state note" role="alert">{error}</p> : null}
    </Dialog>
  );
}

export function CollectionSettingsDialog({ id }: { id: string }) {
  const ov = useOverlays();
  const ws = usePurss();
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
  const alertRef = useAlertFocus<HTMLParagraphElement>(error);
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
      refreshPurss(qc);
      ov.close();
      toast(t.settings.saved, { undo: async () => { await patch(`/api/collections/${encodeURIComponent(id)}`, before); refreshPurss(qc); } });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  async function remove() {
    if (!c) return;
    setBusy(true);
    try {
      await del(`/api/collections/${encodeURIComponent(id)}`);
      refreshPurss(qc);
      ov.close();
      nav.go({ t: "home" });
      toast(t.settings.deleted(c.name));
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={t.settings.title} onClose={ov.close} size="md" initialFocus="#cs-name"
      footer={confirmDelete ? (
        <><span className="fine lft" style={{ marginRight: "auto", alignSelf: "center" }}>{t.settings.onlyGrouping}</span><Button onClick={() => setConfirmDelete(false)}>{t.settings.keepIt}</Button><Button variant="danger" disabled={busy} onClick={remove}>{t.settings.deleteCollection}</Button></>
      ) : (
        <><Button className="lft" onClick={() => setConfirmDelete(true)}>{app.words.delete}</Button><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" disabled={busy} onClick={save}>{app.words.saveChanges}</Button></>
      )}>
      <div className="field"><label htmlFor="cs-name">{app.words.name}</label><TextInput id="cs-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" /></div>
      <EmojiField value={emoji} onChange={setEmoji} />
      <Field label={t.settings.defaultView} htmlFor="cs-view">
        <SelectInput id="cs-view" value={view} onChange={(e) => setView(e.target.value as ViewMode)}>{VIEW_MODES.map((m) => <option key={m} value={m}>{VIEW_LABELS[m]}</option>)}</SelectInput>
      </Field>
      {c.mode === "sources" ? (
        <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{app.words.sources}</legend>
          <SourcePicks selected={sourceIds} onChange={setSourceIds} />
          <p className="fine">{t.settings.untickedFollowed}</p></fieldset>
      ) : null}
      {c.mode === "query" ? (parsed.editable ? <QueryBuilder draft={draft} onChange={setDraft} />
        : <p className="state note">{t.settings.notEditable}</p>) : null}
      <Check checked={onHome} onChange={setOnHome}>{app.words.showOnHome}</Check>
      {error ? <p ref={alertRef} tabIndex={-1} className="state note" role="alert">{error}</p> : null}
    </Dialog>
  );
}
