import type { SourceDTO } from "@purss/domain";
import { Avatar, Icon } from "@purss/ui";
import { useNav } from "../nav.ts";
import type { Place } from "../nav.ts";
import { useListState } from "../pages/list-state.ts";
import { usePopups } from "../state/popups.tsx";
import { useWorkspace } from "../state/workspace.tsx";

type ListPlace = Exclude<Place, { t: "home" }>;

/**
 * Which of a collection's sources are on. The address keeps whichever list is shorter: the sources shown
 * (`source`), or the ones left out (`without`); neither means all of them.
 */
function useSourcePick(place: ListPlace, sources: SourceDTO[]) {
  const nav = useNav();
  const ls = useListState(place);
  const shown = ls.source ? new Set(ls.source.split(",")) : null;
  const left = new Set(ls.without ? ls.without.split(",") : []);
  const isOn = (id: string) => (shown ? shown.has(id) : !left.has(id));
  /** Show these sources; none or all picked means all of them. */
  const pick = (ids: string[]) => {
    const off = sources.filter((s) => !ids.includes(s.id)).map((s) => s.id);
    if (!ids.length || !off.length) nav.patchSearch({ source: undefined, without: undefined });
    else if (off.length < ids.length) nav.patchSearch({ source: undefined, without: off.join(",") });
    else nav.patchSearch({ source: ids.join(","), without: undefined });
  };
  const toggle = (id: string) => pick(sources.filter((o) => (o.id === id ? !isOn(o.id) : isOn(o.id))).map((o) => o.id));
  return { isOn, pick, toggle, on: sources.filter((s) => isOn(s.id)) };
}

/** The open list: each source switches on or off and the list stays open; Only shows just that one. */
function SourceList({ place, onClose }: { place: ListPlace; onClose: (restore?: boolean) => void }) {
  const ws = useWorkspace();
  const c = ws.collectionById.get(place.id);
  const sources = c ? ws.sourcesOf(c) : [];
  const { isOn, pick, toggle, on } = useSourcePick(place, sources);
  return (
    <div className="srcpick">
      <button type="button" className="mi" role="menuitemradio" aria-checked={on.length === sources.length} onClick={() => { onClose(true); pick([]); }}>
        <span className="ck">{on.length === sources.length ? <Icon name="check" size="sm" /> : null}</span><span className="nm">All sources</span>
      </button>
      <hr className="mhr" />
      {sources.map((s) => (
        <div key={s.id} className="srcpick-r">
          <button type="button" className="mi" role="menuitemcheckbox" aria-checked={isOn(s.id)} onClick={() => toggle(s.id)}>
            <span className="ck">{isOn(s.id) ? <Icon name="check" size="sm" /> : null}</span>
            <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={20} /><bdi className="nm">{s.title}</bdi>
          </button>
          <button type="button" className="mi only" role="menuitem" aria-label={`Only ${s.title}`} onClick={() => { onClose(true); pick([s.id]); }}>Only</button>
        </div>
      ))}
    </div>
  );
}

/** A collection's source filter: one drop-down that says what is on ("All sources", a source's name, or "2 of 5 sources"). */
export function SourceFilter({ place, sources }: { place: ListPlace; sources: SourceDTO[] }) {
  const popups = usePopups();
  const { on } = useSourcePick(place, sources);
  const label = on.length === sources.length || !on.length ? "All sources" : on.length === 1 ? on[0]!.title : `${on.length} of ${sources.length} sources`;
  const one = on.length === 1 ? on[0]! : null;
  return (
    <div className="srcfilter">
      <button type="button" className="mbtn" aria-haspopup="menu" aria-label={`Sources: ${label}`} aria-pressed={on.length < sources.length && on.length > 0}
        onClick={(e) => popups.panel(e.currentTarget, "Filter by source", (close) => <SourceList place={place} onClose={close} />, { role: "menu", className: "srcpick-pop" })}>
        {one ? <Avatar hue={one.hue} initials={one.initials} src={one.iconUrl} size={18} /> : <Icon name="filter" />}
        <bdi className="srcfilter-l">{label}</bdi><Icon name="chev" size="sm" />
      </button>
    </div>
  );
}
