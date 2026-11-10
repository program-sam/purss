import type { Capacity, CollectionDTO, SourceDTO } from "@purss/domain";
import { Avatar, Icon } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { formatCount, plural } from "../lib/format.ts";
import { setHints, useHints } from "../state/ui-store.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { useSession } from "../api/hooks.ts";
import { useNav } from "../nav.ts";
import type { Place } from "../nav.ts";
import { workspacePages } from "../plugins.ts";
import { hasKeyboard } from "../lib/returning.ts";
import { FirstVisitQuestion } from "../dialogs/FirstVisitQuestion.tsx";
import { InterfaceUpdateQuestion } from "./InterfaceUpdates.tsx";
import { ActivityIndicator } from "./ActivityIndicator.tsx";
import { VisitTracker } from "./VisitTracker.tsx";
import { CapacityMeter, CapacityPanel, capacityLine } from "./Capacity.tsx";
import { useCurrentPlace, usePathname } from "./place.ts";

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export const SEARCH_KEY = isMac ? "⌘K" : "Ctrl K";
const SEARCH_SPOKEN = isMac ? "Command K" : "Control K";
/** A phone or tablet has no keyboard to hint at. */
const KEYBOARD = typeof window === "undefined" || hasKeyboard((q) => window.matchMedia(q).matches);

/** Health marker with a text alternative; never colour alone. Nothing for a healthy source. */
export function HealthMark({ source }: { source: SourceDTO }) {
  const map: Partial<Record<SourceDTO["health"], { icon: IconName; label: string; cls?: string }>> = {
    login: { icon: "key", label: "Needs login", cls: "login" },
    quiet: { icon: "moon", label: source.healthText ?? "Quiet for a while" },
    paused: { icon: "pause", label: "Paused" },
    error: { icon: "alert", label: source.healthText ?? "Couldn't be collected", cls: "login" },
    reconnect: { icon: "link", label: source.healthText ?? "Needs reconnecting", cls: "login" },
    pending: { icon: "clock", label: "Collecting the first items…" },
  };
  const m = map[source.health];
  if (!m) return null;
  return <span className={`hm ${m.cls ?? ""}`} role="img" aria-label={m.label} title={m.label}><Icon name={m.icon} /></span>;
}

/** A Smart filter that is on: on a source for its own filter, on a collection for the one that covers all its sources. */
function FilterMark() {
  return <span className="hm" role="img" aria-label="Smart filter on" title="Smart filter on"><Icon name="filter" /></span>;
}

function SourceRow({ s, place }: { s: SourceDTO; place: Place | null }) {
  const nav = useNav();
  const here = place?.t === "s" && place.id === s.id;
  return (
    <li>
      <button type="button" data-source={s.id} className={`srow${here ? " sel" : ""}`} aria-current={here ? "page" : undefined} onClick={() => nav.go({ t: "s", id: s.id })}>
        <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={20} />
        <span className="nm" dir="auto">{s.title}</span>
        {s.curator ? <span className="shared">shared by {s.curator}</span> : null}
        <span className="sp" />
        {s.aiFiltered ? <FilterMark /> : null}
        <HealthMark source={s} />
        {s.freshCount ? <span className="cnt" title={`${formatCount(s.freshCount)} new`}>{formatCount(s.freshCount)}<span className="u"> new</span></span> : null}
      </button>
    </li>
  );
}

function Group({ id, label, sources, collection, place }: { id: string; label: string; sources: SourceDTO[]; collection?: CollectionDTO; place: Place | null }) {
  const nav = useNav();
  const hints = useHints();
  const open = !hints.collapsed.includes(id);
  const here = !!collection && place?.t === "c" && place.id === collection.id;
  const fresh = collection ? collection.freshCount : sources.reduce((n, s) => n + s.freshCount, 0);
  const expandable = !collection || collection.mode === "sources";
  const toggle = () => setHints({ collapsed: open ? [...hints.collapsed, id] : hints.collapsed.filter((x) => x !== id) });
  // Long groups show their first few sources, plus the one you're on, until "Show all".
  const all = hints.showAll.includes(id);
  const toggleAll = () => setHints({ showAll: all ? hints.showAll.filter((x) => x !== id) : [...hints.showAll, id] });
  const shown = all ? sources : sources.filter((s, i) => i < GROUP_PREVIEW || (place?.t === "s" && place.id === s.id));
  return (
    <li className="group">
      <div className={`grow${here ? " sel" : ""}`}>
        {expandable ? (
          <button type="button" className="chev" aria-expanded={open} aria-label={`${label}, ${plural(sources.length, "source")}`} onClick={toggle}><Icon name="chev" /></button>
        ) : <span style={{ width: 26, flex: "none" }} />}
        {collection ? (
          <button type="button" data-collection={collection.id} className="glabel" aria-current={here ? "page" : undefined} onClick={() => nav.go({ t: "c", id: collection.id })}>
            {collection.emoji ? <span aria-hidden="true" style={{ marginRight: 6 }}>{collection.emoji}</span> : null}<bdi>{collection.name}</bdi>
          </button>
        ) : <span className="glabel" style={{ fontWeight: 700, color: "var(--ink-2)" }}>{label}</span>}
        {collection?.aiFiltered ? <FilterMark /> : null}
        {!open && fresh ? <span className="cnt" title={`${fresh} new`}>{fresh}<span className="u"> new</span></span> : null}
      </div>
      {open && expandable ? (
        <ul className="srcs">
          {sources.length ? shown.map((s) => <SourceRow key={s.id} s={s} place={place} />) : <li><p className="fine" style={{ padding: "4px 8px 6px" }}>No sources yet</p></li>}
          {sources.length > GROUP_PREVIEW ? (
            <li><button type="button" className="more-srcs" aria-expanded={all} onClick={toggleAll}>{all ? "Show fewer" : `Show all ${sources.length}`}</button></li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** Sources shown per sidebar group before "Show all". */
const GROUP_PREVIEW = 6;

/** onToggle: a docked sidebar carries its own collapse or expand button, as the page has no bar above it. */
export function Sidebar({ mode, onToggle }: { mode: "full" | "rail"; onToggle?: () => void }) {
  const ws = useWorkspace();
  const nav = useNav();
  const place = useCurrentPlace();
  const pathname = usePathname();
  const overlays = useOverlays();
  const popups = usePopups();
  const session = useSession().data;
  // A copy saved offline by an earlier version has no capacity; the meter waits for the next refresh.
  const capacity = (ws.data as { capacity?: Capacity }).capacity ?? null;
  const paused = ws.data.paused ?? null;
  const hosted = session?.installation.mode === "hosted";
  const pages = workspacePages.filter((p) => p.nav && (!p.adminOnly || session?.account?.isAdmin) && (!p.hostedOnly || hosted));
  // A single administrator page sits under More rather than under a heading with the same name.
  const adminOnly = pages.filter((p) => p.adminOnly);
  const morePages = pages.filter((p) => !p.adminOnly || adminOnly.length === 1);
  const adminPages = adminOnly.length > 1 ? adminOnly : [];
  const addTo = place?.t === "c" ? place.id : place?.t === "s" ? ws.sourceById.get(place.id)?.collectionIds[0] : undefined;
  const openAdd = () => overlays.open({ kind: "add-source", collectionId: addTo });
  const openCapacity = (anchor: HTMLElement, up: boolean) => { if (capacity) popups.panel(anchor, "Your plan", () => <CapacityPanel capacity={capacity} paused={paused} onPlan={hosted ? () => overlays.open({ kind: "settings", tab: "plan" }) : undefined} />, { up }); };
  const capacityLabel = capacity ? `${capacityLine(capacity)}${paused ? ". New items are paused" : ""}. Show your plan` : "";
  const homeHere = place?.t === "home";
  const readHere = place?.t === "r";

  if (mode === "rail") {
    return (
      <div className="rail">
        <FirstVisitQuestion /><InterfaceUpdateQuestion /><VisitTracker />
        <span className="mark" aria-hidden="true"><Icon name="mark" /></span>
        {onToggle ? <button type="button" className="rbtn" data-fk="tside" data-tip="Expand sidebar" aria-label="Expand sidebar" aria-expanded={false} onClick={onToggle}><Icon name="sidebar" /></button> : null}
        <button type="button" className="rail-add" data-tip="Add source" aria-label="Add source" data-fk="add" onClick={openAdd}><Icon name="plus" /></button>
        <button type="button" className={`rbtn${homeHere ? " sel" : ""}`} data-tip="Home" aria-label="Home" aria-current={homeHere ? "page" : undefined} onClick={() => nav.go({ t: "home" })}><Icon name="home" /></button>
        <button type="button" className={`rbtn${readHere ? " sel" : ""}`} data-tip="To read" aria-label="To read" aria-current={readHere ? "page" : undefined} onClick={() => nav.go({ t: "r", id: "toread" })}><Icon name="item" /></button>
        <button type="button" className="rbtn" data-tip={`Search (${SEARCH_SPOKEN})`} aria-label={`Search, shortcut ${SEARCH_SPOKEN}`} onClick={() => overlays.open({ kind: "palette" })}><Icon name="search" /></button>
        <hr />
        <div className="rail-scroll">
          {ws.collections.map((c) => {
            const sel = (place?.t === "c" && place.id === c.id) || (place?.t === "s" && ws.sourceById.get(place.id)?.collectionIds.includes(c.id));
            return (
              <button key={c.id} type="button" className={`rbtn${sel ? " sel" : ""}`} data-tip={c.name} aria-current={place?.t === "c" && place.id === c.id ? "page" : undefined}
                aria-label={`${c.name}, ${plural(c.sourceIds.length, "source")}${c.freshCount ? `, ${c.freshCount} new` : ""}`} data-collection={c.id} onClick={() => nav.go({ t: "c", id: c.id })}>
                {/* The collection's own emoji, else its first source's icon, so collections are told apart in the rail. */}
                {/* The tile, then the collection's name under it, so a collection never reads as one of its sources. */}
                {c.emoji || !ws.sourcesOf(c)[0] ? <span className="rtile" aria-hidden="true">{c.emoji || c.name[0]?.toUpperCase()}</span>
                  : <span className="rtile src" aria-hidden="true"><Avatar hue={ws.sourcesOf(c)[0]!.hue} initials={ws.sourcesOf(c)[0]!.initials} src={ws.sourcesOf(c)[0]!.iconUrl} size={24} /></span>}
                <span className="rname" aria-hidden="true" dir="auto">{c.name}</span>{c.freshCount ? <i className="dot" /> : null}
              </button>
            );
          })}
          <button type="button" className="rbtn" data-tip="New collection" aria-label="New collection" onClick={() => overlays.open({ kind: "new-collection" })}><Icon name="folder" /></button>
          <hr />
          {ws.data.baskets.map((b) => {
            const sel = place?.t === "b" && place.id === b.id;
            return (
              <button key={b.id} type="button" data-basket={b.id} className={`rbtn${sel ? " sel" : ""}`} data-tip={b.name} aria-current={sel ? "page" : undefined} aria-label={`${b.name}, ${plural(b.itemCount, "item")}`} onClick={() => nav.go({ t: "b", id: b.id })}>
                <Icon name="basket" /><span className="bn" aria-hidden="true">{b.itemCount}</span>
              </button>
            );
          })}
          {pages.map((p) => <button key={p.path} type="button" className={`rbtn${pathname === p.path ? " sel" : ""}`} data-tip={p.nav!.label} aria-label={p.nav!.label} onClick={() => nav.goPath(p.path)}><Icon name={p.nav!.icon} /></button>)}
        </div>
        <ActivityIndicator rail />
        {capacity ? <button type="button" className="rbtn" data-tip={capacityLine(capacity)} aria-haspopup="dialog" aria-label={capacityLabel} onClick={(e) => openCapacity(e.currentTarget, false)}><CapacityMeter capacity={capacity} /></button> : null}
        <button type="button" className="rbtn" data-tip="Settings" aria-label="Settings" onClick={() => overlays.open({ kind: "settings" })}><Icon name="gear" /></button>
      </div>
    );
  }

  return (
    <>
      <FirstVisitQuestion /><InterfaceUpdateQuestion /><VisitTracker />
      <div className="side-head">
        <div className="brand"><span className="mark" aria-hidden="true"><Icon name="mark" /></span>PURSS
          {onToggle ? <button type="button" className="ibtn side-collapse" data-fk="tside" aria-label="Collapse sidebar" aria-expanded={true} onClick={onToggle}><Icon name="sidebar" /></button> : null}</div>
        {session?.account?.displayName ? <p className="fine" style={{ margin: "-6px 4px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.account.displayName}</p> : null}
        <button type="button" className="btn primary lg" data-fk="add" onClick={openAdd}><Icon name="plus" />Add source</button>
        <div style={{ display: "grid", gap: 6 }}>
          <button type="button" className={`nav-row${homeHere ? " sel" : ""}`} aria-current={homeHere ? "page" : undefined} onClick={() => nav.go({ t: "home" })}><Icon name="home" />Home</button>
          <button type="button" className={`nav-row${readHere ? " sel" : ""}`} aria-current={readHere ? "page" : undefined} onClick={() => nav.go({ t: "r", id: "toread" })}><Icon name="item" />To read</button>
          <button type="button" className="pill-search" aria-label={KEYBOARD ? `Search, shortcut ${SEARCH_SPOKEN}` : "Search"} onClick={() => overlays.open({ kind: "palette" })}><Icon name="search" />Search{KEYBOARD ? <kbd aria-hidden="true">{SEARCH_KEY}</kbd> : null}</button>
        </div>
      </div>
      <nav className="side-scroll" aria-label="Collections and baskets">
        <div className="sec-head"><h2 id="h-col">Collections</h2><button type="button" className="quiet" onClick={() => overlays.open({ kind: "new-collection" })}><Icon name="plus" size="sm" />New collection</button></div>
        <ul aria-labelledby="h-col">
          {ws.collections.map((c) => <Group key={c.id} id={c.id} label={c.name} collection={c} sources={ws.sourcesOf(c)} place={place} />)}
          {ws.looseSources.length ? <Group id="loose" label="Sources not in a collection" sources={ws.looseSources} place={place} /> : null}
        </ul>
        {!ws.collections.length && !ws.looseSources.length ? <p className="fine" style={{ padding: "6px 10px" }}>Nothing followed yet.</p> : null}
        <div className="sec-head"><h2 id="h-bk">Baskets</h2><button type="button" className="quiet" onClick={() => overlays.open({ kind: "basket-form" })}><Icon name="plus" size="sm" />New basket</button></div>
        <ul aria-labelledby="h-bk">
          {ws.data.baskets.map((b) => {
            const sel = place?.t === "b" && place.id === b.id;
            return (
              <li key={b.id}>
                <button type="button" data-basket={b.id} className={`bk${sel ? " sel" : ""}`} aria-current={sel ? "page" : undefined} onClick={() => nav.go({ t: "b", id: b.id })}>
                  <Icon name="basket" /><span className="nm" dir="auto">{b.name}</span><span className="n">{plural(b.itemCount, "item")}</span>
                </button>
              </li>
            );
          })}
          {!ws.data.baskets.length ? <li><p className="fine" style={{ padding: "4px 10px 6px" }}>Baskets keep items you choose, even after their source drops them. Use the bookmark on any item to keep it.</p></li> : null}
        </ul>
        {morePages.length ? (
          <>
            <div className="sec-head"><h2 id="h-more">More</h2></div>
            <ul aria-labelledby="h-more">
              {morePages.map((p) => <li key={p.path}><button type="button" className={`bk${pathname === p.path ? " sel" : ""}`} aria-current={pathname === p.path ? "page" : undefined} onClick={() => nav.goPath(p.path)}><Icon name={p.nav!.icon} /><span className="nm">{p.nav!.label}</span></button></li>)}
            </ul>
          </>
        ) : null}
        {adminPages.length ? (
          <>
            <div className="sec-head"><h2 id="h-admin">Administration</h2></div>
            <ul aria-labelledby="h-admin">
              {adminPages.map((p) => <li key={p.path}><button type="button" className={`bk${pathname === p.path ? " sel" : ""}`} aria-current={pathname === p.path ? "page" : undefined} onClick={() => nav.goPath(p.path)}><Icon name={p.nav!.icon} /><span className="nm">{p.nav!.label}</span></button></li>)}
            </ul>
          </>
        ) : null}
      </nav>
      <div className="side-act"><ActivityIndicator /></div>
      <div className="side-foot">
        {capacity ? <button type="button" className="stor" aria-haspopup="dialog" aria-label={capacityLabel} onClick={(e) => openCapacity(e.currentTarget, true)}><CapacityMeter capacity={capacity} /><span>{capacityLine(capacity)}</span>{paused ? <Icon name="alert" /> : null}</button> : <span className="stor" />}
        <button type="button" className="set" onClick={() => overlays.open({ kind: "settings" })}><Icon name="gear" />Settings</button>
      </div>
    </>
  );
}
