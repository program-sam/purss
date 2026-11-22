import { discoverDismissSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { dismissSuggestion, suggestionsFor } from "../services/discover.ts";
import { catalogFor } from "../services/discover-catalog.ts";

/**
 * Discover suggestions and the catalog of popular sources (not /api/discover, which looks up a pasted link) for the signed-in account.
 * Suggestions answer "not found" on a self-hosted installation; the catalog is empty wherever there is no catalog file.
 */
export function discoverRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/suggestions", (_req, ctx) => suggestionsFor(ctx.app, requirePrincipal(ctx)));
  r.get("/api/suggestions/catalog", (_req, ctx) => catalogFor(ctx.app, requirePrincipal(ctx)));
  r.get("/api/suggestions/catalog/:category", (req, ctx) => catalogFor(ctx.app, requirePrincipal(ctx), req.params.category!));
  r.post("/api/suggestions/dismiss", (req, ctx) => dismissSuggestion(ctx.app, requirePrincipal(ctx), parse(discoverDismissSchema, req.body).key));
  return r;
}
