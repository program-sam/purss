import type { DiscoveryCandidate } from "@purss/domain";

/**
 * Which found feed starts out chosen: the page's own feed when one is; the only one when there is one; the first when
 * nothing says they differ (the address was a feed itself, or a service's fixed pattern). When several were merely
 * listed on the page and none is shown to be the pasted page's, none (-1): the first would be arbitrary, and the
 * person picks.
 */
export function preselect(candidates: readonly Pick<DiscoveryCandidate, "matchesPage">[]): number {
  const own = candidates.findIndex((c) => c.matchesPage === true);
  if (own >= 0) return own;
  if (candidates.length <= 1) return candidates.length - 1;
  return candidates.every((c) => c.matchesPage === undefined) ? 0 : -1;
}
