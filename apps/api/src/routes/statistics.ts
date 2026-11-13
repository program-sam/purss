import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, rateLimit } from "../http.ts";
import { collectionStats, sourceStats } from "../services/statistics.ts";

/** Private statistics for the signed-in account. Never mounted on the public share listener. */
export function statisticsRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  // Each answer counts over all of a source's or collection's items on the API's thread (about a second at 100,000), so an
  // account asks a few dozen times in ten minutes at most: enough to look around, not to keep the API busy for others.
  const counted = (ctx: Ctx) => { const p = requirePrincipal(ctx); rateLimit(`stats:${p.accountId}`, 30); return p; };
  r.get("/api/stats/sources/:id", (req, ctx) => sourceStats(ctx.app, counted(ctx), req.params.id!));
  r.get("/api/stats/collections/:id", (req, ctx) => collectionStats(ctx.app, counted(ctx), req.params.id!));
  return r;
}
