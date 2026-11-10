import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_FILTER_PREVIEW_POSTS, AI_FILTER_TEXT_MAX } from "@purss/domain";
import type { AiFilterDTO, AiFilterPreview, AiFilterScope, AiSettingsDTO, WhenUnsure } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, Segmented, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import { isolate } from "../lib/bidi.ts";
import { plural } from "../lib/format.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

/*
 * Smart filters (plan/36): describe which posts of a source or collection to keep, try the words on the latest posts, then turn the
 * filter on. Posts it drops are marked Ignored; the questions go to Jev on the server's key (hosted: for accounts on Pro).
 */

const aiKey = ["ai-settings"] as const;
const filterKey = (scope: AiFilterScope) => ["ai-filter", "sourceId" in scope ? `s:${scope.sourceId}` : `c:${scope.collectionId}`] as const;
const base = (scope: AiFilterScope) => ("sourceId" in scope ? `/api/sources/${encodeURIComponent(scope.sourceId)}` : `/api/collections/${encodeURIComponent(scope.collectionId)}`) + "/ai-filter";

const percent = (p: number) => `${Math.round(p * 100)}%`;

function useAiSettings() {
  return useQuery({ queryKey: aiKey, queryFn: () => get<AiSettingsDTO>("/api/ai"), staleTime: 0 });
}

export function AiFilterDialog({ scope }: { scope: AiFilterScope }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const name = "sourceId" in scope ? ws.sourceById.get(scope.sourceId)?.title : ws.collectionById.get(scope.collectionId)?.name;
  const settings = useAiSettings();
  const current = useQuery({ queryKey: filterKey(scope), queryFn: () => get<{ filter: AiFilterDTO | null }>(base(scope)), staleTime: 0 });
  if (!name || !settings.data || !current.data) {
    return <Dialog title="Smart filter" size="md" onClose={ov.close}>{settings.error || current.error ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(settings.error ?? current.error)}</span></p> : <p className="fine">Loading…</p>}</Dialog>;
  }
  return <FilterEditor scope={scope} name={name} settings={settings.data} filter={current.data.filter} onDone={(text) => { void qc.invalidateQueries({ queryKey: aiKey }); void qc.invalidateQueries({ queryKey: filterKey(scope) }); refreshWorkspace(qc); ov.close(); toast(text); }} onClose={ov.close} />;
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
  const what = "sourceId" in scope ? "this source" : "the sources in this collection";

  async function tryIt() {
    setBusy("preview"); setError("");
    try { setPreview(await post<AiFilterPreview>(`${base(scope)}/preview`, rule)); } catch (err) { setError(messageOf(err)); } finally { setBusy(""); }
  }
  async function save() {
    setBusy("save"); setError("");
    try {
      await put<{ filter: AiFilterDTO }>(base(scope), { ...rule, enabled });
      onDone(enabled ? `The Smart filter for ${isolate(name)} is on. Recent Undecided posts are being checked.` : `The Smart filter for ${isolate(name)} is saved and off.`);
    } catch (err) { setError(messageOf(err)); setBusy(""); }
  }
  async function remove() {
    setBusy("remove"); setError("");
    try { await del(base(scope)); onDone(`Removed the Smart filter for ${isolate(name)}. Posts it marked Ignored stay in Ignored.`); } catch (err) { setError(messageOf(err)); setBusy(""); }
  }
  // A preview of other words than the ones shown would mislead; it goes when the words change.
  const edit = (f: () => void) => { f(); setPreview(null); };

  const kept = preview?.posts.filter((p) => !p.dropped).length ?? 0;
  return (
    <Dialog title={`Smart filter for ${isolate(name)}`} size="md" onClose={onClose} initialFocus="#aif-keep"
      footer={<>
        {filter ? <Button variant="danger" disabled={!!busy} onClick={remove} style={{ marginRight: "auto" }}>Remove filter</Button> : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="aif-form" disabled={!!busy || !ready || !route}>{filter ? "Save" : enabled ? "Turn on" : "Save"}</Button>
      </>}>
      <form id="aif-form" onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: "grid", gap: 12 }}>
        <p className="hint">Describe which posts of {what} you want. Jev, an AI model that answers yes or no, judges each new post; the ones it drops are marked Ignored. Nothing is deleted, and when you move a post back yourself, it stays where you put it.</p>
        {!route ? (
          <p className="state note" role="status"><Icon name="info" /><span>{!settings.serverKey ? "This server hasn't set up Smart filters yet. Ask your administrator." : settings.allowanceUsedUp ? "You've used this week's Smart filter allowance. Contact your administrator to change your limits." : "Smart filters are included in the Pro plan. Move to Pro to use a filter."}</span></p>
        ) : null}
        <Field label="Keep posts that…" htmlFor="aif-keep" hint="For example: are about Rust compiler internals or language design">
          <TextInput id="aif-keep" value={keep} maxLength={AI_FILTER_TEXT_MAX} onChange={(e) => edit(() => setKeep(e.target.value))} autoComplete="off" />
        </Field>
        <Field label="Drop posts that… (optional)" htmlFor="aif-drop" hint="For example: are job ads, sponsored posts or release notes">
          <TextInput id="aif-drop" value={drop} maxLength={AI_FILTER_TEXT_MAX} onChange={(e) => edit(() => setDrop(e.target.value))} autoComplete="off" />
        </Field>
        <div className="field"><div className="lbl" id="aif-unsure">When Jev isn't sure</div>
          <Segmented labelledBy="aif-unsure" value={whenUnsure} onChange={(v) => edit(() => setWhenUnsure(v))} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
            options={[{ value: "keep", label: "Keep the post" }, { value: "drop", label: "Drop the post" }]} /></div>
        <div className="field" style={{ gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={tryIt} disabled={!!busy || !ready || !route}>{busy === "preview" ? "Trying…" : `Try on the latest ${AI_FILTER_PREVIEW_POSTS} posts`}</Button>
          </div>
          {preview ? (
            <>
              <p className="fine" role="status">{plural(kept, "post")} kept, {plural(preview.posts.length - kept, "post")} dropped. The percentage is how sure Jev is that a post belongs.</p>
              <ul className="ordlist aif-preview" aria-label="What the filter would do">
                {preview.posts.map((p) => (
                  <li className={`ordrow${p.dropped ? " aif-dropped" : ""}`} key={p.itemId}>
                    <span className={`aif-verdict ${p.dropped ? "aif-drop" : "aif-keep"}`}>{p.dropped ? "Drop" : "Keep"}</span>
                    <span className="nm" dir="auto">{p.title}{"collectionId" in scope && p.sourceTitle ? <span className="fine"> · {p.sourceTitle}</span> : null}</span>
                    <span className="fine aif-pct">{percent(p.keepProbability)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <Check checked={enabled} onChange={setEnabled} hint="Untick to pause the filter: your words stay saved, and new posts come in unfiltered.">Judge new posts as they arrive</Check>
        {filter ? <p className="fine">So far it has judged {plural(filter.judgedCount, "post")} and {filter.droppedCount === 1 ? "1 post it dropped is" : `${filter.droppedCount} posts it dropped are`} still Ignored. Changing the words checks the Undecided posts of the last 30 days again, and gives back posts it would now keep.</p> : null}
        <p className="fine">To judge a post, its title, summary, author and source name are sent to Jev through {settings.keySource.split(" (")[0]}.</p>
      </form>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

/** Settings → Smart filters: whether this server has set them up and whether the plan includes them. Never amounts or tokens. */
export function AiSettingsField() {
  const settings = useAiSettings();
  const s = settings.data;
  return (
    <fieldset className="field" aria-describedby="ai-hint"><legend className="lbl" style={{ marginBottom: 6 }}>Smart filters</legend>
      <p className="fine" id="ai-hint">Optional. A source or collection can have a Smart filter that marks the posts you don't want as Ignored; set one up from its Manage menu. Filters ask Jev, TypeSafe AI's decision model, about each new post.</p>
      {!s ? <p className="fine">{settings.error ? messageOf(settings.error) : "Loading…"}</p> : (
        <>
          {!s.serverKey ? <p className="fine">This server hasn't set up Smart filters yet. Ask your administrator. Until then, new posts arrive as usual.</p>
            : s.allowanceUsedUp ? <p className="fine">You've used this week's Smart filter allowance. Contact your administrator to change your limits. Until then, new posts arrive unfiltered.</p>
            : s.pro ? <p className="fine">{s.pro.included ? "Included in your plan." : "Included in the Pro plan."}</p> : null}
        </>
      )}
    </fieldset>
  );
}
