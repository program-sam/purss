import { common } from "@purss/translations/common";

/**
 * Hosted plans: how many sources an account may follow and how many collections it may have.
 * Plans apply on hosted installs only; self-hosted installs have no such limits. Going over a
 * limit (after moving to a smaller plan) never removes anything: following and creating stop
 * until the account is back under it.
 */
export const PLAN_NAMES = ["free", "plus", "pro", "unlimited"] as const;
export type Plan = (typeof PLAN_NAMES)[number];

/** `null` is no limit. */
export type PlanLimits = { sources: number | null; collections: number | null };

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { sources: 100, collections: 5 },
  plus: { sources: 1000, collections: null },
  pro: { sources: 5000, collections: null },
  // For accounts the operator exempts; administrators are unlimited whatever their plan.
  unlimited: { sources: null, collections: null },
};

export const PLAN_LABELS: Record<Plan, string> = { free: common.plans.free, plus: common.plans.plus, pro: common.plans.pro, unlimited: common.plans.unlimited };

/** What the paid plans cost on the hosted service, in euros including VAT. */
export const PLAN_PRICES_EUR = { plus: { month: 2.5, year: 24 }, pro: { month: 5, year: 48 } } as const;

/** A euro amount as prices are written: €5, €2.50. */
export const euros = (n: number): string => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Sharing baskets and collections as public pages: Plus and up. */
export const planShares = (plan: Plan): boolean => plan !== "free";
/** Smart filters on the server's Jev key: Pro and Unlimited. */
export const planHasSmartFilters = (plan: Plan): boolean => plan === "pro" || plan === "unlimited";

/** What an account uses of its plan: followed sources (saved links don't count) and collections. `plan` is null when self-hosted. */
export type Capacity = {
  plan: Plan | null;
  sources: { used: number; limit: number | null };
  collections: { used: number; limit: number | null };
  /** Bytes the account stores, and the storage allowance set for it (null: none, in any mode). */
  storage: { used: number; limit: number | null };
};
