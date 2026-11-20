import { app } from "@purss/copy/app";
import { PLAN_LABELS } from "@purss/domain";
import type { Capacity } from "@purss/domain";
import { Icon } from "@purss/ui";
import { bytesLabel, formatCount, plural } from "../lib/format.ts";

const t = app.shell.capacity;
const n = (v: number) => formatCount(v, "en");

/** "37 of 100 sources", or "37 sources" without a limit. */
export function capacityLine(c: Capacity): string {
  return c.sources.limit === null ? plural(c.sources.used, app.lib.nouns.source) : t.sourcesOf(n(c.sources.used), n(c.sources.limit));
}

/** The sidebar meter: followed sources of the plan's limit. Without a limit there is nothing to measure against. */
export function CapacityMeter({ capacity }: { capacity: Capacity }) {
  const { used, limit } = capacity.sources;
  if (limit === null) return <Icon name="rss" className="stor-ic" />;
  return <span className="meter" aria-hidden="true"><i className="feeds" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></span>;
}

const line = (used: number, limit: number, what: string) => t.line(n(used), n(limit), what);

/** The panel's heading: "37 of 100 sources", or "2 sources in 2 collections" when sources have no limit. */
function heading(c: Capacity): string {
  return c.sources.limit === null ? t.sourcesIn(plural(c.sources.used, app.lib.nouns.source), plural(c.collections.used, app.lib.nouns.collection)) : capacityLine(c);
}

/** What limits this account (its plan's sources and collections, and any storage allowance set for it) and what it uses. */
/** `onPlan` opens Settings → Plan (hosted installations). */
export function CapacityPanel({ capacity, paused, onPlan }: { capacity: Capacity; paused: string | null; onPlan?: () => void }) {
  const full = (k: "sources" | "collections") => capacity[k].limit !== null && capacity[k].used >= capacity[k].limit!;
  // A copy saved offline by an earlier version has no storage figures.
  const storage = capacity.storage ?? { used: 0, limit: null };
  const rows = [
    capacity.sources.limit !== null ? { label: t.sources, value: line(capacity.sources.used, capacity.sources.limit, "") } : null,
    capacity.collections.limit !== null ? { label: t.collections, value: line(capacity.collections.used, capacity.collections.limit, "") } : null,
    storage.limit !== null ? { label: t.storage, value: t.storageOf(bytesLabel(storage.used), bytesLabel(storage.limit)) } : null,
  ].filter((r) => r !== null);
  const unlimited = [capacity.sources.limit === null ? t.unlimitedSources : null, capacity.collections.limit === null ? t.unlimitedCollections : null, storage.limit === null ? t.unlimitedStorage : null].filter((w) => w !== null);
  return (
    <div className="meter-pop">
      <strong style={{ fontSize: 15, fontWeight: 800 }}>{heading(capacity)}</strong>
      {capacity.sources.limit !== null ? <CapacityMeter capacity={capacity} /> : null}
      {rows.length ? (
        <dl>
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
        </dl>
      ) : null}
      {paused ? <p className="state note" style={{ marginTop: 12 }}><Icon name="alert" /><span>{paused}</span></p> : null}
      <p className="fine">
        {capacity.plan ? t.yourPlan(PLAN_LABELS[capacity.plan]) : ""}
        {unlimited.length ? t.noLimit(t.listWords(unlimited)) : ""}
        {full("sources") ? t.unfollow : ""}
        {full("collections") ? t.removeCollection : ""}
        {capacity.sources.limit !== null ? t.savedLinks : ""}
      </p>
      {onPlan && capacity.plan && capacity.plan !== "unlimited" ? <button type="button" className="link" onClick={onPlan}>{capacity.plan === "free" ? t.seePlans : t.managePlan}</button> : null}
    </div>
  );
}
