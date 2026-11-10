import { aiFilterRuleSchema, aiFilterSaveSchema } from "@purss/domain";
import type { AiFilterScope } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse, rateLimit } from "../http.ts";
import { aiSettings } from "../services/ai-access.ts";
import { deleteFilter, getFilter, listFilters, previewFilter, saveFilter } from "../services/ai-filters.ts";

/** Smart filters (plan/36): whether they can run, and the filter of each source and collection. */
export function aiFiltersRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/ai", (_req, ctx) => aiSettings(ctx.app, requirePrincipal(ctx)));
  r.get("/api/ai/filters", (_req, ctx) => ({ filters: listFilters(ctx.app, requirePrincipal(ctx)) }));

  for (const [base, scopeOf] of [
    ["/api/sources/:id/ai-filter", (id: string): AiFilterScope => ({ sourceId: id })],
    ["/api/collections/:id/ai-filter", (id: string): AiFilterScope => ({ collectionId: id })],
  ] as const) {
    r.get(base, (req, ctx) => ({ filter: getFilter(ctx.app, requirePrincipal(ctx), scopeOf(req.params.id!)) }));
    r.put(base, (req, ctx) => ({ filter: saveFilter(ctx.app, requirePrincipal(ctx), scopeOf(req.params.id!), parse(aiFilterSaveSchema, req.body)) }));
    r.delete(base, (req, ctx) => {
      deleteFilter(ctx.app, requirePrincipal(ctx), scopeOf(req.params.id!));
      return { ok: true };
    });
    r.post(`${base}/preview`, async (req, ctx) => {
      const p = requirePrincipal(ctx);
      // Each preview is 20 requests to Jev on the server's key.
      rateLimit(`ai-preview:${p.accountId}`, 40, 10 * 60_000);
      return previewFilter(ctx.app, p, scopeOf(req.params.id!), parse(aiFilterRuleSchema, req.body));
    });
  }
  return r;
}
