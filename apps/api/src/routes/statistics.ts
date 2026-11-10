import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router } from "../http.ts";
import { collectionStats, sourceStats } from "../services/statistics.ts";

/** Private statistics for the signed-in account. Never mounted on the public share listener. */
export function statisticsRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/stats/sources/:id", (req, ctx) => sourceStats(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.get("/api/stats/collections/:id", (req, ctx) => collectionStats(ctx.app, requirePrincipal(ctx), req.params.id!));
  return r;
}
