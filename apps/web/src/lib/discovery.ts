import type { DiscoveryCandidate } from "@purss/domain";

type Choice = Pick<DiscoveryCandidate, "matchesPage" | "alternative" | "pageList" | "fromScripts">;

/**
 * A candidate PURSS can't confirm is the pasted page's own: a list of posts read from the page's layout that it isn't confident of, or anything found
 * through the page's scripts (a feed they name, a list on a page they point to). Offered, never chosen for the person.
 */
const doubtful = (c: Choice): boolean => c.fromScripts === true || (c.pageList !== undefined && c.pageList.confidence !== "high");

/**
 * Which found feed starts out chosen: the page's own feed when one is; the only one when there is one; the first when
 * nothing says they differ (the address was a feed itself, or a service's fixed pattern). When several were merely
 * listed on the page and none is shown to be the pasted page's, none (-1): the first would be arbitrary, and the
 * person picks. An alternative (a journal through Crossref next to its own feed) is chosen only when it is all there is.
 * A doubtful candidate (a medium page list, anything found in the page's scripts) is chosen in no case, not even when it is the only one.
 */
export function preselect(candidates: readonly Choice[]): number {
  const main = candidates.flatMap((c, i) => (c.alternative || doubtful(c) ? [] : [{ c, i }]));
  if (!main.length) return candidates.findIndex((c) => !doubtful(c));
  const own = main.find(({ c }) => c.matchesPage === true);
  if (own) return own.i;
  if (main.length === 1) return main[0]!.i;
  return main.every(({ c }) => c.matchesPage === undefined) ? main[0]!.i : -1;
}

/** How much chance reorders Discovery's popular sources, on their log-scale weight. */
const CHANCE = 1;

/**
 * Sources most popular first, with chance: each weight gets Gumbel noise from `random`, so a popular source usually comes early but
 * the order differs on every visit. Pure for a given `random`.
 */
export function byChance<T extends { weight: number }>(list: readonly T[], random: () => number = Math.random): T[] {
  return list
    .map((s) => ({ s, v: s.weight - CHANCE * Math.log(-Math.log(Math.min(Math.max(random(), 1e-12), 1 - 1e-12))) }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.s);
}

/** A shuffled copy (Fisher–Yates), for Discovery's category boxes. */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
