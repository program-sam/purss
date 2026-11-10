import { downloadPlanRequestSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { parse, Router } from "../http.ts";
import { downloadPlan } from "../services/downloads.ts";

/** Automatic downloads to the phone apps (plan/38). Reached by a session or a mobile device token, never the extension's. */
export function downloadsRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.post("/api/downloads/plan", (req, ctx) => downloadPlan(ctx.app, requirePrincipal(ctx), parse(downloadPlanRequestSchema, req.body)));
  return r;
}
