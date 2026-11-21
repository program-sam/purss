import type { DiscoveryCandidate } from "@purss/domain";

type Choice = Pick<DiscoveryCandidate, "matchesPage" | "alternative" | "pageList">;

/** A list of posts read from the page's layout that PURSS isn't confident of: offered, never chosen for the person. */
const doubtful = (c: Choice): boolean => c.pageList !== undefined && c.pageList.confidence !== "high";

/**
 * Which found feed starts out chosen: the page's own feed when one is; the only one when there is one; the first when
 * nothing says they differ (the address was a feed itself, or a service's fixed pattern). When several were merely
 * listed on the page and none is shown to be the pasted page's, none (-1): the first would be arbitrary, and the
 * person picks. An alternative (a journal through Crossref next to its own feed) is chosen only when it is all there is.
 * A doubtful list of posts (a medium page list) is chosen in no case, not even when it is the only one.
 */
export function preselect(candidates: readonly Choice[]): number {
  const main = candidates.flatMap((c, i) => (c.alternative || doubtful(c) ? [] : [{ c, i }]));
  if (!main.length) return candidates.findIndex((c) => !doubtful(c));
  const own = main.find(({ c }) => c.matchesPage === true);
  if (own) return own.i;
  if (main.length === 1) return main[0]!.i;
  return main.every(({ c }) => c.matchesPage === undefined) ? main[0]!.i : -1;
}
