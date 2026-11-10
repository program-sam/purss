import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { ACTIVITY_MIN_MS, activityKey } from "../api/home-queries.ts";
import { refreshActivity } from "./activity.ts";

test("activity is refreshed after an event, but not more often than every 30 seconds", async (t) => {
  const qc = new QueryClient();
  t.after(() => qc.clear());
  let fetches = 0;
  const observe = async () => qc.fetchQuery({ queryKey: activityKey, queryFn: () => { fetches++; return Promise.resolve({}); }, staleTime: 0 });
  refreshActivity(qc);
  assert.equal(qc.getQueryState(activityKey), undefined, "nothing shows the activity yet, so nothing is asked for");
  await observe();
  const first = qc.getQueryState(activityKey)!;
  assert.equal(first.isInvalidated, false);
  refreshActivity(qc, first.dataUpdatedAt + 1000);
  assert.equal(qc.getQueryState(activityKey)!.isInvalidated, false, "one second after the last answer: wait");
  refreshActivity(qc, first.dataUpdatedAt + ACTIVITY_MIN_MS + 1);
  assert.equal(qc.getQueryState(activityKey)!.isInvalidated, true, "30 seconds on: ask again");
  assert.equal(fetches, 1);
});
