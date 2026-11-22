import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CatalogCategory, CatalogCategoryList, CatalogSource, DiscoverSuggestion, DiscoveryResult } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Avatar, Button, Check, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { byChance, shuffled } from "../../lib/discovery.ts";
import { plural, shortDate } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useColumns } from "../../pages/Home.tsx";
import { useOverlays } from "../../state/overlays.tsx";
import { setHints, useHints } from "../../state/ui-store.ts";
import { useSavePreferences } from "../../state/prefs.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { catalogQuery, fkeys, suggestionsQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Note, Page, Section } from "../shared/bits.tsx";

const copy = app.discover.discoverPage;

const KIND_LABEL: Record<DiscoverSuggestion["kind"], string> = copy.kind;
/** Sources a category box shows; the rest are on the category's own page. */
const BOX_ROWS = 6;

export const catalogPath = (id: CatalogCategory) => `/discover/${id}`;

function names(titles: string[]): string {
  return titles.length <= 1 ? titles.join("") : copy.and(titles.slice(0, -1).join(", "), titles[titles.length - 1]);
}

function Reason({ s }: { s: DiscoverSuggestion }) {
  const ws = useWorkspace();
  if (s.reason.kind === "because") {
    const titles = s.reason.sourceIds.map((id) => ws.sourceById.get(id)?.title).filter((t): t is string => !!t);
    return <span className="fine">{titles.length ? <>{copy.followedBy}<span dir="auto">{names(titles)}</span></> : copy.followedByLikeYou}</span>;
  }
  return <span className="fine">{s.reason.kind === "wildcard" ? copy.wildcard : copy.popular}</span>;
}

/** Following goes through Add source, which looks the address up again like any pasted link. */
function FollowButton({ feedUrl }: { feedUrl: string }) {
  const overlays = useOverlays();
  return <Button variant="primary" onClick={() => overlays.open({ kind: "add-source", url: feedUrl, entry: "suggestion" })}><Icon name="plus" size="sm" />{copy.follow}</Button>;
}

function Row({ s, onDismiss }: { s: DiscoverSuggestion; onDismiss: (s: DiscoverSuggestion) => void }) {
  return (
    <div className="fx-row wrap">
      <div className="fx-grow">
        <b dir="auto">{s.title}</b>
        <span className="fine">{KIND_LABEL[s.kind]}{s.host ? ` · ${s.host}` : ""}</span>
        <Reason s={s} />
      </div>
      <div className="fx-end">
        <FollowButton feedUrl={s.feedUrl} />
        <Button onClick={() => onDismiss(s)}>{copy.notInterested}</Button>
      </div>
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: DiscoverSuggestion[] }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  async function dismiss(s: DiscoverSuggestion) {
    setHidden((h) => new Set(h).add(s.key));
    try {
      await post("/api/suggestions/dismiss", { key: s.key });
      void qc.invalidateQueries({ queryKey: fkeys.suggestions });
      toast(copy.wontBeSuggested(s.title));
    } catch (err) {
      setHidden((h) => { const n = new Set(h); n.delete(s.key); return n; });
      toast(messageOf(err), { tone: "error" });
    }
  }
  const list = suggestions.filter((s) => !hidden.has(s.key));
  if (!list.length) return <div className="mod-empty"><span>{app.words.nothingNewRightNow}. {copy.checkBack}</span></div>;
  return <div className="mod-b">{list.map((s) => <Row key={s.key} s={s} onDismiss={(x) => void dismiss(x)} />)}</div>;
}

/** The first box: sources that readers who follow what you follow also follow, "coming soon" until the co-follow graph holds any. */
function ForYou() {
  const q = useQuery(suggestionsQuery);
  const [shut, toggle] = useShut("for-you");
  return (
    <section className={`mod${shut ? " shut" : ""}`} aria-labelledby="disc-for-you">
      <header className="mod-h">
        <Fold shut={shut} name={copy.forYou} onToggle={toggle} />
        <h2 className="mod-t" id="disc-for-you"><span className="mod-plain"><span className="t">{copy.forYou}</span></span></h2>
      </header>
      {shut ? null : q.isPending ? <div className="mod-empty"><Loading /></div> : q.isError ? <LoadFailed error={q.error} what={copy.suggestionsName} onRetry={() => void q.refetch()} /> : !q.data.ready ? (
        <div className="mod-empty"><span><b>{copy.comingSoon}.</b> {copy.comingSoonText}</span></div>
      ) : !q.data.sharing ? (
        <div className="mod-empty"><span><b>{copy.shareToGet}.</b> {copy.shareToGetText}</span></div>
      ) : <Suggestions suggestions={q.data.suggestions} />}
    </section>
  );
}

/** A catalog source's newest posts, from the same lookup Add source makes. */
function Preview({ s }: { s: CatalogSource }) {
  const q = useQuery({
    queryKey: ["feature", "catalog-preview", s.feedUrl],
    queryFn: () => post<DiscoveryResult>("/api/discover", { url: s.feedUrl, entry: "suggestion" }),
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <Note>{messageOf(q.error)}</Note>;
  if (!q.data.ok) return <Note>{q.data.message}</Note>;
  const samples = q.data.candidates[0]?.samples ?? [];
  if (!samples.length) return <p className="fine">{copy.noPostsYet}</p>;
  return (
    <ul className="disc-posts" aria-label={copy.previewOf(s.title)}>
      {samples.map((p, i) => <li key={i}><bdi>{p.title}</bdi>{p.publishedAt ? <span className="fine"> · {shortDate(p.publishedAt)}</span> : null}</li>)}
    </ul>
  );
}

/** A catalog source: the arrow opens its latest posts under it, like a collection's arrow opens its sources. */
function CatalogRow({ s }: { s: CatalogSource }) {
  const [open, setOpen] = useState(false);
  const id = `disc-pv-${s.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <li className="fx-row wrap disc-row">
      <button type="button" className="chev" aria-expanded={open} aria-controls={id} aria-label={copy.previewOf(s.title)} onClick={() => setOpen((o) => !o)}><Icon name="chev" /></button>
      <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={56} />
      <div className="fx-grow">
        <b dir="auto">{s.title}</b>
        <span className="fine">{KIND_LABEL[s.kind]}{s.host ? ` · ${s.host}` : ""}</span>
        {s.description ? <span className="fine disc-desc" dir="auto" title={s.description}>{s.description}</span> : null}
      </div>
      <div className="fx-end"><FollowButton feedUrl={s.feedUrl} /></div>
      {open ? <div className="disc-preview" id={id}><Preview s={s} /></div> : null}
    </li>
  );
}

/** Whether a Discovery box is folded shut. Boxes start folded; the ones opened are remembered in this browser. */
function useShut(id: string): [boolean, () => void] {
  const hints = useHints();
  const key = `disc:${id}`;
  const shut = !hints.opened.includes(key);
  return [shut, () => setHints({ opened: shut ? [...hints.opened, key] : hints.opened.filter((x) => x !== key) })];
}

/** A Discovery box's folding arrow, before its title like a collection's in the sidebar. */
function Fold({ shut, name, onToggle }: { shut: boolean; name: string; onToggle: () => void }) {
  return <button type="button" className="chev" aria-expanded={!shut} aria-label={name} onClick={onToggle}><Icon name="chev" /></button>;
}

/** What the reader has since following one, left out at once (the server leaves them out on the next load). */
function useNotFollowed(): (s: CatalogSource) => boolean {
  const ws = useWorkspace();
  const followed = useMemo(() => new Set(ws.data.sources.flatMap((s) => (s.feedUrl ? [s.feedUrl] : []))), [ws.data.sources]);
  return (s) => !followed.has(s.feedUrl);
}

function CategoryBox({ list }: { list: CatalogCategoryList }) {
  const nav = useNav();
  const open = useNotFollowed();
  // Chance is drawn once per visit to the page: the list keeps its order while the page is open.
  const ordered = useMemo(() => byChance(list.sources), [list.sources]);
  const rows = ordered.filter(open).slice(0, BOX_ROWS);
  const name = copy.categories[list.id];
  const go = () => nav.goPath(catalogPath(list.id));
  const [shut, toggle] = useShut(list.id);
  return (
    <section className={`mod${shut ? " shut" : ""}`} aria-labelledby={`disc-${list.id}`}>
      <header className="mod-h">
        <Fold shut={shut} name={name} onToggle={toggle} />
        <h2 className="mod-t" id={`disc-${list.id}`}><button type="button" onClick={go}><span className="t">{name}</span><Icon name="chev" size="sm" className="go" /></button></h2>
      </header>
      {shut ? null : (
        <>
          {rows.length ? <ul className="mod-b">{rows.map((s) => <CatalogRow key={s.key} s={s} />)}</ul> : <div className="mod-empty"><span>{copy.nothingLeft}</span></div>}
          {list.total > rows.length ? <button type="button" className="mod-all" onClick={go}>{copy.seeAll(list.total)}<span> · {name}</span><Icon name="chev" size="sm" /></button> : null}
        </>
      )}
    </section>
  );
}

/** The category boxes, in a new random order on each visit, laid out in columns like Home's boxes. */
function Categories() {
  const q = useQuery(catalogQuery());
  const fits = useColumns();
  const boxes = useMemo(() => shuffled(q.data?.categories ?? []), [q.data]);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadFailed error={q.error} what={copy.catalogName} onRetry={() => void q.refetch()} />;
  if (!boxes.length) return null;
  const n = Math.max(1, Math.min(fits, boxes.length));
  const buckets: CatalogCategoryList[][] = Array.from({ length: n }, () => []);
  boxes.forEach((b, i) => buckets[i % n]!.push(b));
  return <div className="mods">{buckets.map((b, col) => <div className="mcol" key={col}>{b.map((list) => <CategoryBox key={list.id} list={list} />)}</div>)}</div>;
}

function SharingChoice() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const qc = useQueryClient();
  return (
    <Check checked={ws.prefs.discoveryShare} onChange={(v) => { void save({ discoveryShare: v }).then(() => qc.invalidateQueries({ queryKey: fkeys.suggestions })); }}
      hint={app.words.purssCountsSourcesFollowedByPeople}>
      {app.words.shareMySources}
    </Check>
  );
}

/**
 * Discovery: on a hosted installation first the sources that readers who follow what you follow also follow; then, wherever the
 * installation has a catalog, its popular sources in one box per category.
 */
export function DiscoverPage() {
  const session = useSession().data;
  if (!session) return <Page title={app.words.discovery}><Loading /></Page>;
  const hosted = session.installation.mode === "hosted";
  if (!hosted && !session.installation.catalog) return <Page title={app.words.discovery}><Note>{copy.hostedOnly}</Note></Page>;
  return (
    <Page title={app.words.discovery} lead={hosted ? copy.lead : copy.catalogLead} wide>
      {hosted ? <ForYou /> : null}
      {session.installation.catalog ? <Categories /> : null}
      {hosted ? <Section title={app.words.sharing}><SharingChoice /></Section> : null}
    </Page>
  );
}

/** One category's popular sources, all of them, most popular first with some chance. */
export function CatalogCategoryPage({ id }: { id: CatalogCategory }) {
  const session = useSession().data;
  const available = !!session?.installation.catalog;
  const q = useQuery({ ...catalogQuery(id), enabled: available });
  const open = useNotFollowed();
  const ordered = useMemo(() => byChance(q.data?.categories[0]?.sources ?? []), [q.data]);
  const name = copy.categories[id];
  if (session && !available) return <Page title={name}><Note>{copy.noCatalog}</Note></Page>;
  const rows = ordered.filter(open);
  return (
    <Page title={name} lead={copy.categoryLead}>
      {q.isPending ? <Loading /> : q.isError ? <LoadFailed error={q.error} what={copy.catalogName} onRetry={() => void q.refetch()} /> : (
        <Section title={plural(rows.length, app.words.sourceLower)}>
          {rows.length ? <ul className="fx-rows">{rows.map((s) => <CatalogRow key={s.key} s={s} />)}</ul> : <p className="fine">{copy.nothingLeft}</p>}
        </Section>
      )}
    </Page>
  );
}
