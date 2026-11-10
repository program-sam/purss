import type { Ctx } from "../app.ts";
import { requireAdmin, requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { assistantSwitchSchema, assistantTokenCreateSchema, oauthApproveSchema } from "@purss/domain";
import { adminAccess, createToken, getAccess, revokeGrant, revokeToken, setEnabled, setInstallationEnabled } from "../services/assistant.ts";
import { approveRequest, describeRequest } from "../oauth/authorize.ts";

/**
 * Settings → Assistants, the administrator's installation switch (plan/23), and the OAuth consent
 * page's two calls (plan/33). All of /api/assistant is for browser sessions only (connect/clients.ts).
 */
export function assistantRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/assistant", (_req, ctx) => getAccess(ctx.app, requirePrincipal(ctx)));
  r.put("/api/assistant", (req, ctx) => setEnabled(ctx.app, requirePrincipal(ctx), parse(assistantSwitchSchema, req.body).enabled));
  r.post("/api/assistant/tokens", (req, ctx) => createToken(ctx.app, requirePrincipal(ctx), parse(assistantTokenCreateSchema, req.body)));
  r.delete("/api/assistant/tokens/:id", (req, ctx) => revokeToken(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.delete("/api/assistant/grants/:id", (req, ctx) => revokeGrant(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.get("/api/assistant/oauth/request", (req, ctx) => describeRequest(ctx.app, requirePrincipal(ctx), req.query));
  r.post("/api/assistant/oauth/approve", (req, ctx) => approveRequest(ctx.app, requirePrincipal(ctx), parse(oauthApproveSchema, req.body)));
  r.get("/api/admin/assistant", (_req, ctx) => { requireAdmin(ctx); return adminAccess(ctx.app); });
  r.put("/api/admin/assistant", (req, ctx) => setInstallationEnabled(ctx.app, requireAdmin(ctx, { stepUp: true }), parse(assistantSwitchSchema, req.body).enabled));
  return r;
}
