import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Plan } from "@purss/domain";
import { appUrl } from "@purss/domain/paths";
import type { App } from "./app.ts";
import { HttpError, SIGNED_OUT_PACE, addressSender, clientAddress, parse, readBody, sendJson } from "./http.ts";
import { safeEqual } from "./secrets.ts";
import { planOf, storedPlan } from "./services/plans.ts";

/*
 * Paying for a plan through an external billing service (hosted only, config.billing). PURSS holds no
 * payment details and talks to no payment provider; the service does, and PURSS trusts it for exactly
 * one thing: which of Free, Plus and Pro an account is on.
 *
 * - Hand-off: a signed-in person asks for a plan (or to manage the one they pay for); PURSS answers
 *   with the service's address and a signed ticket naming the account, valid for ten minutes.
 * - Plan: the service posts { accountId, plan, at } signed with the same secret. Only Free, Plus and
 *   Pro can be set this way, and never over an administrator or an account the operator made Unlimited.
 *
 * Both signatures are HMAC-SHA256 of a purpose-labelled message, so one can never pass as the other.
 */

export const BILLING_INTENTS = ["plus_month", "plus_year", "pro_month", "pro_year", "manage"] as const;
export type BillingIntent = (typeof BILLING_INTENTS)[number];
const SETTABLE = ["free", "plus", "pro"] as const;

const TICKET_SECONDS = 600;
const PLAN_SKEW_SECONDS = 300;

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const mac = (secret: string, purpose: string, message: string) => createHmac("sha256", secret).update(`purss-billing:${purpose}\n${message}`).digest("base64url");

/** The address to send the person to: the service's /go with a signed ticket. */
export function billingHandoff(app: App, accountId: string, intent: BillingIntent, now = Date.now()): { url: string } {
  const cfg = app.config.billing;
  if (!cfg) throw new HttpError(404, "not_found", "Plans aren't paid for on this server.");
  const plan = planOf(app, accountId);
  if (plan === "unlimited") throw new HttpError(409, "unlimited", "Your account has no limits, so there is no plan to pay for.");
  const row = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  const payload = b64url(JSON.stringify({
    a: accountId,
    i: intent,
    p: plan,
    // Only a confirmed address, to fill in the payment page.
    e: row?.email && row.email_verified_at ? row.email : null,
    r: `${app.config.publicOrigin}${appUrl("/")}?dialog=plan`,
    x: Math.floor(now / 1000) + TICKET_SECONDS,
  }));
  return { url: `${cfg.url}/go?t=${payload}.${mac(cfg.secret, "ticket", payload)}` };
}

const planBody = z.object({ accountId: z.string().min(1).max(100), plan: z.enum(SETTABLE), at: z.number().int() }).strict();
/** Signatures already used, until they expire, so a copied request can't be sent again. */
const seen = new Map<string, number>();

/** POST /api/billing/plan from the billing service. No cookies; the signature is the only credential. */
export async function handleBillingPlan(app: App, raw: IncomingMessage, res: ServerResponse, now = Date.now()): Promise<void> {
  const cfg = app.config.billing;
  if (!cfg) throw new HttpError(404, "not_found", "Unknown route.");
  if (raw.method !== "POST") throw new HttpError(405, "method", "Use POST.");
  const body = parse(planBody, await readBody(raw, 4096, SIGNED_OUT_PACE, addressSender(clientAddress(raw, app.config.trustProxy))));
  const sig = String(raw.headers["x-purss-billing-signature"] ?? "");
  const message = `${body.at}\n${body.accountId}\n${body.plan}`;
  if (!safeEqual(sig, mac(cfg.secret, "plan", message))) throw new HttpError(401, "unauthorized", "Bad signature.");
  const seconds = Math.floor(now / 1000);
  if (Math.abs(seconds - body.at) > PLAN_SKEW_SECONDS) throw new HttpError(401, "stale", "The request is too old.");
  for (const [k, until] of seen) if (until < seconds) seen.delete(k);
  // Everything from here on runs without awaiting, so "seen" means the same request was already applied.
  if (seen.has(sig)) throw new HttpError(409, "replayed", "That request was already used.");

  const exists = app.db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", body.accountId);
  // Gone (or never here): the service stops charging for it.
  if (!exists) { sendJson(res, 404, { error: { code: "no_account", message: "No such account." } }); return; }
  const effective = planOf(app, body.accountId);
  if (effective === "unlimited") { sendJson(res, 200, { plan: "unlimited", changed: false }); return; }
  const before: Plan = storedPlan(app, body.accountId);
  if (before !== body.plan) {
    app.db.run("UPDATE accounts SET plan = ? WHERE id = ?", body.plan, body.accountId);
    console.log(`[billing] plan ${before} -> ${body.plan}`);
  }
  seen.set(sig, body.at + PLAN_SKEW_SECONDS);
  sendJson(res, 200, { plan: body.plan, changed: before !== body.plan });
}

/** For tests and the billing service: the header value for a plan request. */
export function signPlan(secret: string, body: { accountId: string; plan: string; at: number }): string {
  return mac(secret, "plan", `${body.at}\n${body.accountId}\n${body.plan}`);
}
