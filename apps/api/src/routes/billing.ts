import { z } from "zod";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { BILLING_INTENTS, billingHandoff } from "../billing.ts";
import { Router, parse, rateLimit } from "../http.ts";

/** Settings → Plan: where to go to pay for a plan or manage the one paid for (billing.ts). */
export function billingRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.post("/api/billing/handoff", (req, ctx) => {
    const p = requirePrincipal(ctx);
    rateLimit(`billing:${p.accountId}`, 20, 60 * 60_000);
    const { intent } = parse(z.object({ intent: z.enum(BILLING_INTENTS) }), req.body);
    return billingHandoff(ctx.app, p.accountId, intent);
  });
  return r;
}
