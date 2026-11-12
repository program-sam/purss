import { z } from "zod";
import type { Ctx } from "../app.ts";
import { requirePrincipal, requireRecentAuth } from "../app.ts";
import { PASSWORD_MAX } from "../auth/passwords.ts";
import { Router, clientAddress, parse, rateLimit } from "../http.ts";
import { confirmEmail, getAccountEmail, requestPasswordReset, resendVerification, resetPassword, setAccountEmail } from "../services/account-email.ts";

/** The account's email address, its confirmation link, and password reset by email (plan/27). */
export function accountEmailRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  const token = z.string().min(20).max(200);

  r.get("/api/account/email", (_req, ctx) => getAccountEmail(ctx.app, requirePrincipal(ctx).accountId));
  // Changing the address the account signs in with needs a recent sign-in, like adding a sign-in method.
  r.put("/api/account/email", (req, ctx) => {
    const p = requirePrincipal(ctx);
    requireRecentAuth(p);
    rateLimit(`email-set:${p.accountId}`, 5, 60 * 60_000);
    const { email } = parse(z.object({ email: z.string().max(300) }), req.body);
    return setAccountEmail(ctx.app, p.accountId, email);
  });
  r.post("/api/account/email/resend", (_req, ctx) => {
    const p = requirePrincipal(ctx);
    rateLimit(`email-resend:${p.accountId}`, 3, 60 * 60_000);
    return resendVerification(ctx.app, p.accountId);
  });

  r.post("/api/email/verify", (req, ctx) => {
    rateLimit(`email-verify:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 20);
    confirmEmail(ctx.app, parse(z.object({ token }), req.body).token);
    return { ok: true };
  });

  // Always the same answer, sent at once: whether an address has an account stays private.
  r.post("/api/password-reset", (req, ctx) => {
    const { email } = parse(z.object({ email: z.string().trim().min(1).max(300) }), req.body);
    rateLimit(`reset:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 10, 60 * 60_000);
    rateLimit(`reset-id:${email.toLowerCase()}`, 5, 60 * 60_000);
    requestPasswordReset(ctx.app, email);
    return { ok: true };
  });
  r.post("/api/password-reset/confirm", async (req, ctx) => {
    rateLimit(`reset-confirm:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 20);
    const body = parse(z.object({ token, password: z.string().max(PASSWORD_MAX * 4) }), req.body);
    await resetPassword(ctx.app, body.token, body.password);
    return { ok: true };
  });
  return r;
}
