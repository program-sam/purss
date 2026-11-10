import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PLAN_LABELS, PLAN_LIMITS, PLAN_PRICES_EUR } from "@purss/domain";
import type { Capacity } from "@purss/domain";
import { Button, Icon, Segmented } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { keys } from "../../api/queries.ts";
import { platform } from "../../platform/index.ts";
import { useWorkspace } from "../../state/workspace.tsx";
import { capacityLine } from "../../shell/Capacity.tsx";

type Period = "year" | "month";
type Intent = "plus_month" | "plus_year" | "pro_month" | "pro_year" | "manage";

const PAID = [
  { plan: "plus", lede: "For people who follow a lot, and keep a lot.", has: ["1,000 sources", "Unlimited collections", "Share baskets and collections as public pages"] },
  { plan: "pro", lede: "For busy feeds you want curated for you.", has: ["5,000 sources", "Everything in Plus", "Smart filters: plain-language rules for what you want to see"] },
] as const;

const euros = (n: number) => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * Settings → Plan (hosted): what the account's plan allows and uses, and, where the service takes
 * payments, buying Plus or Pro or managing the plan paid for. Paying happens on the billing
 * service's own pages; it sends the person back here (`?dialog=plan`), and the plan changes as soon
 * as the payment is confirmed, so this tab checks again for a minute after opening.
 */
export function PlanTab() {
  const qc = useQueryClient();
  const ws = useWorkspace();
  const billing = useSession().data?.installation.billing ?? false;
  const capacity = (ws.data as { capacity?: Capacity }).capacity ?? null;
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

  if (!capacity?.plan) return <p className="fine">No limits are set on this server.</p>;
  const plan = capacity.plan;
  const limits = PLAN_LIMITS[plan];
  const save = Math.round(100 - (100 * PLAN_PRICES_EUR.plus.year) / (12 * PLAN_PRICES_EUR.plus.month));
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="field">
        <div className="lbl">Your plan: {PLAN_LABELS[plan]}</div>
        <p className="fine">
          {capacityLine(capacity)}{limits.collections === null ? ", unlimited collections" : `, ${capacity.collections.used} of ${limits.collections} collections`}.
          {" "}Saved links don't count as sources.
        </p>
      </div>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {plan === "unlimited" ? <p className="fine">Your account has no limits.</p>
        : !billing ? <p className="fine">The administrator of this server sets plans.</p>
        : plan === "free" ? (
          <>
            <Segmented label="Billing" value={period} onChange={setPeriod} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
              options={[{ value: "year", label: `Yearly, save ${save}%` }, { value: "month", label: "Monthly" }]} />
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              {PAID.map((p) => {
                const price = PLAN_PRICES_EUR[p.plan];
                const intent = `${p.plan}_${period}` as Intent;
                return (
                  <div key={p.plan} className="field" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 16, gap: 8 }}>
                    <strong style={{ fontSize: 17 }}>{PLAN_LABELS[p.plan]}</strong>
                    <span><b style={{ fontSize: 22 }}>{period === "year" ? euros(price.year / 12) : euros(price.month)}</b> a month</span>
                    <span className="fine">{period === "year" ? `Billed yearly as ${euros(price.year)}` : "Billed monthly"}, VAT included.</span>
                    <p className="fine">{p.lede}</p>
                    <ul className="fine" style={{ margin: 0, paddingLeft: 18 }}>{p.has.map((h) => <li key={h}>{h}</li>)}</ul>
                    <Button variant="primary" disabled={busy !== null} onClick={() => void go(intent)}>{busy === intent ? "Opening…" : `Choose ${PLAN_LABELS[p.plan]}`}</Button>
                  </div>
                );
              })}
            </div>
            <p className="fine">Payments are handled by Stripe. Cancel any time; your sources, baskets and exports stay yours on Free.</p>
          </>
        ) : (
          <div className="field">
            <div><Button disabled={busy !== null} onClick={() => void go("manage")}>{busy === "manage" ? "Opening…" : "Manage plan and payments"}</Button></div>
            <p className="fine">Change plan, update your card, see invoices or cancel. If you cancel, your plan stays until the end of the period you paid for, then moves to Free. Nothing you follow or keep is removed.</p>
          </div>
        )}
    </div>
  );
}
