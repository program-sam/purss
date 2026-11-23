import { app } from "@purss/translations/app";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { CollectionDTO, ItemDTO, Preferences } from "@purss/domain";
import { AvatarStack, Button, Icon, useBreakpoint } from "@purss/ui";
import { PAGE, itemListQuery, itemPreviewQuery } from "../api/queries.ts";
import type { ListParams } from "../api/queries.ts";
import { EngineNotice } from "../components/EngineNotice.tsx";
import { ItemRow } from "../components/ItemRow.tsx";
import { ComingUp } from "../components/ComingUp.tsx";
import { ReminderCard } from "../components/ReminderCard.tsx";
import { ReviewNotice } from "../features/review/ReviewNotice.tsx";
import { RowContext } from "../components/row-context.tsx";
import { useRowContextValue } from "../components/use-row-context.ts";
import { FreshDot } from "../components/item-bits.tsx";
import { Names } from "../components/Names.tsx";
import { workflowLabel } from "../lib/constants.ts";
import { groupByDay, plural, timeAgo } from "../lib/format.ts";
import { itemDate, matchesFilter } from "../lib/items.ts";
import { withOpenItem } from "../lib/open-hold.ts";
import { useOpenHold } from "../state/open-hold.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useSavePreferences } from "../state/prefs.ts";
import { useItemActions } from "../state/actions.ts";
import { useRowCtx } from "../components/row-context.tsx";
import { setHints, useHints } from "../state/ui-store.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { HomeBand, MutedLine, WelcomeRows } from "./WelcomeBack.tsx";
import { DEDUPE_SLACK, boxScope, distribute, homeBoxes, isOtherBox } from "./home-boxes.ts";
import "./home.css";

const t = app.pages.home;

/** The quilted pattern of the page wash; Home shows it fully, other page heads faintly. */
export const QUILT = (
  <svg className="quilt" aria-hidden="true" focusable="false">
    <defs><pattern id="quilt" width="96" height="96" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H96M0 0V96" /><circle r="2.6" /></pattern></defs>
    <rect width="100%" height="100%" fill="url(#quilt)" />
  </svg>
);

/** How many items each part of Home asks for. */
/** Items fetched per Home box: eight, or five each when there are many boxes. */
export function moduleItems(boxes: number): number {
  return boxes <= 4 ? 8 : 5;
}
/** Boxes stacked in one column list five, so the next box starts on screen too. */
const ONE_COLUMN_ROWS = 5;
const HEADLINE_ITEMS = 5;
const GROUP_ITEMS = 25;

/**
 * Home's lists show Undecided items (`new`), newest first; the Only new layout shows New items (`fresh`), Undecided first. The server orders them (`mix=home`).
 * `showMuted` lists what muted words leave out.
 */
const homeParams = (scope: string, filter: "new" | "fresh", o: { showMuted?: boolean } = {}): ListParams =>
  ({ scope, filter, sort: "newest", mix: "home", ...(o.showMuted ? { muted: "show" as const } : {}) });

/** Whether the person asked to see the items that muted words leave out (`?muted=show`). */
function useShowMuted(): boolean {
  return (useSearch({ strict: false }) as { muted?: string }).muted === "show";
}

/** The Home boxes: the collections chosen for Home, and "Other sources" when it has any. */
function useBoxes(): CollectionDTO[] {
  const ws = useWorkspace();
  return useMemo(() => homeBoxes(ws.homeCollections, ws.looseSources, ws.prefs), [ws.homeCollections, ws.looseSources, ws.prefs]);
}

/**
 * What each box lists: what it fetched, without the items an earlier box already shows (a source can be in several collections).
 * A box asks for a few more than `limit` to make up for that, and shows `rows[i]` of them (`limit` each unless given; none for a
 * collapsed box): only the items shown count against the boxes after it. A change made here (an item put aside, ignored or
 * finished) takes it out of its box at once, and the spare items fetched beyond the rows fill its place.
 */
function useBoxLists(boxes: readonly CollectionDTO[], filter: "new" | "fresh", limit: number, rows: readonly number[] = boxes.map(() => limit)): { items: ItemDTO[]; pending: boolean }[] {
  const showMuted = useShowMuted();
  const results = useQueries({ queries: boxes.map((c) => itemPreviewQuery(homeParams(boxScope(c), filter, { showMuted }), limit + DEDUPE_SLACK)) });
  const held = useOpenHold();
  const lists = distribute(results.map((r) => withOpenItem(r.data?.items ?? [], (i) => matchesFilter(i, filter), held)), rows);
  return results.map((r, i) => ({ items: lists[i]!, pending: r.isPending }));
}

/** The item requests Home makes for a layout, so the offline pack can save the same answers. Keep in step with the layouts below. */
export function homeRequests(layout: Preferences["homeLayout"], shown: readonly CollectionDTO[]): { params: ListParams; limit: number }[] {
  const inCollection = (c: CollectionDTO, filter: "new" | "fresh", limit: number) => ({ params: homeParams(boxScope(c), filter), limit: limit + DEDUPE_SLACK });
  switch (layout) {
    case "collections": return shown.map((c) => inCollection(c, "new", moduleItems(shown.length)));
    case "feed": return [{ params: homeParams("home", "new"), limit: PAGE }];
    case "new": return shown.map((c) => inCollection(c, "fresh", GROUP_ITEMS));
    case "front": return shown.map((c) => inCollection(c, "new", HEADLINE_ITEMS));
  }
}

function Module({ c, items, pending, onMenu }: { c: CollectionDTO; items: ItemDTO[]; pending: boolean; onMenu: (c: CollectionDTO, anchor: HTMLElement) => void }) {
  const ws = useWorkspace();
  const nav = useNav();
  const hints = useHints();
  const sources = ws.sourcesOf(c);
  const other = isOtherBox(c);
  const shut = hints.collapsed.includes(`mod:${c.id}`);
  const heading = (
    <>
      {c.emoji ? <span aria-hidden="true">{c.emoji}</span> : null}<span className="t" dir="auto">{c.name}</span>{other ? null : <Icon name="chev" size="sm" className="go" />}
      {sources.length ? <AvatarStack sources={sources} /> : null}{sources.length ? <span className="one"><Names names={sources.map((x) => x.title)} /></span> : null}<span className="sr">({plural(sources.length || c.itemCount, c.mode === "sources" ? app.words.sourceLower : app.words.item)})</span>
    </>
  );
  return (
    <section className={`mod${shut ? " shut" : ""}${sources.length === 1 ? " in-source" : ""}`} aria-labelledby={`mt-${c.id}`}>
      <header className="mod-h">
        <h2 className="mod-t" id={`mt-${c.id}`}>
          {other ? <span className="mod-plain">{heading}</span> : <button type="button" onClick={() => nav.go({ t: "c", id: c.id })}>{heading}</button>}
        </h2>
        {shut && c.freshCount ? <span className="mod-fresh"><i className="dot" />{c.freshCount}<span className="sr">{app.words.newSpaced}</span></span> : null}
        <button type="button" className="ibtn" aria-haspopup="menu" aria-label={`Options for ${c.name}`} onClick={(e) => onMenu(c, e.currentTarget)}><Icon name="more" /><span className="ml" aria-hidden="true">{app.words.more}</span></button>
      </header>
      {shut ? null : items.length ? (
        <>
          <ul className="mod-b">{items.map((it) => <ItemRow key={it.id} item={it} />)}</ul>
          {other ? null : <button type="button" className="mod-all" onClick={() => nav.go({ t: "c", id: c.id })}>{t.open}<bdi>{c.name}</bdi>{c.itemCount ? <span> · {plural(c.itemCount, app.words.item)}</span> : null}<Icon name="chev" size="sm" /></button>}
        </>
      ) : pending ? <div className="mod-empty"><span className="skel" style={{ height: 14, width: "60%" }} /></div> : (
        <div className="mod-empty">
          <span>{other || (c.mode === "sources" && sources.length) ? t.nothingNewYet : c.mode === "sources" ? t.noSources : t.nothingHere}</span>
        </div>
      )}
    </section>
  );
}

/** Home shows collections, so say why none are here and offer the step that fixes it. */
function NoHomeCollections({ inline = false }: { inline?: boolean }) {
  const ws = useWorkspace();
  const overlays = useOverlays();
  const [title, text, action]: [string, string | null, { label: string; open: () => void }] = ws.collections.length
    ? [t.noCollectionsOnHome, null, { label: app.words.customiseHome, open: () => overlays.open({ kind: "customise-home" }) }]
    : ws.looseSources.length
      ? [t.sourcesNotInCollection, t.putInCollection, { label: app.words.newCollection, open: () => overlays.open({ kind: "new-collection" }) }]
      : [t.noCollectionsYet, null, { label: app.words.addSource, open: () => overlays.open({ kind: "add-source" }) }];
  if (inline) return <p className="fine">{title}. {text ? `${text} ` : ""}<button type="button" className="link" onClick={action.open}>{action.label}</button></p>;
  return <div className="empty card-like"><h2>{title}</h2>{text ? <p>{text}</p> : null}<Button onClick={action.open}>{action.label}</Button></div>;
}

/**
 * How many columns of boxes fit. The width is measured before the first paint, so the boxes are laid out once and
 * stay where they are; only resizing the window moves them.
 */
export function useColumns(): number {
  const bp = useBreakpoint();
  const [width, setWidth] = useState(() => document.getElementById("main")?.clientWidth ?? 0);
  useLayoutEffect(() => {
    const el = document.getElementById("main");
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return bp === "sm" || bp === "xs" ? 1 : bp === "xl" && width >= 1320 ? 3 : width >= 1080 ? 2 : 1;
}

function CollectionsLayout() {
  const ws = useWorkspace();
  const popups = usePopups();
  const overlays = useOverlays();
  const save = useSavePreferences();
  const hints = useHints();
  const boxes = useBoxes();
  const fits = useColumns();
  const n = Math.max(1, Math.min(fits, boxes.length));
  const limit = moduleItems(boxes.length);
  // A collapsed box shows no rows, so it keeps no item from the boxes after it; in one column a box shows fewer rows.
  const rows = boxes.map((c) => (hints.collapsed.includes(`mod:${c.id}`) ? 0 : n === 1 ? Math.min(limit, ONE_COLUMN_ROWS) : limit));
  const lists = useBoxLists(boxes, "new", limit, rows);

  function menu(c: CollectionDTO, anchor: HTMLElement) {
    // The saved order holds every collection, so moving a box swaps it with its neighbour among the boxes shown.
    const shownIds = boxes.map((x) => x.id);
    const i = shownIds.indexOf(c.id);
    const shut = hints.collapsed.includes(`mod:${c.id}`);
    const move = (d: -1 | 1) => {
      const next = [...shownIds];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      const hidden = ws.collections.filter((x) => !x.showOnHome).map((x) => x.id);
      void save({ homeCollectionIds: [...next, ...hidden] });
    };
    popups.menu(anchor, [
      { label: shut ? t.expand : t.collapse, icon: shut ? "unfold" : "fold", onSelect: () => setHints({ collapsed: shut ? hints.collapsed.filter((x) => x !== `mod:${c.id}`) : [...hints.collapsed, `mod:${c.id}`] }) },
      { label: t.moveUp, icon: "up", disabled: i <= 0, onSelect: () => move(-1) },
      { label: t.moveDown, icon: "down", disabled: i >= shownIds.length - 1, onSelect: () => move(1) },
      ...(isOtherBox(c) ? [
        { type: "separator" as const },
        { label: app.words.hideFromHome, icon: "fold" as const, onSelect: () => void save({ homeOther: false }) },
      ] : [
        { type: "separator" as const },
        { label: app.words.collectionSettings, icon: "gear" as const, onSelect: () => overlays.open({ kind: "collection-settings", id: c.id }) },
      ]),
    ], `Options for ${c.name}`);
  }

  if (!boxes.length) return <NoHomeCollections />;
  const buckets: number[][] = Array.from({ length: n }, () => []);
  boxes.forEach((_, i) => buckets[i % n]!.push(i));
  return (
    <div className="mods">{buckets.map((b, col) => (
      <div className="mcol" key={col}>{b.map((i) => <Module key={boxes[i]!.id} c={boxes[i]!} items={lists[i]!.items} pending={lists[i]!.pending} onMenu={menu} />)}</div>
    ))}</div>
  );
}

/** Everything in one list, paged by the server and strictly newest first: the sources of the boxes shown on Home, whichever boxes are hidden. */
function useFeedItems(): { items: ItemDTO[]; loading: boolean; more: (() => void) | null } {
  const showMuted = useShowMuted();
  const paged = useInfiniteQuery(itemListQuery(homeParams("home", "new", { showMuted })));
  const held = useOpenHold();
  return useMemo(
    () => ({
      items: withOpenItem(paged.data?.pages.flatMap((p) => p.items) ?? [], (it) => matchesFilter(it, "new"), held),
      loading: paged.isPending, more: paged.hasNextPage && !paged.isFetchingNextPage ? () => void paged.fetchNextPage() : null,
    }),
    [paged.data, paged.isPending, paged.hasNextPage, paged.isFetchingNextPage, held]); // eslint-disable-line react-hooks/exhaustive-deps
}

function FeedLayout() {
  const overlays = useOverlays();
  const c = useRowCtx();
  const { items, loading, more } = useFeedItems();
  const groups = groupByDay(items, itemDate, c.now, c.timeZone);
  if (loading) return <div className="list" aria-busy="true"><div className="skel-rows" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 40, margin: 10 }} />)}</div></div>;
  if (!items.length) return <div className="empty card-like"><h2>{t.nothingToShow}</h2><Button onClick={() => overlays.open({ kind: "add-source" })}>{app.words.addSource}</Button></div>;
  return (
    <>
      <div className="list">
        {groups.map((g) => <section className="day" key={g.key} aria-label={g.label}><h3>{g.label}</h3><ul>{g.items.map((it) => <ItemRow key={it.id} item={it} />)}</ul></section>)}
      </div>
      {more ? <div style={{ textAlign: "center", marginTop: 14 }}><Button onClick={more}>{app.words.showMore}</Button></div> : null}
    </>
  );
}

function NewGroup({ c, items }: { c: CollectionDTO; items: ItemDTO[] }) {
  const ws = useWorkspace();
  const nav = useNav();
  const other = isOtherBox(c);
  const heading = <><span className="t" dir="auto">{c.name}</span>{other ? null : <Icon name="chev" size="sm" className="go" />}<AvatarStack sources={ws.sourcesOf(c)} /></>;
  return (
    <section className="mod" aria-labelledby={`nt-${c.id}`}>
      <header className="mod-h"><h2 className="mod-t" id={`nt-${c.id}`}>{other ? <span className="mod-plain">{heading}</span> : <button type="button" onClick={() => nav.go({ t: "c", id: c.id })}>{heading}</button>}</h2></header>
      <ul className="mod-b">{items.map((it) => <ItemRow key={it.id} item={it} />)}</ul>
    </section>
  );
}

function NewLayout() {
  const save = useSavePreferences();
  const actions = useItemActions();
  const boxes = useBoxes();
  const lists = useBoxLists(boxes, "fresh", GROUP_ITEMS);
  if (boxes.length && lists.some((l) => l.pending)) {
    return <div className="list" aria-busy="true"><div className="skel-rows" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 40, margin: 10 }} />)}</div><p className="sr" role="status">{t.loadingNew}</p></div>;
  }
  const groups = boxes.map((c, i) => ({ c, items: lists[i]?.items ?? [] })).filter((g) => g.items.length);
  if (!groups.length) return <div className="empty card-like"><h2>{app.words.nothingNewRightNow}</h2><p>{t.newMarker}</p><Button onClick={() => void save({ homeLayout: "feed" })}>{t.showRecent}</Button></div>;
  return (
    <>
      <div style={{ display: "grid", gap: 16 }}>{groups.map((g) => <NewGroup key={g.c.id} c={g.c} items={g.items} />)}</div>
      <p className="fine end-of-new">{t.everythingNew}<button type="button" className="link" onClick={() => void actions.clearFresh("all")}>{app.words.markAllAsSeen}</button></p>
    </>
  );
}

function Headline({ c, items, pending }: { c: CollectionDTO; items: ItemDTO[]; pending: boolean }) {
  const nav = useNav();
  const rc = useRowCtx();
  const other = isOtherBox(c);
  return (
    <div className="hl">
      <h3>{other ? <span dir="auto">{c.name}</span> : <button type="button" onClick={() => nav.go({ t: "c", id: c.id })}><bdi>{c.name}</bdi><Icon name="chev" size="sm" /></button>}</h3>
      <ul>
        {items.length ? items.map((it) => (
          <li key={it.id} className="irow" data-item={it.id}>
            <button type="button" className="hli" data-act="open" onClick={() => rc.onOpen(it)}>
              <span className="hlt"><FreshDot fresh={it.fresh} /><span className="title" dir="auto">{it.title}</span></span>
              <span className="m"><bdi>{it.sourceTitle}</bdi>, {timeAgo(itemDate(it), rc.now, rc.timeZone)}{it.workflow !== "new" ? `, ${workflowLabel(it.workflow, it.kind)}` : ""}</span>
            </button>
          </li>
        )) : <li><p className="fine" style={{ padding: "8px 0" }}>{pending ? app.words.loading : t.nothingNewYetShort}</p></li>}
      </ul>
    </div>
  );
}

function FrontLayout() {
  const ws = useWorkspace();
  const nav = useNav();
  const boxes = useBoxes();
  const lists = useBoxLists(boxes, "new", HEADLINE_ITEMS);
  return (
    <>
      <section className="sec" aria-labelledby="fcol"><h2 id="fcol">{app.words.collections}</h2>
        {boxes.length ? <div className="front-cols">{boxes.map((c, i) => <Headline key={c.id} c={c} items={lists[i]!.items} pending={lists[i]!.pending} />)}</div> : <NoHomeCollections inline />}</section>
      {ws.data.baskets.length ? (
        <section className="sec" aria-labelledby="fbk"><h2 id="fbk">{app.words.baskets}</h2>
          <div className="shelf">{ws.data.baskets.map((b) => (
            <button key={b.id} type="button" className="bshelf" onClick={() => nav.go({ t: "b", id: b.id })}>
              <b><span dir="auto">{b.name}</span><span>{b.itemCount}</span></b><span>{b.captureMode === "text" ? t.savesText : t.savesLink}</span>
            </button>
          ))}</div></section>
      ) : null}
    </>
  );
}

const OPML_LIMIT = 2 * 1024 * 1024;

/** Import the subscription list (OPML) another reader exports, straight from the first-run card. */
function ImportListButton() {
  const overlays = useOverlays();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  async function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > OPML_LIMIT) { setError(app.words.thatFileIsTooLargeTo); return; }
    setError("");
    overlays.open({ kind: "opml-file", name: file.name, text: await file.text() });
  }
  return (
    <>
      <input ref={input} type="file" accept=".opml,.xml,text/xml,text/x-opml,application/xml" hidden onChange={(e) => void chosen(e)} aria-label="Choose an OPML file" />
      <Button large onClick={() => input.current?.click()}><Icon name="download" size="sm" />{t.importFromReader}</Button>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </>
  );
}

export function HomePage() {
  const ws = useWorkspace();
  const overlays = useOverlays();
  const layout = ws.prefs.homeLayout;
  const homeFilter = layout === "new" ? "fresh" : "new";
  const keeps = useCallback((i: ItemDTO) => matchesFilter(i, homeFilter), [homeFilter]);
  const value = useRowContextValue(null, keeps);
  const narrow = layout === "feed" || layout === "new" ? " narrow" : "";
  const empty = !ws.data.sources.length && !ws.collections.length && !ws.data.baskets.length;
  return (
    <RowContext.Provider value={value}>
      <div className="homewash">{QUILT}<div className={`col${narrow}`}><div className="home-top"><h1>{app.words.home}</h1><button type="button" className="mbtn quietb" aria-haspopup="dialog" onClick={() => overlays.open({ kind: "customise-home" })}><Icon name="gear" />{t.customise}</button></div><HomeBand /></div></div>
      <div className={`col${narrow} home-body`}>
        <EngineNotice />
        <ReviewNotice />
        <ReminderCard />
        <ComingUp />
        {empty ? (
          <div className="empty card-like">
            <h2>{t.startTitle}</h2>
            <p>{t.startText}</p>
            <div className="empty-acts">
              <Button variant="primary" large onClick={() => overlays.open({ kind: "add-source" })}><Icon name="plus" size="sm" />{app.words.addSource}</Button>
              <ImportListButton />
            </div>
          </div>
        ) : (
          <>
            <WelcomeRows />
            <MutedLine />
            {layout === "collections" ? <CollectionsLayout /> : layout === "feed" ? <FeedLayout /> : layout === "new" ? <NewLayout /> : <FrontLayout />}
          </>
        )}
      </div>
    </RowContext.Provider>
  );
}

