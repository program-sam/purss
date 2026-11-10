import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { HomeOverview, ItemDTO, SourceDTO } from "@purss/domain";
import { Avatar, Button, Icon } from "@purss/ui";
import { homeOverviewQuery } from "../api/home-queries.ts";
import { findItem } from "../api/queries.ts";
import { MutedNotice } from "../components/MutedNotice.tsx";
import { ItemRow } from "../components/ItemRow.tsx";
import { RetrySource } from "../components/RetrySource.tsx";
import { RowContext, useRowCtx } from "../components/row-context.tsx";
import { leavesOn } from "../lib/leave.ts";
import { formatCount, interfaceLocale, plural } from "../lib/format.ts";
import { isNewerCopy } from "../lib/items.ts";
import { calmLine, sinceLine } from "../lib/returning.ts";
import { useNav } from "../nav.ts";
import { useItemActions } from "../state/actions.ts";
import { setHints, useHints } from "../state/ui-store.ts";
import { useWorkspace } from "../state/workspace.tsx";
import "./home.css";

/** What Home says to someone coming back. Every part stays out of the way when it has nothing to say. */
export function useHomeOverview() {
  return useQuery(homeOverviewQuery());
}

/** The latest cached copy of each item (a change made anywhere shows at once), in the order given. */
function useLive(items: readonly ItemDTO[]): ItemDTO[] {
  const qc = useQueryClient();
  const [, tick] = useState(0);
  // Only new data in the cache matters (a change to an item); observers coming and going must not cause another render.
  useEffect(() => qc.getQueryCache().subscribe((e) => { if (e.type === "updated" && e.action.type === "success") tick((n) => n + 1); }), [qc]);
  return items.map((it) => {
    const cached = findItem(qc, it.id);
    return cached && !isNewerCopy(it, cached) ? cached : it;
  });
}

/** The line under the Home title: today's date, and what is New, since the last visit when there was one. */
export function HomeBand() {
  const ws = useWorkspace();
  const nav = useNav();
  const q = useHomeOverview();
  if (!ws.data.sources.length) return null;
  const o = q.data;
  const fresh = ws.data.sources.reduce((n, s) => n + s.freshCount, 0);
  const today = new Intl.DateTimeFormat(interfaceLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: ws.prefs.timezone }).format(new Date());
  const showCounts = ws.prefs.showCounts;
  const top = o?.since?.boxes.slice(0, 3) ?? [];
  return (
    <div className="home-sum-wrap">
      <p className="home-sum">
        <span>{today}</span>
        {o?.since && o.lastVisitAt ? (
          <span className="since"><i className="dot" />{sinceLine(o.since, o.lastVisitAt, { now: Date.now(), timeZone: ws.prefs.timezone, showCounts })}</span>
        ) : fresh ? <span className="fr"><i className="dot" />{formatCount(fresh)} new in {plural(ws.data.sources.length, "source")}</span> : o ? <span>{calmLine(o, { visited: !!o.lastVisitAt, items: ws.data.sources.reduce((n, s) => n + s.itemCount, 0), showCounts })}</span> : null}
      </p>
      {top.length > 1 ? (
        <p className="since-boxes">
          {top.map((b) => {
            const known = ws.collectionById.has(b.id);
            const label = showCounts ? `${b.name} · ${formatCount(b.count)}` : b.name;
            return known ? <button key={b.id} type="button" className="link" onClick={() => nav.go({ t: "c", id: b.id })}>{label}</button> : <span key={b.id}>{label}</span>;
          })}
          {(o?.since?.boxes.length ?? 0) > top.length ? <span>and {(o?.since?.boxes.length ?? 0) - top.length} more</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function RowBox({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  const hints = useHints();
  const ws = useWorkspace();
  const key = `home:${id}`;
  const shut = hints.collapsed.includes(key);
  const toggle = () => setHints({ collapsed: shut ? hints.collapsed.filter((x) => x !== key) : [...hints.collapsed, key] });
  return (
    <section className={`mod wb${shut ? " shut" : ""}`} aria-labelledby={`wb-${id}`}>
      <header className="mod-h">
        <h2 className="mod-t" id={`wb-${id}`}>
          <button type="button" aria-expanded={!shut} onClick={toggle}>
            <span className="t">{title}</span>
            {count !== undefined && ws.prefs.showCounts ? <span className="wb-n">{count}</span> : null}
            <Icon name="chev" size="sm" className="go fold" />
          </button>
        </h2>
      </header>
      {shut ? null : children}
    </section>
  );
}

const PROBLEM_HEALTH: ReadonlySet<SourceDTO["health"]> = new Set(["error", "login", "reconnect", "paused"]);

function Attention() {
  const ws = useWorkspace();
  const nav = useNav();
  const sources = ws.data.sources.filter((s) => PROBLEM_HEALTH.has(s.health));
  if (!sources.length) return null;
  return (
    <RowBox id="attention" title="Needs attention" count={sources.length}>
      <ul className="mod-b wb-attn">
        {sources.slice(0, 6).map((s) => (
          <li key={s.id}>
            <button type="button" className="wb-src" onClick={() => nav.go({ t: "s", id: s.id })}>
              <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={28} />
              <span className="t"><span className="title" dir="auto">{s.title}</span><span className="fine">{s.healthText ?? s.health}</span></span>
              <Icon name="chev" size="sm" />
            </button>
            <RetrySource id={s.id} title={s.title} health={s.health} />
          </li>
        ))}
      </ul>
      {sources.length > 6 ? <p className="fine wb-more">and {sources.length - 6} more in the sidebar</p> : null}
    </RowBox>
  );
}

/** To read is split in two rows: podcasts are To listen, everything else To read. */
const isToRead = (i: ItemDTO) => i.workflow === "toread" && i.kind !== "podcast";
const isToListen = (i: ItemDTO) => i.workflow === "toread" && i.kind === "podcast";

/** The items To read, To listen and Recently kept show right now (a collapsed row shows none): the boxes below leave these out. */
export function useShownAbove(): ReadonlySet<string> {
  const o = useHomeOverview().data;
  const hints = useHints();
  return useMemo(() => {
    const ids = new Set<string>();
    if (!o) return ids;
    const open = (row: string) => !hints.collapsed.includes(`home:${row}`);
    if (open("toread")) for (const it of o.toRead.items) ids.add(it.id);
    if (open("tolisten")) for (const it of o.toListen.items) ids.add(it.id);
    if (open("kept")) for (const it of o.recentlyKept) ids.add(it.id);
    return ids;
  }, [o, hints.collapsed]);
}

/** Under Home's rows: how many items the muted words left out of Home, and a way to see them. */
export function MutedLine() {
  const ws = useWorkspace();
  const o = useHomeOverview().data;
  const showing = (useSearch({ strict: false }) as { muted?: string }).muted === "show" && ws.prefs.mutedWords.length > 0;
  return <MutedNotice hidden={o?.mutedHidden ?? 0} atLeast={o?.mutedHiddenAtLeast} showing={showing} />;
}

/** Mark all as seen is offered only when New has piled up: a long time away, or a lot of New items. */
const FRESH_AWAY_MS = 30 * 86_400_000;
const FRESH_PILE = 50;

/**
 * A row of items put aside (To read or To listen): the oldest few, and Show all for the rest. An item taken out of To read or
 * ignored here leaves at once.
 */
function PutAsideRow({ id, title, row, keeps, type }: { id: string; title: string; row: HomeOverview["toRead"] | undefined; keeps: (i: ItemDTO) => boolean; type: string }) {
  const nav = useNav();
  const rc = useRowCtx();
  const items = useLive(row?.items ?? []).filter(keeps);
  const ctx = useMemo(() => ({ ...rc, leaves: (i: ItemDTO) => leavesOn(i, keeps, false) }), [rc, keeps]);
  if (!items.length) return null;
  const total = row?.total ?? 0;
  const totalKnown = !row?.totalAtMost; // muted words were not asked about every item of a long list: the number may be too high, so it is not shown
  return (
    <RowBox id={id} title={title} count={totalKnown ? total : undefined}>
      <RowContext.Provider value={ctx}><ul className="mod-b">{items.map((it) => <ItemRow key={it.id} item={it} />)}</ul></RowContext.Provider>
      {total > items.length ? <button type="button" className="mod-all" onClick={() => nav.go({ t: "r", id: "toread" }, { type })}>Show all{totalKnown ? ` ${total}` : ""}<Icon name="chev" size="sm" /></button> : null}
    </RowBox>
  );
}

/** To read, To listen, Recently kept, Needs attention and Mark all as seen. */
export function WelcomeRows() {
  const ws = useWorkspace();
  const actions = useItemActions();
  const o = useHomeOverview().data;
  const rc = useRowCtx();
  // Recently kept lists kept items whatever their state, so nothing leaves it from here.
  const keptCtx = useMemo(() => ({ ...rc, leaves: () => "" }), [rc]);
  const kept = useLive(o?.recentlyKept ?? []);
  const fresh = o?.fresh ?? 0;
  const longAway = !!o?.lastVisitAt && Date.now() - Date.parse(o.lastVisitAt) > FRESH_AWAY_MS;
  const offerFresh = fresh > 0 && ws.prefs.freshMarkers && (longAway || fresh >= FRESH_PILE);
  const rows = [
    <PutAsideRow key="toread" id="toread" title="To read" row={o?.toRead} keeps={isToRead} type="articles,videos" />,
    <PutAsideRow key="tolisten" id="tolisten" title="To listen" row={o?.toListen} keeps={isToListen} type="podcasts" />,
    kept.length ? (
      <RowBox key="kept" id="kept" title="Recently kept">
        <RowContext.Provider value={keptCtx}><ul className="mod-b">{kept.map((it) => <ItemRow key={it.id} item={it} />)}</ul></RowContext.Provider>
      </RowBox>
    ) : null,
    <Attention key="attention" />,
    offerFresh ? (
      <section key="fresh" className="mod wb wb-fresh" aria-label="Mark all as seen">
        <div className="wb-fresh-in">
          <div>
            <b>Mark all as seen</b>
            <p className="fine">{ws.prefs.showCounts ? `Takes the New marker off ${plural(fresh, "item")}.` : "Takes the New marker off every New item."} Nothing is finished, ignored or deleted. Undo brings the markers back.</p>
          </div>
          <Button onClick={() => void actions.clearFresh("all")}>Mark all as seen</Button>
        </div>
      </section>
    ) : null,
  ].filter(Boolean);
  if (!rows.length) return null;
  return <div className="wb-stack">{rows}</div>;
}
