import { discoverDismissSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { dismissSuggestion, suggestionsFor } from "../services/discover.ts";
import { catalogueFor, catalogueIcon } from "../services/discovery-catalogue.ts";
import { sendIcon } from "./public.ts";

/**
 * Discover suggestions and the catalogue of popular sources (not /api/discover, which looks up a pasted link) for the signed-in account.
 * Suggestions answer "not found" on a self-hosted installation; the catalogue is empty wherever there is no catalogue file.
 */
export function discoverRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/suggestions", (_req, ctx) => suggestionsFor(ctx.app, requirePrincipal(ctx)));
  r.get("/api/suggestions/catalogue", (_req, ctx) => catalogueFor(ctx.app, requirePrincipal(ctx)));
  r.get("/api/suggestions/catalogue/icons/:digest", (req, ctx, res) => { requirePrincipal(ctx); return sendIcon(req.raw, res, catalogueIcon(ctx.app, req.params.digest!)); });
  r.get("/api/suggestions/catalogue/:category", (req, ctx) => catalogueFor(ctx.app, requirePrincipal(ctx), req.params.category!));
  r.post("/api/suggestions/dismiss", (req, ctx) => dismissSuggestion(ctx.app, requirePrincipal(ctx), parse(discoverDismissSchema, req.body).key));
  return r;
}
