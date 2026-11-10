import { PLAN_LIMITS, PLAN_NAMES } from "@purss/domain";
import type { Capacity, Plan } from "@purss/domain";
import type { App } from "../app.ts";
import { HttpError } from "../http.ts";

/**
 * Hosted plans (packages/domain/src/plans.ts): the number of followed sources and of collections an
 * account may have. Self-hosted installs have no plans. Checks run inside the caller's write
 * transaction, so two requests can't both take the last place.
 */

const FOLLOWED_SOURCES = "SELECT COUNT(*) AS n FROM sources WHERE account_id = ? AND followed = 1 AND kind <> 'manual'";
const COLLECTIONS = "SELECT COUNT(*) AS n FROM collections c JOIN workspaces w ON w.id = c.workspace_id WHERE w.account_id = ?";

const isPlan = (v: string | null): v is Plan => v !== null && (PLAN_NAMES as readonly string[]).includes(v);

/** The account's stored plan, which applies while it isn't an administrator. */
export function storedPlan(app: App, accountId: string): Plan {
  const v = app.db.get<{ plan: string | null }>("SELECT plan FROM accounts WHERE id = ?", accountId)?.plan ?? null;
  return isPlan(v) ? v : "free";
}

/** The plan that limits the account: null when self-hosted (no limits), Unlimited for administrators. */
export function planOf(app: App, accountId: string): Plan | null {
  if (app.config.mode !== "hosted") return null;
  if (app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", accountId)) return "unlimited";
  return storedPlan(app, accountId);
}

/** The plan a new account starts on; an administrator keeps it for when they stop being one. */
export function initialPlan(app: App): Plan | null {
  return app.config.mode === "hosted" ? "free" : null;
}

/** Hosted installs: accounts from before plans existed start on Free (administrators are Unlimited while they are). */
export function assignMissingPlans(app: App): void {
  if (app.config.mode !== "hosted") return;
  app.db.run("UPDATE accounts SET plan = 'free' WHERE plan IS NULL");
}

export function capacity(app: App, accountId: string): Capacity {
  const plan = planOf(app, accountId);
  const limits = plan ? PLAN_LIMITS[plan] : { sources: null, collections: null };
  return {
    plan,
    sources: { used: app.db.get<{ n: number }>(FOLLOWED_SOURCES, accountId)!.n, limit: limits.sources },
    collections: { used: app.db.get<{ n: number }>(COLLECTIONS, accountId)!.n, limit: limits.collections },
  };
}

const number = (n: number) => n.toLocaleString("en");

export class PlanLimit extends HttpError {
  constructor(what: "sources" | "collections", limit: number, plan: Plan) {
    const more = plan === "free" ? " Plus allows more." : plan === "plus" && what === "sources" ? " Pro allows more." : "";
    super(403, "plan_limit", what === "sources"
      ? `Your plan allows ${number(limit)} sources. Unfollow one to follow another.${more}`
      : `Your plan allows ${number(limit)} collections. Remove one to add another.${more}`, { limit: String(limit), what });
  }
}

/** Refuse when `adding` more sources or collections would take the account over its plan. */
export function assertRoom(app: App, accountId: string, what: "sources" | "collections", adding = 1): void {
  if (adding <= 0) return;
  const c = capacity(app, accountId);
  const { used, limit } = c[what];
  if (limit !== null && used + adding > limit) throw new PlanLimit(what, limit, c.plan!);
}
