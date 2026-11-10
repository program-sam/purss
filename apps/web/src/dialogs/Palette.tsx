import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ItemDTO } from "@purss/domain";
import { Avatar, Icon, PaletteLayer } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { messageOf } from "../api/client.ts";
import { searchQuery } from "../api/queries.ts";
import { useFace } from "../components/item-bits.tsx";
import { shortDate } from "../lib/format.ts";
import { itemDate } from "../lib/items.ts";
import { useNav } from "../nav.ts";
import type { Place } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useWorkspace } from "../state/workspace.tsx";

type Result = { key: string; label: string; sub: string; icon: IconName; run: () => void; item?: ItemDTO; snippet?: string; noteSnippet?: string };
type Group = { heading: string; results: Result[] };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Search and jump (Cmd/Ctrl+K or "/"): items from the server, places and actions from what's already loaded. */
export function PaletteDialog({ query }: { query?: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const nav = useNav();
  const [q, setQ] = useState(query ?? "");
  const [active, setActive] = useState(0);
  const term = q.trim();
  const debounced = useDebounced(term, 160);
  const search = useQuery({ ...searchQuery(debounced), enabled: debounced.length > 0 });
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo<Group[]>(() => {
    const go = (p: Place, search?: { item?: string }) => () => { ov.close(); nav.go(p, search); };
    const lower = term.toLowerCase();
    const places: Result[] = [{ key: "home", label: "Home", sub: "Start page", icon: "home", run: go({ t: "home" }) }];
    ws.collections.forEach((c) => places.push({ key: `c:${c.id}`, label: c.name, sub: "Collection", icon: "folder", run: go({ t: "c", id: c.id }) }));
    ws.data.sources.forEach((s) => places.push({ key: `s:${s.id}`, label: s.title, sub: "Source", icon: "rss", run: go({ t: "s", id: s.id }) }));
    ws.data.baskets.forEach((b) => places.push({ key: `b:${b.id}`, label: b.name, sub: "Basket", icon: "basket", run: go({ t: "b", id: b.id }) }));
    const actions: Result[] = [
      { key: "a:add", label: "Add source", sub: "Action", icon: "plus", run: () => ov.open({ kind: "add-source" }) },
      { key: "a:col", label: "New collection", sub: "Action", icon: "plus", run: () => ov.open({ kind: "new-collection" }) },
      { key: "a:bk", label: "New basket", sub: "Action", icon: "plus", run: () => ov.open({ kind: "basket-form" }) },
      { key: "a:home", label: "Customise Home", sub: "Action", icon: "gear", run: () => ov.open({ kind: "customise-home" }) },
      { key: "a:set", label: "Settings", sub: "Action", icon: "gear", run: () => ov.open({ kind: "settings" }) },
      { key: "a:keys", label: "Keyboard shortcuts", sub: "Action", icon: "gear", run: () => ov.open({ kind: "shortcuts" }) },
      { key: "a:apps", label: "Apps and extensions", sub: "Action", icon: "ext", run: () => ov.open({ kind: "settings", tab: "apps" }) },
    ];
    if (!term) return [{ heading: "Go to", results: places.slice(0, 1 + ws.collections.length) }, { heading: "Actions", results: actions }];
    const out: Group[] = [];
    const items: ItemDTO[] = debounced === term ? search.data?.items ?? [] : [];
    if (items.length) {
      out.push({ heading: "Items in all sources", results: items.map((i) => ({
        key: `i:${i.id}`, label: i.title, sub: i.sourceTitle, icon: "item" as const, item: i, snippet: search.data?.snippets?.[i.id], noteSnippet: search.data?.noteSnippets?.[i.id],
        run: go(i.basketIds[0] && !i.sourceId ? { t: "b", id: i.basketIds[0] } : i.sourceId && ws.sourceById.has(i.sourceId) ? { t: "s", id: i.sourceId } : i.basketIds[0] ? { t: "b", id: i.basketIds[0] } : { t: "home" }, { item: i.id }),
      })) });
    }
    const where = places.filter((p) => p.label.toLowerCase().includes(lower)).slice(0, 6);
    if (where.length) out.push({ heading: "Go to", results: where });
    const acts = actions.filter((a) => a.label.toLowerCase().includes(lower));
    if (acts.length) out.push({ heading: "Actions", results: acts });
    return out;
  }, [term, debounced, search.data, ws, ov, nav]);

  const flat = groups.flatMap((g) => g.results);
  useEffect(() => { setActive(0); }, [term]);
  useEffect(() => { listRef.current?.querySelector(`#po${active}`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === "Enter" && flat[active]) { e.preventDefault(); const r = flat[active]!; r.run(); }
  }

  let n = 0;
  // Still searching until the answer for exactly what is typed has arrived: "Nothing matches" must never show before that.
  const answered = !!term && debounced === term && !search.isFetching && (search.isSuccess || search.isError);
  const searching = !!term && !answered;
  const nothing = answered && !search.isError && !flat.length;
  // One polite announcement for screen readers: that it is searching, then how many results.
  const spoken = !term ? "" : searching ? "Searching…" : search.isError ? "The search didn't work." : flat.length ? `${flat.length === 1 ? "1 result" : `${flat.length} results`}` : "Nothing matches.";
  return (
    <PaletteLayer label="Search" onClose={ov.close}>
      <div className="pal-in">
        <Icon name="search" />
        <input id="pq" role="combobox" aria-expanded="true" aria-controls="pl" aria-autocomplete="list" aria-activedescendant={flat.length ? `po${active}` : undefined}
          placeholder="Search items, sources, collections and baskets" autoComplete="off" spellCheck={false} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <button type="button" className="ibtn" aria-label="Close search" title="Close (Esc)" onClick={ov.close}><Icon name="x" /></button>
      </div>
      <div className="pal-list" id="pl" role="listbox" aria-label="Results" ref={listRef}>
        {groups.map((g) => (
          <div key={g.heading} role="presentation">
            <div className="pal-h" role="presentation">{g.heading}</div>
            {g.results.map((r) => {
              const idx = n++;
              return (
                <div key={r.key} id={`po${idx}`} role="option" aria-selected={idx === active} className="pal-i" onClick={r.run} onPointerMove={() => idx !== active && setActive(idx)}>
                  {r.item ? <ResultFace item={r.item} /> : <Icon name={r.icon} />}
                  <span className="tx"><span dir="auto">{r.label}</span>
                    {r.item ? <><small><bdi>{r.sub}</bdi> · {shortDate(itemDate(r.item), Date.now(), ws.prefs.timezone)}</small>{r.snippet ? <Marked text={r.snippet} /> : r.noteSnippet ? <Marked text={r.noteSnippet} note /> : null}</> : <small>{r.sub}</small>}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {nothing ? <p className="pal-empty">Nothing matches <span dir="auto">“{term}”</span>.</p> : null}
        {searching ? <p className="fine" style={{ padding: "6px 12px" }}>Searching…</p> : null}
        {search.isError && answered ? <p className="fine" style={{ padding: "6px 12px" }} role="alert">{messageOf(search.error)}</p> : null}
      </div>
      {flat.length ? <div className="pal-foot">{flat.length === 1 ? "1 result" : `${flat.length} results`}<span className="keys">↑↓ to choose · Enter to open</span></div> : null}
      <div className="sr" role="status" aria-live="polite">{spoken}</div>
    </PaletteLayer>
  );
}

function ResultFace({ item }: { item: ItemDTO }) {
  const face = useFace(item);
  return <Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} size={22} />;
}

/** The server's snippet, with the matched words (between U+0001 and U+0002) marked. */
function Marked({ text, note = false }: { text: string; note?: boolean }) {
  const parts = text.split(/\u0001|\u0002/);
  return <small className="snip" dir="auto">{note ? <b className="snip-note">Your note: </b> : null}{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</small>;
}
