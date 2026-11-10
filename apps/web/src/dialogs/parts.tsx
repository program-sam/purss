import { useState } from "react";
import type { ItemKind, SourceDTO, WorkflowState } from "@purss/domain";
import { Avatar, Icon, SelectInput, TextInput } from "@purss/ui";
import { ITEM_KINDS, KIND_LABELS, WORKFLOW_LABELS, WORKFLOW_ORDER } from "../lib/constants.ts";
import type { DateBasis, KeptChoice, QueryDraft } from "../lib/query-builder.ts";
import { useWorkspace } from "../state/workspace.tsx";

/** Checklist of followed sources. A source may sit in several collections, so ticking adds without moving. */
export function SourcePicks({ selected, onChange, whereLabel }: { selected: string[]; onChange: (ids: string[]) => void; whereLabel?: (s: SourceDTO) => string }) {
  const ws = useWorkspace();
  const sources = ws.data.sources;
  if (!sources.length) return <p className="fine">You don't follow any sources yet. Add one first.</p>;
  return (
    <div className="picks">
      {sources.map((s) => {
        const on = selected.includes(s.id);
        const where = whereLabel ? whereLabel(s) : s.collectionIds.length ? `In ${s.collectionIds.map((id) => ws.collectionById.get(id)?.name).filter(Boolean).join(", ")}` : "Not in a collection";
        return (
          <label key={s.id} className="pick">
            <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))} />
            <span className="cb" aria-hidden="true"><Icon name="check" /></span>
            <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={24} />
            <span className="nm" dir="auto">{s.title}</span>
            <span className="where">{where}</span>
          </label>
        );
      })}
    </div>
  );
}

export function ChipToggles<T extends string>({ options, selected, onChange, label }: { options: readonly { value: T; label: string }[]; selected: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label} style={{ padding: "2px 2px 6px", flexWrap: "wrap" }}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button key={o.value} type="button" className="chipf" aria-pressed={on} style={{ paddingLeft: 12 }}
            onClick={() => onChange(on ? selected.filter((x) => x !== o.value) : [...selected, o.value])}>{o.label}</button>
        );
      })}
    </div>
  );
}

/** The small filter builder: every condition added must match. */
export function QueryBuilder({ draft, onChange }: { draft: QueryDraft; onChange: (d: QueryDraft) => void }) {
  const set = (patch: Partial<QueryDraft>) => onChange({ ...draft, ...patch });
  const [showSources, setShowSources] = useState(draft.sourceIds.length > 0);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="hint">Items must meet every condition. Leave a condition empty to skip it.</p>
      <div className="field"><label htmlFor="qb-text">Contains all of these words</label>
        <TextInput id="qb-text" value={draft.text} onChange={(e) => set({ text: e.target.value })} maxLength={200} placeholder="tide ferry timetable" autoComplete="off" /></div>
      <div className="field">
        <div className="lbl">From these sources</div>
        {showSources ? <SourcePicks selected={draft.sourceIds} onChange={(ids) => set({ sourceIds: ids })} /> : (
          <div><button type="button" className="btn" onClick={() => setShowSources(true)}>Choose sources…</button></div>
        )}
      </div>
      <div className="field"><div className="lbl" id="qb-kind">Type</div>
        <ChipToggles label="Type" options={ITEM_KINDS.map((k: ItemKind) => ({ value: k, label: KIND_LABELS[k] }))} selected={draft.kinds} onChange={(kinds) => set({ kinds })} /></div>
      <div className="field"><div className="lbl" id="qb-wf">State</div>
        <ChipToggles label="State" options={WORKFLOW_ORDER.map((w: WorkflowState) => ({ value: w, label: WORKFLOW_LABELS[w] }))} selected={draft.workflows} onChange={(workflows) => set({ workflows })} /></div>
      <div className="field"><label htmlFor="qb-kept">Kept in a basket</label>
        <SelectInput id="qb-kept" value={draft.kept} onChange={(e) => set({ kept: e.target.value as KeptChoice })}>
          <option value="any">Either way</option><option value="kept">Only kept items</option><option value="unkept">Only items not kept</option>
        </SelectInput></div>
      <div className="field"><div className="lbl" id="qb-date">Date</div>
        <div className="two" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <SelectInput aria-label="Date to compare" value={draft.dateBasis} onChange={(e) => set({ dateBasis: e.target.value as DateBasis })}>
            <option value="published">Published</option><option value="discovered">Arrived here</option><option value="kept">Kept</option>
          </SelectInput>
          <TextInput type="date" aria-label="From date" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
          <TextInput type="date" aria-label="Until date" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

const EMOJI = ["🧭", "📚", "🌙", "⚓", "🏺", "🎧", "🌱", "🔭", "📰", "🎬"];

/** A few friendly symbols to pick from, plus free text for any other emoji or letter. */
export function EmojiField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="emoji">Symbol (optional)</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <TextInput id="emoji" value={value} onChange={(e) => onChange(e.target.value.slice(0, 4))} style={{ width: 74, textAlign: "center" }} maxLength={4} autoComplete="off" aria-label="Symbol" />
        <div className="chips" role="group" aria-label="Suggested symbols" style={{ padding: 0, margin: 0, flexWrap: "wrap" }}>
          {EMOJI.map((e) => <button key={e} type="button" className="chipf" aria-pressed={value === e} aria-label={`Use ${e}`} style={{ paddingLeft: 11, paddingRight: 11 }} onClick={() => onChange(value === e ? "" : e)}>{e}</button>)}
        </div>
      </div>
    </div>
  );
}
