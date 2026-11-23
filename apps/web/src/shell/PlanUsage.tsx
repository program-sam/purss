import { app } from "@purss/translations/app";
import { PLAN_LABELS } from "@purss/domain";
import type { PlanUsage } from "@purss/domain";
import { Icon } from "@purss/ui";
import { bytesLabel, formatCount, plural } from "../lib/format.ts";

const t = app.shell.planUsage;
const n = (v: number) => formatCount(v, "en");

/** "37 of 100 sources", or "37 sources" without a limit. */
export function planUsageLine(c: PlanUsage): string {
  return c.sources.limit === null ? plural(c.sources.used, app.words.sourceLower) : t.sourcesOf(n(c.sources.used), n(c.sources.limit));
}

/** The sidebar meter: followed sources of the plan's limit. Without a limit there is nothing to measure against. */
export function PlanUsageMeter({ planUsage }: { planUsage: PlanUsage }) {
  const { used, limit } = planUsage.sources;
  if (limit === null) return <Icon name="rss" className="stor-ic" />;
  return <span className="meter" aria-hidden="true"><i className="feeds" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></span>;
}

const line = (used: number, limit: number, what: string) => t.line(n(used), n(limit), what);

/** The panel's heading: "37 of 100 sources", or "2 sources in 2 collections" when sources have no limit. */
function heading(c: PlanUsage): string {
  return c.sources.limit === null ? t.sourcesIn(plural(c.sources.used, app.words.sourceLower), plural(c.collections.used, app.words.collectionLower)) : planUsageLine(c);
}

/** What limits this account (its plan's sources and collections, and any storage allowance set for it) and what it uses. */
/** `onPlan` opens Settings → Plan (hosted installations). */
export function PlanUsagePanel({ planUsage, paused, onPlan }: { planUsage: PlanUsage; paused: string | null; onPlan?: () => void }) {
  const full = (k: "sources" | "collections") => planUsage[k].limit !== null && planUsage[k].used >= planUsage[k].limit!;
  // A copy saved offline by an earlier version has no storage figures.
  const storage = planUsage.storage ?? { used: 0, limit: null };
  const rows = [
    planUsage.sources.limit !== null ? { label: app.words.sources, value: line(planUsage.sources.used, planUsage.sources.limit, "") } : null,
    planUsage.collections.limit !== null ? { label: app.words.collections, value: line(planUsage.collections.used, planUsage.collections.limit, "") } : null,
    storage.limit !== null ? { label: t.storage, value: t.storageOf(bytesLabel(storage.used), bytesLabel(storage.limit)) } : null,
  ].filter((r) => r !== null);
  const unlimited = [planUsage.sources.limit === null ? app.words.sourcesLower : null, planUsage.collections.limit === null ? app.words.collectionsLower : null, storage.limit === null ? t.unlimitedStorage : null].filter((w) => w !== null);
  return (
    <div className="meter-pop">
      <strong style={{ fontSize: 15, fontWeight: 800 }}>{heading(planUsage)}</strong>
      {planUsage.sources.limit !== null ? <PlanUsageMeter planUsage={planUsage} /> : null}
      {rows.length ? (
        <dl>
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
        </dl>
      ) : null}
      {paused ? <p className="state note" style={{ marginTop: 12 }}><Icon name="alert" /><span>{paused}</span></p> : null}
      <p className="fine">
        {planUsage.plan ? t.yourPlan(PLAN_LABELS[planUsage.plan]) : ""}
        {unlimited.length ? t.noLimit(t.listWords(unlimited)) : ""}
        {full("sources") ? t.unfollow : ""}
        {full("collections") ? t.removeCollection : ""}
        {planUsage.sources.limit !== null ? t.savedLinks : ""}
      </p>
      {onPlan && planUsage.plan && planUsage.plan !== "unlimited" ? <button type="button" className="link" onClick={onPlan}>{planUsage.plan === "free" ? app.words.seePlans : t.managePlan}</button> : null}
    </div>
  );
}
