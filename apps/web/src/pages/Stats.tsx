import "./stats.css";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CollectionStatsResponse, CollectionStatsRow, SourceStatsResponse, StatsNumbers, WorkflowState } from "@purss/domain";
import { Avatar, Button, Icon } from "@purss/ui";
import { messageOf } from "../api/client.ts";
import { collectionStatsQuery, sourceStatsQuery } from "../api/queries.ts";
import { Sparkline } from "../components/Sparkline.tsx";
import { LoadingBlocks } from "../components/Loading.tsx";
import { WORKFLOW_LABELS, WORKFLOW_ORDER } from "../lib/constants.ts";
import { plural, shortDate } from "../lib/format.ts";
import { countWithShare, firstDirection, gapLabel, sortRows, weeklyAverage } from "../lib/stats.ts";
import type { StatsSortKey } from "../lib/stats.ts";
import { pathFor, statsPathFor, useNav } from "../nav.ts";
import type { StatsPlace } from "../nav.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { Trail } from "../shell/crumbs.tsx";

/*
 * Private statistics for one source or one collection: the numbers and nothing else. No
 * sentence here interprets them, and rows are only ever ordered by the column the person picks
 * (by name until they do).
 */

function Gone({ place }: { place: StatsPlace }) {
  const nav = useNav();
  return (
    <div className="col narrow">
      <div className="empty card-like" style={{ marginTop: 40 }}>
        <h2>That {place.t === "c" ? "collection" : "source"} isn't here</h2>
        <p>It may have been removed.</p>
        <Button onClick={() => nav.go({ t: "home" })}>Go to Home</Button>
      </div>
    </div>
  );
}

function StatsHead({ place, title, asOf }: { place: StatsPlace; title: string; asOf: string | null }) {
  const ws = useWorkspace();
  const nav = useNav();
  return (
    <div className="phead">
      <h1>{title}</h1>
      <div className="psub">
        <span className="tag">Statistics</span>
        {asOf ? <span>As of <time dateTime={asOf}>{shortDate(asOf, Date.now(), ws.prefs.timezone)}</time></span> : null}
        <button type="button" className="link" onClick={() => nav.goPath(pathFor(place))}><Icon name="back" size="sm" /> Back to items</button>
      </div>
      <p className="fine">Only you can see these numbers.</p>
    </div>
  );
}

function Loading() {
  return <LoadingBlocks className="list">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 40, margin: 10 }} />)}</LoadingBlocks>;
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <div className="empty card-like"><h2>Couldn't load the statistics</h2><p>{messageOf(error)}</p><Button onClick={onRetry}>Try again</Button></div>;
}

function Item({ label, sub, children }: { label: string; sub?: boolean; children: ReactNode }) {
  return <div className={sub ? "stat-item stat-sub" : "stat-item"}><dt>{label}</dt><dd>{children}</dd></div>;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="stat-block"><h3>{title}</h3><dl className="stat-dl">{children}</dl></section>;
}

function SourceBody({ data }: { data: SourceStatsResponse }) {
  const ws = useWorkspace();
  const s = data.stats;
  const when = (iso: string | null) => (iso ? <time dateTime={iso}>{shortDate(iso, Date.now(), ws.prefs.timezone)}</time> : "–");
  return (
    <div className="fx-stack">
      <section className="fx-sec">
        <div className="fx-sec-h"><h2>Items per week</h2><span className="fine">Last {s.weekly.length} weeks</span></div>
        <div className="fx-sec-b stat-spark">
          <Sparkline weekly={s.weekly} width={520} height={72} />
          <p className="fine">Average {weeklyAverage(s.weekly)} per week. Most in one week: {Math.max(...s.weekly)}. Dated by the feed's publish date, or by arrival day if it gave none.</p>
        </div>
      </section>
      <section className="fx-sec">
        <div className="fx-sec-h"><h2>Numbers</h2></div>
        <div className="fx-sec-b stat-blocks">
          <Block title="Items">
            <Item label="Total">{s.totalItems}</Item>
            <Item label="Latest item">{when(s.lastItemAt)}</Item>
            <Item label="Longest gap between items, last 12 months">{gapLabel(s.longestGapDays)}</Item>
          </Block>
          <Block title="Workflow">
            {WORKFLOW_ORDER.map((w) => <Item key={w} label={WORKFLOW_LABELS[w]}>{countWithShare(s.workflow[w], s.totalItems)}</Item>)}
            {s.filteredOut > 0 ? <Item label={`Of ${WORKFLOW_LABELS.ignored}: filtered out by a Smart filter`} sub>{countWithShare(s.filteredOut, s.totalItems)}</Item> : null}
          </Block>
          <Block title="Reading and keeping">
            <Item label="Opened at least once">{countWithShare(s.opened, s.totalItems)}</Item>
            <Item label="In at least one basket">{countWithShare(s.kept, s.totalItems)}</Item>
          </Block>
          <Block title="Last 30 days">
            <Item label={`Moved to ${WORKFLOW_LABELS.finished}`}>{s.finishedLast30Days}</Item>
            <Item label={`Moved to ${WORKFLOW_LABELS.ignored}`}>{s.ignoredLast30Days}</Item>
          </Block>
        </div>
      </section>
    </div>
  );
}

type Column = { key: StatsSortKey; label: string; numeric: boolean };
const BASE_COLUMNS: readonly Column[] = [
  { key: "name", label: "Source", numeric: false },
  { key: "items", label: "Items", numeric: true },
  { key: "weekly", label: "Items per week", numeric: false },
  { key: "last", label: "Latest item", numeric: false },
  ...WORKFLOW_ORDER.map((w): Column => ({ key: w, label: WORKFLOW_LABELS[w], numeric: true })),
  { key: "opened", label: "Opened", numeric: true },
  { key: "kept", label: "In baskets", numeric: true },
];
const FILTERED_COLUMN: Column = { key: "filtered", label: "Filtered out by Smart filter", numeric: true };

function Cells({ stats, filtered }: { stats: StatsNumbers; filtered: boolean }) {
  const ws = useWorkspace();
  const total = stats.totalItems;
  return (
    <>
      <td className="num">{total}</td>
      <td><span className="stat-week"><Sparkline weekly={stats.weekly} width={96} height={24} /><span className="num">{weeklyAverage(stats.weekly)}</span></span></td>
      <td>{stats.lastItemAt ? <time dateTime={stats.lastItemAt}>{shortDate(stats.lastItemAt, Date.now(), ws.prefs.timezone)}</time> : "–"}</td>
      {WORKFLOW_ORDER.map((w: WorkflowState) => <td key={w} className="num">{countWithShare(stats.workflow[w], total)}</td>)}
      <td className="num">{countWithShare(stats.opened, total)}</td>
      <td className="num">{countWithShare(stats.kept, total)}</td>
      {filtered ? <td className="num">{countWithShare(stats.filteredOut, total)}</td> : null}
    </>
  );
}

function SourceCell({ row }: { row: CollectionStatsRow }) {
  const ws = useWorkspace();
  const nav = useNav();
  const src = row.sourceId ? ws.sourceById.get(row.sourceId) : undefined;
  return (
    <th scope="row" className="stat-name">
      <span className="c-src">
        {src ? <Avatar hue={src.hue} initials={src.initials} src={src.iconUrl} /> : null}
        {row.sourceId ? <button type="button" className="link" onClick={() => nav.goPath(statsPathFor({ t: "s", id: row.sourceId! }))}>{row.title}</button> : <span>{row.title}</span>}
      </span>
    </th>
  );
}

function CollectionBody({ data }: { data: CollectionStatsResponse }) {
  const [sort, setSort] = useState<{ key: StatsSortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const rows = useMemo(() => sortRows(data.sources, sort.key, sort.dir), [data.sources, sort]);
  const pick = (key: StatsSortKey) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDirection(key) }));
  // The Smart filter column appears only when a filter has items in Ignored here.
  const filtered = data.totals.filteredOut > 0;
  const columns = filtered ? [...BASE_COLUMNS, FILTERED_COLUMN] : BASE_COLUMNS;
  if (!data.sources.length) return <div className="empty card-like"><h2>No sources to count yet</h2></div>;
  return (
    <div className="tblwrap">
      <table className="tbl stat-tbl" aria-label={`Statistics for each source in ${data.name}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const on = sort.key === c.key;
              return (
                <th key={c.key} scope="col" className={c.numeric ? "num" : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  <button type="button" onClick={() => pick(c.key)}>{c.label}{on ? <Icon name={sort.dir === "asc" ? "up" : "down"} /> : null}</button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <tr key={r.sourceId ?? "none"}><SourceCell row={r} /><Cells stats={r.stats} filtered={filtered} /></tr>)}
        </tbody>
        <tfoot>
          <tr><th scope="row" className="stat-name">Total · {plural(data.sources.length, "source")}</th><Cells stats={data.totals} filtered={filtered} /></tr>
        </tfoot>
      </table>
    </div>
  );
}

export function StatsPage({ place }: { place: StatsPlace }) {
  const ws = useWorkspace();
  const exists = place.t === "s" ? ws.sourceById.has(place.id) : ws.collectionById.has(place.id);
  const sourceQ = useQuery({ ...sourceStatsQuery(place.id), enabled: exists && place.t === "s" });
  const collectionQ = useQuery({ ...collectionStatsQuery(place.id), enabled: exists && place.t === "c" });
  if (!exists) return <Gone place={place} />;

  const q = place.t === "s" ? sourceQ : collectionQ;
  const title = place.t === "s" ? ws.sourceById.get(place.id)!.title : ws.collectionById.get(place.id)!.name;
  let body: ReactNode;
  if (q.isPending) body = <Loading />;
  else if (q.isError) body = <Failed error={q.error} onRetry={() => void q.refetch()} />;
  else body = place.t === "s" ? <SourceBody data={sourceQ.data!} /> : <CollectionBody data={collectionQ.data!} />;
  return (
    <div className={`col ${place.t === "c" ? "wide" : "narrow"}`}>
      <Trail />
      <StatsHead place={place} title={title} asOf={q.data?.asOf ?? null} />
      {body}
    </div>
  );
}
