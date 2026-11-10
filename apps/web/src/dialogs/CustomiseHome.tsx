import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Bootstrap, Preferences } from "@purss/domain";
import { Button, Dialog, Icon, IconButton, Segmented, Check } from "@purss/ui";
import { messageOf, patch } from "../api/client.ts";
import { keys, refreshWorkspace } from "../api/queries.ts";
import { OTHER_BOX_ID, homeBoxes } from "../pages/home-boxes.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useSavePreferences } from "../state/prefs.ts";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

type Layout = Preferences["homeLayout"];

const LAYOUTS: { value: Layout; label: string; blurb: string; thumb: ReactNode }[] = [
  { value: "collections", label: "Collections", blurb: "One box per collection.",
    thumb: <div className="thumb t-col">{[0, 1, 2, 3].map((i) => <div key={i}><i /><em /></div>)}</div> },
  { value: "feed", label: "One feed", blurb: "Everything together, newest first.",
    thumb: <div className="thumb t-feed"><i className="dh" /><i /><i /><i className="dh" /><i /><i /></div> },
  { value: "new", label: "Only new", blurb: "Only items still marked New.",
    thumb: <div className="thumb t-new"><div><span className="f"><b /><i /></span><span className="f"><b /><i /></span></div><div><span className="f"><b /><i /></span></div></div> },
  { value: "front", label: "Front page", blurb: "Headlines from every collection, and baskets.",
    thumb: <div className="thumb t-front">{[0, 1, 2].map((k) => <div key={k} className="h"><i /><i /><i /></div>)}<div className="s"><i /><i /><i /></div></div> },
];

/** Layout, which collections show and in what order, and density. Saved as you go, and Home follows at once. */
export function CustomiseHomeDialog() {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const save = useSavePreferences();
  const { toast } = useToasts();
  const p = ws.prefs;
  // Order shown in the dialog: the boxes on Home in their order (Other sources among them), then the ones left out.
  const shown = homeBoxes(ws.homeCollections, ws.looseSources, p);
  const hidden = [
    ...ws.collections.filter((c) => !c.showOnHome),
    ...(ws.looseSources.length && !p.homeOther ? [{ id: OTHER_BOX_ID, name: "Other sources", showOnHome: false }] : []),
  ];
  const order = [...shown.map((c) => ({ id: c.id, name: c.name, showOnHome: true })), ...hidden.map((c) => ({ id: c.id, name: c.name, showOnHome: false }))];

  async function move(id: string, d: -1 | 1) {
    const ids = order.map((c) => c.id);
    const i = ids.indexOf(id), j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await save({ homeCollectionIds: ids });
  }
  /** The checkbox changes at once; if PURSS refuses, it goes back and says why. */
  async function show(id: string, on: boolean) {
    if (id === OTHER_BOX_ID) { await save({ homeOther: on }); return; }
    const before = qc.getQueryData<Bootstrap>(keys.bootstrap);
    if (before) qc.setQueryData<Bootstrap>(keys.bootstrap, { ...before, collections: before.collections.map((c) => (c.id === id ? { ...c, showOnHome: on } : c)) });
    try { await patch(`/api/collections/${encodeURIComponent(id)}`, { showOnHome: on }); } catch (err) {
      if (before) qc.setQueryData<Bootstrap>(keys.bootstrap, (cur) => (cur ? { ...cur, collections: cur.collections.map((c) => (c.id === id ? { ...c, showOnHome: !on } : c)) } : cur));
      toast(messageOf(err), { tone: "error" });
    } finally { refreshWorkspace(qc, { items: false }); }
  }
  async function reset() {
    await save({ homeLayout: "collections", homeCollectionIds: [], homeOther: true, density: "comfortable" });
    // The defaults: collections of sources are on Home, filter collections are off it.
    await Promise.all(ws.collections.filter((c) => (c.mode === "sources") !== c.showOnHome).map((c) => show(c.id, c.mode === "sources")));
  }

  return (
    <Dialog title="Customise Home" onClose={ov.close} size="lg" initialFocus='input[name="lay"]:checked'
      footer={<><Button className="lft" onClick={() => void reset()}>Reset to defaults</Button><Button variant="primary" onClick={ov.close}>Done</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Layout</legend>
        <div className="lopts four">
          {LAYOUTS.map((l) => (
            <label key={l.value} className="lopt">{l.thumb}
              <input type="radio" name="lay" value={l.value} checked={p.homeLayout === l.value} onChange={() => void save({ homeLayout: l.value })} />
              <b>{l.label}</b><small>{l.blurb}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="two">
        <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Collections on Home</legend>
          {order.length ? (
            <div className="ordlist">
              {order.map((c, i) => (
                <div className="ordrow" key={c.id}>
                  <label><input type="checkbox" checked={c.showOnHome} onChange={(e) => void show(c.id, e.target.checked)} /><span className="cb" aria-hidden="true"><Icon name="check" /></span><span className="nm" dir="auto">{c.name}</span></label>
                  <IconButton label={`Move ${c.name} up`} disabled={i === 0} onClick={() => void move(c.id, -1)}><Icon name="up" /></IconButton>
                  <IconButton label={`Move ${c.name} down`} disabled={i === order.length - 1} onClick={() => void move(c.id, 1)}><Icon name="down" /></IconButton>
                </div>
              ))}
            </div>
          ) : <p className="fine">No collections yet.</p>}
          {ws.looseSources.length ? <p className="fine">“Other sources” holds the sources that are in no collection.</p> : null}
        </fieldset>
        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <div className="field"><div className="lbl" id="dn">Density</div>
            <Segmented labelledBy="dn" value={p.density} onChange={(v) => void save({ density: v })} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
              options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} /></div>
          <div className="field" style={{ gap: 2 }}>
            <Check checked={p.freshMarkers} onChange={(v) => void save({ freshMarkers: v })}>Show New markers</Check>
            <Check checked={p.showCounts} onChange={(v) => void save({ showCounts: v })}>Show counts</Check>
            <p className="fine">Change how long items stay New, and notifications, in <button type="button" className="link" onClick={() => ov.open({ kind: "settings", tab: "notifications" })}>Settings</button>.</p>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
