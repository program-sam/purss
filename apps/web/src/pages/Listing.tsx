import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { ItemDTO, ItemIds, SourceDTO } from "@purss/domain";
import type { FULL_TEXT_BACKFILL as DomainFullTextBackfill } from "@purss/domain";
import { Avatar, AvatarStack, Button, Icon, useBreakpoint } from "@purss/ui";
import type { MenuEntry } from "@purss/ui";
import { get, messageOf, patch } from "../api/client.ts";
import type { ListParams } from "../api/queries.ts";
import { itemListQuery, refreshWorkspace } from "../api/queries.ts";
import { QUILT } from "./Home.tsx";
import { EngineNotice } from "../components/EngineNotice.tsx";
import { RetrySource } from "../components/RetrySource.tsx";
import { LoadMore } from "../components/LoadMore.tsx";
import { Names } from "../components/Names.tsx";
import { RowContext } from "../components/row-context.tsx";
import { useProgressive } from "../lib/use-progressive.ts";
import { useRowContextValue } from "../components/use-row-context.ts";
import { TO_READ_TITLE } from "../lib/constants.ts";
import { plural, timeAgo } from "../lib/format.ts";
import { pausedUntilLine } from "../lib/returning.ts";
import { belongsInList } from "../lib/items.ts";
import { withOpenItem } from "../lib/open-hold.ts";
import { useCachedItem } from "../api/use-item.ts";
import { useOpenHold } from "../state/open-hold.ts";
import { describeQuery } from "../lib/query-builder.ts";
import type { Place } from "../nav.ts";
import { statsPathFor, useNav } from "../nav.ts";
import { platform } from "../platform/index.ts";
import { useItemActions } from "../state/actions.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useSelection } from "../state/selection.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { BoardView } from "../views/BoardView.tsx";
import { CardsView } from "../views/CardsView.tsx";
import { ListView } from "../views/ListView.tsx";
import { TableView } from "../views/TableView.tsx";
import { TimelineView } from "../views/TimelineView.tsx";
import { useListState } from "./list-state.ts";
import { filterParam, isNarrowed, listFilters } from "../lib/list-filters.ts";
import { MutedNotice } from "../components/MutedNotice.tsx";
import { isolate } from "../lib/bidi.ts";
import { ListTools } from "../shell/ListTools.tsx";
import { SourceFilter } from "../shell/SourceFilter.tsx";
import { Trail } from "../shell/crumbs.tsx";
import { leaveThen } from "../lib/leave.ts";

/** How many recent items get a copy when full articles are turned on; the same value as in the shared contract (the browser imports types only). */
const FULL_TEXT_BACKFILL: typeof DomainFullTextBackfill = 20;

type ListPlace = Exclude<Place, { t: "home" }>;

function useItems(place: ListPlace) {
  const ls = useListState(place);
  const board = ls.view === "board";
  // The board always needs the ignored column; timeline follows publication date, so it only sorts by date.
  const apiFilter = board && (ls.filter === "active" || ls.filter === "all") ? "all" : ls.filter;
  const sort = ls.view === "timeline" && ls.sort !== "oldest" ? "newest" : ls.sort;
  const params: ListParams = { scope: ls.scope, filter: apiFilter, sort, ...listFilters(ls) };
  const q = useInfiniteQuery(itemListQuery(params));
  const keeps = useCallback((i: ItemDTO) => belongsInList(i, ls.scope, apiFilter), [ls.scope, apiFilter]);
  // The item open in the panel keeps its place, still New, until the panel closes.
  const held = useOpenHold();
  const openCopy = useCachedItem(held ?? undefined);
  const lastShown = useRef<ItemDTO[]>([]);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ItemDTO[] = [];
    for (const page of q.data?.pages ?? []) for (const it of page.items) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    return withOpenItem(out, keeps, held, openCopy, lastShown.current);
  }, [q.data, keeps, held, openCopy]);
  useEffect(() => { lastShown.current = items; }, [items]);
  return { ls, q, items, keeps, params, total: q.data?.pages[0]?.total ?? null };
}

function SourceNotes({ s, tz }: { s: SourceDTO; tz: string }) {
  const note = (icon: "key" | "moon" | "pause" | "alert" | "clock" | "link", text: string, warn = false) => <p key={text} className={`note${warn ? " login" : ""}`}><Icon name={icon} /><span>{text}</span></p>;
  const out = [];
  if (s.health === "login") out.push(note("key", "Full text needs a login. Titles and summaries still arrive.", true));
  if (s.health === "quiet") out.push(note("moon", s.healthText ?? "No new posts for a while. Still following."));
  if (s.health === "paused") out.push(note("pause", s.pausedUntil ? `Paused. ${pausedUntilLine(s.pausedUntil, tz)}. No new items arrive until then.` : "Paused. No new items arrive until you resume."));
  if (s.health === "error") out.push(<p key="error" className="note login"><Icon name="alert" /><span>{s.healthText ?? "This source couldn't be collected just now."} <RetrySource id={s.id} title={s.title} health={s.health} /></span></p>);
  if (s.health === "reconnect") out.push(note("link", s.healthText ?? "This source needs to be reconnected.", true));
  if (s.health === "pending") out.push(note("clock", "Collecting the first items…"));
  return <>{out}</>;
}

function Head({ place, freshHere, onClearFresh }: { place: ListPlace; freshHere: number; onClearFresh: () => void }) {
  const tools = <ListTools place={place} />;
  const ws = useWorkspace();
  const nav = useNav();
  const qc = useQueryClient();
  const ls = useListState(place);
  const overlays = useOverlays();
  const popups = usePopups();
  const { toast } = useToasts();
  const xs = useBreakpoint() === "xs";
  const fresh = freshHere > 0 ? (
    <>
      <span className="fr"><i className="dot" />{freshHere} new</span>
      <button type="button" className="link" onClick={onClearFresh}>Mark all as seen</button>
    </>
  ) : null;

  if (place.t === "c") {
    const c = ws.collectionById.get(place.id);
    if (!c) return null;
    const srcs = ws.sourcesOf(c);
    return (
      <>
        <div className="phead">
          <h1>{c.emoji ? <span aria-hidden="true">{c.emoji} </span> : null}<bdi>{c.name}</bdi></h1>
          <div className="psub">
            {c.mode === "sources" ? <span className="ring-sky" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><AvatarStack sources={srcs} max={5} /><span>{plural(srcs.length, "source")}</span></span>
              : <span className="tag">Filter</span>}
            {c.mode !== "sources" ? <span>{plural(c.itemCount, "item")}</span> : null}
            {c.mode === "query" ? <span>{describeQuery(c.query, { source: (id) => ws.sourceById.get(id)?.title ?? "a source" })}</span> : null}
            {fresh}
            <button type="button" className="plink" onClick={() => nav.goPath(statsPathFor({ t: "c", id: c.id }))}><Icon name="chart" size="sm" />Statistics</button>
            <button type="button" className="plink" aria-haspopup="dialog" onClick={() => overlays.open({ kind: "share", target: "collection", targetId: c.id, name: c.name })}><Icon name="link" size="sm" />Share</button>
          </div>
          {tools}
        </div>
        {c.mode === "sources" && srcs.length > 1 ? <SourceFilter place={place} sources={srcs} /> : null}
      </>
    );
  }

  if (place.t === "s") {
    const s = ws.sourceById.get(place.id);
    if (!s) return null;
    const notifyValue = { default: "Same as Settings", on: "On", muted: "Muted" }[s.notify];
    const url = `/api/sources/${encodeURIComponent(s.id)}`;
    const pause = async (pauseFor: "week" | "month" | "until-resumed") => {
      try {
        await patch(url, { pauseFor });
        refreshWorkspace(qc);
        toast(`Paused ${isolate(s.title)}${pauseFor === "until-resumed" ? "" : pauseFor === "week" ? " for a week" : " for a month"}`, { undo: async () => { await patch(url, { paused: false }); refreshWorkspace(qc); } });
      } catch (err) { toast(messageOf(err), { tone: "error" }); }
    };
    const resume = async () => {
      // Undo puts the pause back as it was: for a while if it had an end, until resumed if not.
      const left = s.pausedUntil ? Date.parse(s.pausedUntil) - Date.now() : null;
      const back = left === null ? "until-resumed" : left > 8 * 86_400_000 ? "month" : "week";
      try {
        await patch(url, { paused: false });
        refreshWorkspace(qc);
        toast(`Resumed ${isolate(s.title)}`, { undo: async () => { await patch(url, { pauseFor: back }); refreshWorkspace(qc); } });
      } catch (err) { toast(messageOf(err), { tone: "error" }); }
    };
    const setNotify = async (notify: SourceDTO["notify"]) => {
      try { await patch(`/api/sources/${encodeURIComponent(s.id)}`, { notify }); refreshWorkspace(qc, { items: false }); toast(`Notifications for ${isolate(s.title)}: ${notify === "default" ? "same as Settings" : notify === "on" ? "on" : "muted"}`); }
      catch (err) { toast(messageOf(err), { tone: "error" }); }
    };
    const setFullText = async (fullText: boolean) => {
      try {
        await patch(`/api/sources/${encodeURIComponent(s.id)}`, { fullText });
        refreshWorkspace(qc, { items: false });
        toast(fullText ? `Fetching full articles for ${isolate(s.title)}: new items and up to ${FULL_TEXT_BACKFILL} recent unfinished ones` : `Stopped fetching full articles for ${isolate(s.title)}. Saved copies stay`);
      } catch (err) { toast(messageOf(err), { tone: "error" }); }
    };
    // What a phone's Manage menu holds besides Notifications, for the hint under the buttons.
    const manageHolds = [...(s.fullTextAvailable ? ["Full articles"] : []), "Notifications"];
    const collections = s.collectionIds.map((id) => ws.collectionById.get(id)).filter((c) => !!c);
    const notifyEntries: MenuEntry[] = (["default", "on", "muted"] as const).map((v) => ({ type: "radio", label: { default: "Same as Settings", on: "Notify me about this source", muted: "Mute this source" }[v], on: s.notify === v, onSelect: () => void setNotify(v) }));
    const pauseEntries: MenuEntry[] = s.paused
      ? [{ label: "Resume collecting", icon: "pause", onSelect: () => void resume() }]
      : [{ type: "heading", label: "Pause collecting" }, { label: "For a week", icon: "pause", onSelect: () => void pause("week") }, { label: "For a month", icon: "pause", onSelect: () => void pause("month") }, { label: "Until I resume it", icon: "pause", onSelect: () => void pause("until-resumed") }];
    const manageButton = (
      <button type="button" className="mbtn" aria-haspopup="menu" onClick={(e) => popups.menu(e.currentTarget, [
            // A phone has no room for the setting buttons, so they open from here.
            ...(xs ? [
              { type: "heading" as const, label: "Notifications" }, ...notifyEntries,
              ...(s.fullTextAvailable ? [{ type: "check" as const, label: "Full articles", on: s.fullText, onSelect: () => void setFullText(!s.fullText) }] : []),
              { type: "separator" as const },
            ] : []),
            ...pauseEntries,
            { label: "Rename…", icon: "pencil", onSelect: () => overlays.open({ kind: "rename-source", id: s.id }) },
            { label: "Change collections…", icon: "folder", onSelect: () => overlays.open({ kind: "move-source", id: s.id }) },
            { label: "Smart filter…", icon: "filter", onSelect: () => overlays.open({ kind: "ai-filter", sourceId: s.id }) },
            { type: "separator" },
            { label: "Unfollow…", icon: "trash", danger: true, onSelect: () => overlays.open({ kind: "unfollow", id: s.id }) },
          ], `Manage ${s.title}`)}><Icon name="gear" />Manage<Icon name="chev" size="sm" /></button>
    );
    return (
      <div className="phead">
        <div className="ptitle">
          <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={44} />
          <div className="ptitle-t">
            <h1 dir="auto">{s.title}</h1>
            <div className="psub">
              <span className="tag">{s.kind === "youtube" ? <Icon name="play" /> : <span className="rss"><Icon name="rss" /></span>}{s.origin}</span>
              {s.curator ? <span>Shared by {s.curator}</span> : null}
              {s.lastItemAt ? <span>Latest {timeAgo(s.lastItemAt, Date.now(), ws.prefs.timezone)}</span> : null}
              {collections.length ? <span>In <Names names={collections.map((c) => c!.name)} /></span> : null}
              {fresh}
              <button type="button" className="plink" onClick={() => nav.goPath(statsPathFor({ t: "s", id: s.id }))}><Icon name="chart" size="sm" />Statistics</button>
              {xs ? manageButton : null}
            </div>
          </div>
        </div>
        <SourceNotes s={s} tz={ws.prefs.timezone} />
        <div className="srcacts">
          {xs ? null : <button type="button" className="mbtn" aria-haspopup="menu" onClick={(e) => popups.menu(e.currentTarget, notifyEntries, "Notifications for this source")}><Icon name="bell" />Notifications<span className="val">{notifyValue}</span><Icon name="chev" size="sm" /></button>}
          {s.fullTextAvailable && !xs ? (
            <button type="button" className="mbtn" aria-pressed={s.fullText} title="Save a readable copy of each new post's page, to read here and offline"
              onClick={() => void setFullText(!s.fullText)}><Icon name="item" />Full articles<span className="val">{s.fullText ? "On" : "Off"}</span><span className={`sw${s.fullText ? " on" : ""}`} aria-hidden="true" /></button>
          ) : null}
          {xs ? null : manageButton}
        </div>
        {xs ? <p className="srcacts-hint">Find {manageHolds.slice(0, -1).join(", ")}{manageHolds.length > 1 ? " and " : ""}Notifications under Manage.</p> : null}
        {tools}
      </div>
    );
  }

  if (place.t === "r") {
    return (
      <div className="phead">
        <h1>{TO_READ_TITLE}</h1>
        <div className="psub"><span>Everything you marked To read.</span>{fresh}</div>
        {tools}
      </div>
    );
  }

  const b = ws.basketById.get(place.id);
  if (!b) return null;
  return (
    <div className="phead">
      <h1 dir="auto">{b.name}</h1>
      <div className="psub"><span>{plural(b.itemCount, "item")}</span>{fresh}<button type="button" className="plink" aria-haspopup="dialog" onClick={() => overlays.open({ kind: "share", target: "basket", targetId: b.id, name: b.name })}><Icon name="link" size="sm" />Share</button></div>
      <p className="fine">{b.captureMode === "text" ? "Keeps each item's link, summary and readable text" : "Keeps each item's link and summary"}. The original page may still change or disappear.</p>
      {tools}
    </div>
  );
}

/** Select all takes every item the list shows, not only the pages loaded so far (up to MAX_BULK_ITEMS). */
function SelectionBar({ params, total, inBasket }: { params: ListParams; total: number | null; inBasket: boolean }) {
  const sel = useSelection();
  const actions = useItemActions();
  const overlays = useOverlays();
  const { toast } = useToasts();
  const [gathering, setGathering] = useState(false);
  const n = sel.selected.size;
  const selectAll = async () => {
    setGathering(true);
    try {
      const out = await get<ItemIds>("/api/items/ids", { ...params });
      sel.selectAll(out.ids);
      if (out.total > out.ids.length) toast(`Selected the first ${plural(out.ids.length, "item")} of ${out.total}. Act on these, then select again for the rest.`);
    } catch (err) { toast(messageOf(err), { tone: "error" }); }
    finally { setGathering(false); }
  };
  const ids = () => [...sel.selected];
  const dis = n === 0;
  return (
    <div className="selbar" role="toolbar" aria-label="Actions for selected items">
      <span className="cnt2" aria-live="polite">{n} selected</span>
      <Button disabled={dis} onClick={() => { const i = ids(); sel.clear(); void leaveThen(i, "toread", () => actions.setWorkflow(i, "toread")); }}>To read</Button>
      <Button disabled={dis} onClick={() => { const i = ids(); sel.clear(); void leaveThen(i, "finished", () => actions.setWorkflow(i, "finished")); }}>Finished</Button>
      {inBasket ? null : <Button disabled={dis} onClick={() => { const i = ids(); sel.clear(); void leaveThen(i, "ignored", () => actions.setWorkflow(i, "ignored")); }}>Ignore</Button>}
      <Button disabled={dis} aria-haspopup="dialog" onClick={() => overlays.open({ kind: "keep-in", itemIds: ids() })}>Keep in…</Button>
      <Button disabled={dis} onClick={() => { const i = ids(); sel.clear(); void actions.clearFreshFor(i); }}>Mark as seen</Button>
      <Button disabled={dis} aria-haspopup="dialog" onClick={() => overlays.open({ kind: "delete-items", itemIds: ids() })}>Delete…</Button>
      <span className="sp" />
      <button type="button" className="link" disabled={gathering} onClick={() => void selectAll()}>{total != null && total > 0 ? `Select all ${total}` : "Select all"}</button>
      <Button variant="primary" onClick={() => sel.setSelecting(false)}>Done</Button>
    </div>
  );
}

function Empty({ place, ls, hasSources }: { place: ListPlace; ls: ReturnType<typeof useListState>; hasSources: boolean }) {
  const nav = useNav();
  const overlays = useOverlays();
  const ws = useWorkspace();
  // A basket's everything filter includes ignored items; elsewhere it leaves them out.
  const everything = place.t === "b" ? "all" : "active";
  if (ls.filter !== everything || isNarrowed(ls)) {
    return <div className="empty card-like"><h2>{ls.filter === "ignored" ? "Nothing ignored" : "Nothing matches this filter"}</h2><Button onClick={() => nav.patchSearch({ filter: filterParam(ls, everything), source: undefined, without: undefined, type: undefined, length: undefined, capture: undefined })}>Show all items</Button></div>;
  }
  if (place.t === "c") {
    const c = ws.collectionById.get(place.id);
    if (c?.mode === "sources" && !hasSources) return <div className="empty card-like"><h2>No sources in this collection yet</h2><Button variant="primary" onClick={() => overlays.open({ kind: "add-source", collectionId: place.id })}><Icon name="plus" size="sm" />Add source</Button></div>;
  }
  if (place.t === "s") {
    // The source's own note above says why nothing is arriving; only promise items when they can come.
    const health = ws.sourceById.get(place.id)?.health;
    if (health === "paused") return <div className="empty card-like"><h2>Nothing collected yet</h2><p>Resume this source to start collecting.</p></div>;
    if (health === "error" || health === "reconnect") return <div className="empty card-like"><h2>Nothing collected yet</h2></div>;
    if (health === "quiet" && ws.sourceById.get(place.id)?.itemCount === 0) return <div className="empty card-like"><h2>No posts yet</h2><p>Nothing in this feed yet. New posts will appear here.</p></div>;
    return <div className="empty card-like"><h2>No new items for now</h2></div>;
  }
  if (place.t === "r") return <div className="empty card-like"><h2>Nothing marked To read</h2><p>Items you mark To read show up here.</p></div>;
  if (place.t === "b") {
    return (
      <div className="empty card-like"><h2>Nothing kept here yet</h2><p>Use the bookmark on any item to keep it here.</p>
        {platform.connection ? null : <p>To keep pages from other sites, use the <button type="button" className="link" onClick={() => overlays.open({ kind: "settings", tab: "apps" })}>browser extension or a bookmarklet</button>.</p>}
      </div>
    );
  }
  return <div className="empty card-like"><h2>Nothing here yet</h2></div>;
}

export function ListingPage({ place }: { place: ListPlace }) {
  const ws = useWorkspace();
  const nav = useNav();
  const sel = useSelection();
  const actions = useItemActions();
  const { ls, q, items, keeps, params, total } = useItems(place);
  const basket = place.t === "b" ? ws.basketById.get(place.id) ?? null : null;
  const rowCtx = useRowContextValue(basket, keeps);
  const shown = useProgressive(items.length, `${ls.view}:${ls.filter}:${ls.sort}:${JSON.stringify(listFilters(ls))}`);
  // Long lists are drawn in batches; until every loaded row is on the page, nothing loads more.
  const drawn = shown < items.length ? items.slice(0, shown) : items;

  const exists = place.t === "c" ? ws.collectionById.has(place.id) : place.t === "s" ? ws.sourceById.has(place.id) : place.t === "r" ? place.id === "toread" : ws.basketById.has(place.id);
  if (!exists) {
    return (
      <div className="col narrow"><div className="empty card-like" style={{ marginTop: 40 }}><h2>That {place.t === "c" ? "collection" : place.t === "s" ? "source" : "basket"} isn't here</h2><p>It may have been removed.</p><Button onClick={() => nav.go({ t: "home" })}>Go to Home</Button></div></div>
    );
  }
  const freshHere = place.t === "c" ? ws.collectionById.get(place.id)!.freshCount : place.t === "s" ? ws.sourceById.get(place.id)!.freshCount : items.filter((i) => i.fresh).length;
  const loadingFirst = q.isPending;
  const mutedHidden = q.data?.pages[0]?.mutedHidden ?? 0;
  const mutedAtLeast = !!q.data?.pages[0]?.mutedHiddenAtLeast;
  const hasSources = place.t === "c" ? ws.sourcesOf(ws.collectionById.get(place.id)!).length > 0 : true;

  let body;
  if (loadingFirst) body = <div className="list" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel" style={{ height: 40, margin: 10 }} />)}</div>;
  else if (q.isError) body = <div className="empty card-like"><h2>Couldn't load these items</h2><p>{messageOf(q.error)}</p><Button onClick={() => void q.refetch()}>Try again</Button></div>;
  else if (!items.length) body = <Empty place={place} ls={ls} hasSources={hasSources} />;
  else {
    const view = ls.view === "board" ? <BoardView params={{ scope: ls.scope, sort: ls.sort, ...listFilters(ls) }} onMove={(ids, to) => { sel.clear(); return actions.setWorkflow(ids, to); }} />
      : ls.view === "table" ? <TableView items={drawn} sort={ls.sort} onSort={(s) => nav.patchSearch({ sort: s === "newest" ? undefined : s })} />
      : ls.view === "cards" ? <CardsView items={drawn} />
      : ls.view === "timeline" ? <TimelineView items={drawn} />
      : <ListView items={drawn} />;
    body = (
      <>
        {view}
        {ls.view !== "board" && drawn === items ? <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} /> : null}
        {ls.filter === "active" && place.t !== "b" ? <p className="fine" style={{ marginTop: 12 }}>Ignored items are hidden. <button type="button" className="link" onClick={() => nav.patchSearch({ filter: filterParam(ls, "all") })}>Show ignored</button></p> : null}
        {ls.filter === "all" && place.t !== "b" ? <p className="fine" style={{ marginTop: 12 }}>Ignored items are showing. <button type="button" className="link" onClick={() => nav.patchSearch({ filter: filterParam(ls, "active") })}>Hide ignored</button></p> : null}
      </>
    );
  }

  return (
    <RowContext.Provider value={rowCtx}>
      <div className="pagewash" aria-hidden="true">{QUILT}</div>
      {/* Every view of a place shares one column, so switching views keeps the page still. */}
      <div className={`col wide${place.t === "s" ? " in-source" : ""}`}>
        <EngineNotice />
        <Trail />
        <Head place={place} freshHere={freshHere} onClearFresh={() => void actions.clearFresh(ls.scope)} />
        {sel.selecting ? <SelectionBar params={params} total={total} inBasket={place.t === "b"} /> : null}
        {ls.captureFailed ? <p className="fine capture-only">Showing only items whose text couldn't be saved. <button type="button" className="link" onClick={() => nav.patchSearch({ capture: undefined })}>Show everything</button></p> : null}
        {body}
        {loadingFirst || q.isError ? null : <MutedNotice hidden={mutedHidden} atLeast={mutedAtLeast} showing={ls.showMuted && ws.prefs.mutedWords.length > 0} />}
      </div>
    </RowContext.Provider>
  );
}
