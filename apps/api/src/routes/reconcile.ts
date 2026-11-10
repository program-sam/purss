import { z } from "zod";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { acceptSuggested, listReconciliation, resolveEntry } from "../services/reconcile.ts";

/** Review queue for entries from a replaced or restored engine. */
export function reconcileRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/reconcile", (req, ctx) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.get("limit")) || 100));
    return listReconciliation(ctx.app, requirePrincipal(ctx), limit);
  });
  // The literal route is registered before the `:id` route so it is not read as an entry id.
  r.post("/api/reconcile/accept-suggested", (req, ctx) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().max(60)).max(500).optional() }), req.body);
    return acceptSuggested(ctx.app, requirePrincipal(ctx), ids);
  });
  r.post("/api/reconcile/:id", (req, ctx) => {
    const body = parse(z.object({ action: z.enum(["match", "new", "dismiss"]), itemId: z.string().max(60).optional() }), req.body);
    return resolveEntry(ctx.app, requirePrincipal(ctx), req.params.id!, body.action, body.itemId);
  });
  return r;
}
