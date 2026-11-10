import { PLAN_LABELS } from "@purss/domain";
import type { Capacity } from "@purss/domain";
import { Icon } from "@purss/ui";
import { formatCount, plural } from "../lib/format.ts";

const n = (v: number) => formatCount(v, "en");

/** "37 of 100 sources", or "37 sources" without a limit. */
export function capacityLine(c: Capacity): string {
  return c.sources.limit === null ? plural(c.sources.used, "source") : `${n(c.sources.used)} of ${n(c.sources.limit)} sources`;
}

/** The sidebar meter: followed sources of the plan's limit. Without a limit there is nothing to measure against. */
export function CapacityMeter({ capacity }: { capacity: Capacity }) {
  const { used, limit } = capacity.sources;
  if (limit === null) return <Icon name="rss" className="stor-ic" />;
  return <span className="meter" aria-hidden="true"><i className="feeds" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></span>;
}

const line = (used: number, limit: number | null, what: string) => (limit === null ? plural(used, what) : `${n(used)} of ${n(limit)}`);

/** What the plan allows and what is used, shown from the sidebar footer. */
/** `onPlan` opens Settings → Plan (hosted installations). */
export function CapacityPanel({ capacity, paused, onPlan }: { capacity: Capacity; paused: string | null; onPlan?: () => void }) {
  const full = (k: "sources" | "collections") => capacity[k].limit !== null && capacity[k].used >= capacity[k].limit!;
  return (
    <div className="meter-pop">
      <strong style={{ fontSize: 15, fontWeight: 800 }}>{capacityLine(capacity)}</strong>
      <CapacityMeter capacity={capacity} />
      <dl>
        <div style={{ display: "contents" }}><dt /><dd style={{ textAlign: "left", fontWeight: 600 }}>Sources</dd><dd>{line(capacity.sources.used, capacity.sources.limit, "source")}</dd></div>
        <div style={{ display: "contents" }}><dt /><dd style={{ textAlign: "left", fontWeight: 600 }}>Collections</dd><dd>{line(capacity.collections.used, capacity.collections.limit, "collection")}</dd></div>
      </dl>
      {paused ? <p className="state note" style={{ marginTop: 12 }}><Icon name="alert" /><span>{paused}</span></p> : null}
      <p className="fine">
        {capacity.plan ? `Your plan: ${PLAN_LABELS[capacity.plan]}.` : "No limits are set on this server."}
        {full("sources") ? " Unfollow a source to follow another." : ""}
        {full("collections") ? " Remove a collection to add another." : ""}
        {" "}Saved links don't count as sources.
      </p>
      {onPlan && capacity.plan && capacity.plan !== "unlimited" ? <button type="button" className="link" onClick={onPlan}>{capacity.plan === "free" ? "See plans" : "Manage your plan"}</button> : null}
    </div>
  );
}
