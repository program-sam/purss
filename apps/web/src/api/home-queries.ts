import { queryOptions } from "@tanstack/react-query";
import type { ActivityDTO, HomeOverview } from "@purss/domain";
import { outbox } from "../outbox/instance.ts";
import { visitKnown } from "../state/visit.ts";
import { get } from "./client.ts";
import { keys } from "./queries.ts";

/*
 * What Home says to someone coming back, and what the engine has been doing.
 *
 * The overview sits under the items key so every "items changed" event refreshes it with the lists. The activity has a key of
 * its own because it is refreshed by events too, but never more often than every 30 seconds (see state/activity.ts).
 */

export const homeOverviewKey = [...keys.items, "overview"] as const;

/** Reading Home changes nothing on the server; it waits for this page load's visit call (state/visit.ts) so the answer is about the right visit. */
export function homeOverviewQuery() {
  return queryOptions({
    queryKey: homeOverviewKey,
    queryFn: async ({ signal }) => {
      await visitKnown();
      const o = await get<HomeOverview>("/api/home", undefined, signal);
      // Changes not yet sent show here as they do in every list.
      await outbox.ready;
      return { ...o, toRead: { ...o.toRead, items: outbox.overlay(o.toRead.items) }, recentlyKept: outbox.overlay(o.recentlyKept) };
    },
    staleTime: 20_000,
  });
}

export const activityKey = ["activity"] as const;
export const ACTIVITY_MIN_MS = 30_000;

export const activityQuery = queryOptions({
  queryKey: activityKey,
  queryFn: ({ signal }) => get<ActivityDTO>("/api/activity", undefined, signal),
  staleTime: ACTIVITY_MIN_MS,
  refetchInterval: 60_000,
});
