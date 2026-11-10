import { useQuery } from "@tanstack/react-query";
import { Icon } from "@purss/ui";
import { plural } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { reconcileBadgeQuery } from "../shared/api.ts";

/** A calm line on Home, only while entries from a replaced or restored engine wait for a decision. */
export function ReviewNotice() {
  const nav = useNav();
  const q = useQuery(reconcileBadgeQuery);
  const total = q.data?.total ?? 0;
  if (!total) return null;
  return (
    <p className="notice" role="status">
      <Icon name="info" />
      <span>{plural(total, "collected item", "collected items")} {total === 1 ? "needs" : "need"} a look before {total === 1 ? "it appears" : "they appear"} in your PURSS. <button type="button" className="link" onClick={() => nav.goPath("/review")}>Review</button></span>
    </p>
  );
}
