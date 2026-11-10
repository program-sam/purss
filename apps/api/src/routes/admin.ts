import { z } from "zod";
import { PLAN_NAMES, aiKeySchema, newsPostInputSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requireAdmin } from "../app.ts";
import { Router, parse } from "../http.ts";
import { emailSchema } from "../services/account-email.ts";
import { removeServerKey, serverKeyInfo, setServerKey } from "../services/ai-access.ts";
import { adminHealth, adminInvite, cancelAdminJob, confirmDeletionEngine, listAccounts, listAdminJobs, listAudit, reconcileUsage, retryAdminJob, updateAccount, listInvites, revokeInvite } from "../services/admin.ts";
import { createNewsPost, deleteNewsPost, newsAdmin, updateNewsPost } from "../services/news.ts";
import { dismissReport, listReports, reportedPage, restoreShare, takeDownShare } from "../services/shares.ts";

/**
 * Administrator area. Every route checks the role on the server; routes that change
 * accounts or issue access also require recent strong authentication (step-up).
 */
export function adminRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.get("/api/admin/health", async (_req, ctx) => { requireAdmin(ctx); return adminHealth(ctx.app); });

  r.get("/api/admin/jobs", (req, ctx) => {
    requireAdmin(ctx);
    const { status, limit } = parse(z.object({ status: z.enum(["queued", "leased", "done", "failed", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), Object.fromEntries(req.query));
    return listAdminJobs(ctx.app, { status, limit });
  });
  r.post("/api/admin/jobs/:id/retry", (req, ctx) => retryAdminJob(ctx.app, requireAdmin(ctx), req.params.id!));
  r.post("/api/admin/jobs/:id/cancel", (req, ctx) => cancelAdminJob(ctx.app, requireAdmin(ctx), req.params.id!));

  r.get("/api/admin/audit", (req, ctx) => {
    requireAdmin(ctx);
    const { before, limit } = parse(z.object({ before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), Object.fromEntries(req.query));
    return listAudit(ctx.app, { before, limit });
  });

  r.post("/api/admin/usage/reconcile", (_req, ctx) => reconcileUsage(ctx.app, requireAdmin(ctx)));

  // Accounts and invitations (every installation; storage allowances on hosted ones only).
  r.get("/api/admin/accounts", (_req, ctx) => { requireAdmin(ctx); return listAccounts(ctx.app); });
  r.get("/api/admin/invites", (_req, ctx) => { requireAdmin(ctx); return listInvites(ctx.app); });
  r.delete("/api/admin/invites/:id", (req, ctx) => revokeInvite(ctx.app, requireAdmin(ctx, { stepUp: true }), req.params.id!));
  r.post("/api/admin/invites", async (req, ctx) => {
    const admin = requireAdmin(ctx, { stepUp: true });
    const body = parse(z.object({
      note: z.string().trim().max(120).nullable().default(null),
      allocationBytes: z.number().int().min(0).nullable().default(null),
      days: z.number().int().min(1).max(60).default(14),
      // Where to send the link; used for this one message and not stored.
      email: emailSchema.nullable().default(null),
    }), req.body);
    return adminInvite(ctx.app, admin, body.note, body.allocationBytes, body.days, body.email);
  });
  r.patch("/api/admin/accounts/:id", (req, ctx) => {
    const admin = requireAdmin(ctx, { stepUp: true });
    const patch = parse(z.object({ allocationBytes: z.number().int().min(0).nullable().optional(), plan: z.enum(PLAN_NAMES).optional(), status: z.enum(["active", "suspended"]).optional(), isAdmin: z.boolean().optional() }), req.body);
    return updateAccount(ctx.app, admin, req.params.id!, patch);
  });
  // Smart filters (plan/36): the server's Jev key. Hosted, accounts on Pro use it; self-hosted, every account may.
  r.get("/api/admin/ai", (_req, ctx) => { requireAdmin(ctx); return serverKeyInfo(ctx.app); });
  r.put("/api/admin/ai/key", (req, ctx) => setServerKey(ctx.app, requireAdmin(ctx, { stepUp: true }), parse(aiKeySchema, req.body).key));
  r.delete("/api/admin/ai/key", (_req, ctx) => removeServerKey(ctx.app, requireAdmin(ctx, { stepUp: true })));
  // Reports about shared pages (every installation). Taking a page down or restoring it needs step-up; so does nothing else here.
  r.get("/api/admin/reports", (req, ctx) => {
    requireAdmin(ctx);
    const { status } = parse(z.object({ status: z.enum(["open", "all", "taken_down"]).default("open") }), Object.fromEntries(req.query));
    return listReports(ctx.app, status);
  });
  r.get("/api/admin/shares/:id/page", (req, ctx) => { requireAdmin(ctx); return reportedPage(ctx.app, req.params.id!); });
  r.post("/api/admin/shares/:id/takedown", (req, ctx) => {
    const admin = requireAdmin(ctx, { stepUp: true });
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return takeDownShare(ctx.app, admin, req.params.id!, reason);
  });
  r.post("/api/admin/shares/:id/restore", (req, ctx) => restoreShare(ctx.app, requireAdmin(ctx, { stepUp: true }), req.params.id!));
  r.post("/api/admin/reports/:id/dismiss", (req, ctx) => dismissReport(ctx.app, requireAdmin(ctx), req.params.id!));
  // The installation's news. Drafts are the administrator's own; whatever reaches every PURSS (publishing, editing or
  // deleting a published post) needs step-up.
  r.get("/api/admin/news", (_req, ctx) => { requireAdmin(ctx); return newsAdmin(ctx.app); });
  r.post("/api/admin/news", (req, ctx) => {
    requireAdmin(ctx);
    const body = parse(newsPostInputSchema, req.body);
    return createNewsPost(ctx.app, requireAdmin(ctx, { stepUp: body.publish }), body);
  });
  r.put("/api/admin/news/:id", (req, ctx) => {
    requireAdmin(ctx);
    const body = parse(newsPostInputSchema, req.body);
    const published = !!ctx.app.db.get("SELECT 1 FROM news_posts WHERE id = ? AND status = 'published'", req.params.id!);
    return updateNewsPost(ctx.app, requireAdmin(ctx, { stepUp: body.publish || published }), req.params.id!, body);
  });
  r.delete("/api/admin/news/:id", (req, ctx) => {
    const published = !!ctx.app.db.get("SELECT 1 FROM news_posts WHERE id = ? AND status = 'published'", req.params.id!);
    return deleteNewsPost(ctx.app, requireAdmin(ctx, { stepUp: published }), req.params.id!);
  });
  r.post("/api/admin/accounts/:id/deletion/engine-removed", (req, ctx) => confirmDeletionEngine(ctx.app, requireAdmin(ctx, { stepUp: true }), req.params.id!));
  return r;
}
