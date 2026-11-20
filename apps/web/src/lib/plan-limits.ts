import { app } from "@purss/copy/app";
import { PLAN_LABELS, PLAN_LIMITS } from "@purss/domain";
import type { Capacity } from "@purss/domain";
import { plural } from "./format.ts";

/** What the account's plan uses, when the workspace carries it (a copy saved offline by an earlier version has none). */
export const capacityOf = (data: object): Capacity | null => (data as { capacity?: Capacity }).capacity ?? null;

/**
 * What to say before a person starts a new collection when the plan has no room for one; null when it has (and always on
 * a self-hosted PURSS, which has no plans). The server still refuses a collection over the limit.
 */
export function collectionLimitNote(capacity: Capacity | null): string | null {
  const c = capacity?.collections;
  if (!capacity?.plan || !c || c.limit === null || c.used < c.limit) return null;
  const t = app.lib.planLimits;
  const more = capacity.plan === "free" && PLAN_LIMITS.plus.collections === null ? t.plusNoLimit : "";
  return t.collectionLimit(PLAN_LABELS[capacity.plan], plural(c.limit, app.words.collectionLower), c.used, more);
}
