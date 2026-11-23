import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import { PLAN_LABELS, PLAN_LIMITS, PLAN_PRICES_EUR, euros } from "@purss/domain";
import type { PlanUsage } from "@purss/domain";
import { Button, Icon, Segmented } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { keys } from "../../api/queries.ts";
import { platform } from "../../platform/index.ts";
import { usePurss } from "../../state/purss.tsx";
import { planUsageLine } from "../../shell/PlanUsage.tsx";

const copy = app.account.planTab;

type Period = "year" | "month";
type Intent = "plus_month" | "plus_year" | "pro_month" | "pro_year" | "manage";

const PAID = [
  { plan: "plus", lede: copy.plusLede, has: copy.plusHas },
  { plan: "pro", lede: copy.proLede, has: copy.proHas },
] as const;


/**
 * Settings → Plan (hosted): what the account's plan allows and uses, and, where the service takes
 * payments, buying Plus or Pro or managing the plan paid for. Paying happens on the billing
 * service's own pages; it sends the person back here (`?dialog=plan`), and the plan changes as soon
 * as the payment is confirmed, so this tab checks again for a minute after opening.
 */
export function PlanTab() {
  const qc = useQueryClient();
  const ws = usePurss();
  const installation = useSession().data?.installation;
  const billing = installation?.billing ?? false;
  const planUsage = (ws.data as { planUsage?: PlanUsage }).planUsage ?? null;
  const [period, setPeriod] = useState<Period>("year");
  const [busy, setBusy] = useState<Intent | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!billing) return;
    let n = 0;
    const t = setInterval(() => { if (++n > 12) clearInterval(t); else void qc.invalidateQueries({ queryKey: keys.bootstrap }); }, 5000);
    return () => clearInterval(t);
  }, [billing, qc]);

  async function go(intent: Intent) {
    setBusy(intent); setError("");
    try {
      const { url } = await post<{ url: string }>("/api/billing/handoff", { intent });
      // The apps hand the payment page to the browser; the link back opens the app again.
      if (platform.connection) { platform.openExternal(url); setBusy(null); } else window.location.assign(url);
    } catch (err) { setError(messageOf(err)); setBusy(null); }
  }

  if (!planUsage?.plan) return <p className="fine">{installation?.mode === "self" ? copy.noLimitsSelf : copy.planUnavailable}</p>;
  const plan = planUsage.plan;
  const limits = PLAN_LIMITS[plan];
  const save = Math.round(100 - (100 * PLAN_PRICES_EUR.plus.year) / (12 * PLAN_PRICES_EUR.plus.month));
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="field">
        <div className="lbl">{copy.yourPlan(PLAN_LABELS[plan])}</div>
        <p className="fine">
          {planUsageLine(planUsage)}{limits.collections === null ? copy.unlimitedCollections : copy.collectionsOf(planUsage.collections.used, limits.collections)}.
          {" "}{copy.savedLinks}
        </p>
      </div>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {plan === "unlimited" ? <p className="fine">{copy.noLimits}</p>
        : !billing ? <p className="fine">{installation?.mode === "self" ? copy.administratorSetsPlans : copy.paidUnavailable}</p>
        : plan === "free" ? (
          <>
            <Segmented label="Billing" value={period} onChange={setPeriod} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
              options={[{ value: "year", label: copy.yearly(save) }, { value: "month", label: copy.monthly }]} />
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              {PAID.map((p) => {
                const price = PLAN_PRICES_EUR[p.plan];
                const intent = `${p.plan}_${period}` as Intent;
                return (
                  <div key={p.plan} className="field" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 16, gap: 8 }}>
                    <strong style={{ fontSize: 17 }}>{PLAN_LABELS[p.plan]}</strong>
                    <span><b style={{ fontSize: 22 }}>{period === "year" ? euros(price.year / 12) : euros(price.month)}</b>{copy.aMonth}</span>
                    <span className="fine">{period === "year" ? copy.billedYearly(euros(price.year)) : copy.billedMonthly}{copy.vatIncluded}</span>
                    <p className="fine">{p.lede}</p>
                    <ul className="fine" style={{ margin: 0, paddingLeft: 18 }}>{p.has.map((h) => <li key={h}>{h}</li>)}</ul>
                    <Button variant="primary" disabled={busy !== null} onClick={() => void go(intent)}>{busy === intent ? copy.opening : copy.choose(PLAN_LABELS[p.plan])}</Button>
                  </div>
                );
              })}
            </div>
            <p className="fine">{copy.payments}</p>
          </>
        ) : (
          <div className="field">
            <div><Button disabled={busy !== null} onClick={() => void go("manage")}>{busy === "manage" ? copy.opening : copy.manage}</Button></div>
            <p className="fine">{copy.manageHint}</p>
          </div>
        )}
    </div>
  );
}
