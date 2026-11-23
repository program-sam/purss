import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import { AI_FILTER_PREVIEW_POSTS, AI_FILTER_TEXT_MAX } from "@purss/domain";
import type { AiFilterDTO, AiFilterPreview, AiFilterScope, AiSettingsDTO, WhenUnsure } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, Segmented, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../api/client.ts";
import { refreshPurss } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import { plural } from "../lib/format.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { usePurss } from "../state/purss.tsx";

/*
 * Smart filters: describe which posts of a source or collection to keep, try the words on the latest posts, then turn the
 * filter on. Posts it drops are marked Ignored; the questions go to the AI provider configured for Smart filters.
 */

const t = app.dialogs.aiFilter;

const aiKey = ["ai-settings"] as const;
const filterKey = (scope: AiFilterScope) => ["ai-filter", "sourceId" in scope ? `s:${scope.sourceId}` : `c:${scope.collectionId}`] as const;
const base = (scope: AiFilterScope) => ("sourceId" in scope ? `/api/sources/${encodeURIComponent(scope.sourceId)}` : `/api/collections/${encodeURIComponent(scope.collectionId)}`) + "/ai-filter";

const percent = (p: number) => `${Math.round(p * 100)}%`;

function useAiSettings() {
  return useQuery({ queryKey: aiKey, queryFn: () => get<AiSettingsDTO>("/api/ai"), staleTime: 0 });
}

export function AiFilterDialog({ scope }: { scope: AiFilterScope }) {
  const ov = useOverlays();
  const ws = usePurss();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const name = "sourceId" in scope ? ws.sourceById.get(scope.sourceId)?.title : ws.collectionById.get(scope.collectionId)?.name;
  const settings = useAiSettings();
  const current = useQuery({ queryKey: filterKey(scope), queryFn: () => get<{ filter: AiFilterDTO | null }>(base(scope)), staleTime: 0 });
  if (!name || !settings.data || !current.data) {
    return <Dialog title={t.dialog.loadingTitle} size="md" onClose={ov.close}>{settings.error || current.error ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(settings.error ?? current.error)}</span></p> : <p className="fine">{app.words.loading}</p>}</Dialog>;
  }
  return <FilterEditor scope={scope} name={name} settings={settings.data} filter={current.data.filter} onDone={(text) => { void qc.invalidateQueries({ queryKey: aiKey }); void qc.invalidateQueries({ queryKey: filterKey(scope) }); refreshPurss(qc); ov.close(); toast(text); }} onClose={ov.close} />;
}

function FilterEditor({ scope, name, settings, filter, onDone, onClose }: { scope: AiFilterScope; name: string; settings: AiSettingsDTO; filter: AiFilterDTO | null; onDone: (toast: string) => void; onClose: () => void }) {
  const [keep, setKeep] = useState(filter?.keep ?? "");
  const [drop, setDrop] = useState(filter?.drop ?? "");
  const [whenUnsure, setWhenUnsure] = useState<WhenUnsure>(filter?.whenUnsure ?? "keep");
  const [enabled, setEnabled] = useState(filter?.enabled ?? true);
  const [preview, setPreview] = useState<AiFilterPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "save" | "remove">("");
  const rule = { keep: keep.trim(), drop: drop.trim() || null, whenUnsure };
  const ready = rule.keep.length >= 3;
  const route = settings.ready;
  const what = "sourceId" in scope ? t.editor.thisSource : t.editor.thisCollection;

  async function tryIt() {
    setBusy("preview"); setError("");
    try { setPreview(await post<AiFilterPreview>(`${base(scope)}/preview`, rule)); } catch (err) { setError(messageOf(err)); } finally { setBusy(""); }
  }
  async function save() {
    setBusy("save"); setError("");
    try {
      await put<{ filter: AiFilterDTO }>(base(scope), { ...rule, enabled });
      onDone(enabled ? t.editor.turnedOn(isolate(name)) : t.editor.savedOff(isolate(name)));
    } catch (err) { setError(messageOf(err)); setBusy(""); }
  }
  async function remove() {
    setBusy("remove"); setError("");
    try { await del(base(scope)); onDone(t.editor.removed(isolate(name))); } catch (err) { setError(messageOf(err)); setBusy(""); }
  }
  // A preview of other words than the ones shown would mislead; it goes when the words change.
  const edit = (f: () => void) => { f(); setPreview(null); };

  const kept = preview?.posts.filter((p) => !p.dropped).length ?? 0;
  return (
    <Dialog title={t.dialog.forTitle(isolate(name))} size="md" onClose={onClose} initialFocus="#aif-keep"
      footer={<>
        {filter ? <Button variant="danger" disabled={!!busy} onClick={remove} style={{ marginRight: "auto" }}>{t.editor.removeFilter}</Button> : null}
        <Button onClick={onClose}>{app.words.cancel}</Button>
        <Button variant="primary" type="submit" form="aif-form" disabled={!!busy || !ready || !route}>{filter ? app.words.save : enabled ? app.words.turnOn : app.words.save}</Button>
      </>}>
      <form id="aif-form" onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: "grid", gap: 12 }}>
        <p className="hint">{t.editor.hint(what)}</p>
        {!route ? (
          <p className="state note" role="status"><Icon name="info" /><span>{!settings.serverKey
            ? settings.pro !== null ? t.editor.notAvailableYet : t.editor.notSetUp
            : settings.allowanceUsedUp
              ? settings.pro !== null ? t.editor.allowanceUsedPro : t.editor.allowanceUsedAdmin
              : t.editor.includedInPro}</span></p>
        ) : null}
        <Field label={t.editor.keepLabel} htmlFor="aif-keep" hint={t.editor.keepHint}>
          <TextInput id="aif-keep" value={keep} maxLength={AI_FILTER_TEXT_MAX} onChange={(e) => edit(() => setKeep(e.target.value))} autoComplete="off" />
        </Field>
        <Field label={t.editor.dropLabel} htmlFor="aif-drop" hint={t.editor.dropHint}>
          <TextInput id="aif-drop" value={drop} maxLength={AI_FILTER_TEXT_MAX} onChange={(e) => edit(() => setDrop(e.target.value))} autoComplete="off" />
        </Field>
        <div className="field"><div className="lbl" id="aif-unsure">{t.editor.whenUnsure}</div>
          <Segmented labelledBy="aif-unsure" value={whenUnsure} onChange={(v) => edit(() => setWhenUnsure(v))} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
            options={[{ value: "keep", label: t.editor.keepThePost }, { value: "drop", label: t.editor.dropThePost }]} /></div>
        <div className="field" style={{ gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={tryIt} disabled={!!busy || !ready || !route}>{busy === "preview" ? t.editor.trying : t.editor.tryOn(AI_FILTER_PREVIEW_POSTS)}</Button>
          </div>
          {preview ? (
            <>
              <p className="fine" role="status">{t.editor.previewSummary(plural(kept, app.words.post), plural(preview.posts.length - kept, app.words.post))}</p>
              <ul className="ordlist aif-preview" aria-label="What the filter would do">
                {preview.posts.map((p) => (
                  <li className={`ordrow${p.dropped ? " aif-dropped" : ""}`} key={p.itemId}>
                    <span className={`aif-verdict ${p.dropped ? "aif-drop" : "aif-keep"}`}>{p.dropped ? t.editor.drop : app.words.keep}</span>
                    <span className="nm" dir="auto">{p.title}{"collectionId" in scope && p.sourceTitle ? <span className="fine"> · {p.sourceTitle}</span> : null}</span>
                    <span className="fine aif-pct">{percent(p.keepProbability)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <Check checked={enabled} onChange={setEnabled} hint={t.editor.enabledHint}>{t.editor.enabled}</Check>
        {filter ? <p className="fine">{t.editor.soFar(plural(filter.judgedCount, app.words.post), filter.droppedCount === 1 ? t.editor.droppedOne : t.editor.droppedMany(filter.droppedCount))}</p> : null}
        <p className="fine">{t.editor.privacy(settings.keySource.split(" (")[0]!)}</p>
      </form>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

/** Settings → Smart filters: whether they are available and whether the plan includes them. Never amounts or tokens. */
export function AiSettingsField() {
  const settings = useAiSettings();
  const s = settings.data;
  return (
    <fieldset className="field" aria-describedby="ai-hint"><legend className="lbl" style={{ marginBottom: 6 }}>{app.words.smartFilters}</legend>
      <p className="fine" id="ai-hint">{t.settings.hint}</p>
      {!s ? <p className="fine">{settings.error ? messageOf(settings.error) : app.words.loading}</p> : (
        <>
          {!s.serverKey ? <p className="fine">{s.pro !== null ? t.settings.notAvailableYet : t.settings.notSetUp}</p>
            : s.allowanceUsedUp ? <p className="fine">{s.pro !== null ? t.settings.allowanceUsedPro : t.settings.allowanceUsedAdmin}</p>
            : s.pro ? <p className="fine">{s.pro.included ? t.settings.included : t.settings.includedPro}</p> : null}
        </>
      )}
    </fieldset>
  );
}
