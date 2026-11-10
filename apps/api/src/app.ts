import { EventEmitter } from "node:events";
import { newId } from "@purss/domain";
import type { EventMessage } from "@purss/domain";
import type { Config } from "./config.ts";
import type { Database } from "./db/database.ts";
import { HttpError, nowIso } from "./http.ts";

export type App = {
  db: Database;
  config: Config;
  events: EventEmitter;
  serviceToken: string;
};

/** Resolved identity of a request. Every product query is scoped through it. */
export type Principal = {
  accountId: string;
  workspaceId: string;
  isAdmin: boolean;
  sessionId: string;
  csrf: string;
  authAt: string;
  /** The session's expiry was just extended (the cookie should be re-issued). */
  renewed?: boolean;
};

export type Ctx = { app: App; principal: Principal | null };

export function requirePrincipal(ctx: Ctx): Principal {
  if (!ctx.principal) throw new HttpError(401, "signed_out", "Please sign in again.");
  return ctx.principal;
}

/** Recent strong authentication window for sensitive actions. */
export const STEP_UP_SECONDS = 10 * 60;

export function requireAdmin(ctx: Ctx, opts: { stepUp?: boolean } = {}): Principal {
  const p = requirePrincipal(ctx);
  if (!p.isAdmin) throw new HttpError(403, "forbidden", "This needs an administrator.");
  if (opts.stepUp) requireRecentAuth(p);
  return p;
}

export function requireRecentAuth(p: Principal): void {
  if (Date.now() - Date.parse(p.authAt) > STEP_UP_SECONDS * 1000) {
    throw new HttpError(403, "step_up", "Please confirm it's you again before doing this.");
  }
}

export function audit(app: App, actor: string | null, action: string, target: string | null, outcome: "success" | "failure", detail?: string): void {
  app.db.run(
    "INSERT INTO audit_events (id, at, actor_account_id, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    newId("aud"), nowIso(), actor, action, target, outcome, detail ?? null,
  );
}

/** Raised with the account id when a notification is made or grows; connected phones may be woken (services/push.ts). */
export const NOTIFICATION_EVENT = "notification-created";

/** Broadcast a live update to the account's open event streams. */
export function emit(app: App, accountId: string, message: EventMessage): void {
  app.events.emit(`account:${accountId}`, message);
  if (message.type === "notification") app.events.emit(NOTIFICATION_EVENT, accountId);
}
