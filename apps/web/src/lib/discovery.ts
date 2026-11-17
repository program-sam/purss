import type { DiscoveryCandidate } from "@purss/domain";

/**
 * Which found feed starts out chosen: the page's own feed when one is; the only one when there is one; the first when
 * nothing says they differ (the address was a feed itself, or a service's fixed pattern). When several were merely
 * listed on the page and none is shown to be the pasted page's, none (-1): the first would be arbitrary, and the
 * person picks. An alternative (a journal through Crossref next to its own feed) is chosen only when it is all there is.
 */
export function preselect(candidates: readonly Pick<DiscoveryCandidate, "matchesPage" | "alternative">[]): number {
  const main = candidates.flatMap((c, i) => (c.alternative ? [] : [{ c, i }]));
  if (!main.length) return candidates.length ? 0 : -1;
  const own = main.find(({ c }) => c.matchesPage === true);
  if (own) return own.i;
  if (main.length === 1) return main[0]!.i;
  return main.every(({ c }) => c.matchesPage === undefined) ? main[0]!.i : -1;
}
