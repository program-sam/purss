import { Router } from "../http.ts";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { activityFor } from "../services/activity.ts";
import { homeOverview, touchVisit } from "../services/home.ts";

/** Home for someone coming back (its lists are `GET /api/items?mix=home`), the visit, and the engine's recent activity. */
export function homeRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/home", (_req, ctx) => homeOverview(ctx.app, requirePrincipal(ctx)));
  // Sent by the web app from any page when the person interacts with it in the foreground, every few minutes at most. A
  // mutation, so it carries the same origin and CSRF checks as every other.
  r.post("/api/activity/visit", (_req, ctx) => touchVisit(ctx.app, requirePrincipal(ctx).workspaceId));
  r.get("/api/activity", (_req, ctx) => activityFor(ctx.app, requirePrincipal(ctx)));
  return r;
}
