import { useQuery } from "@tanstack/react-query";
import { app } from "@purss/copy/app";
import { Icon } from "@purss/ui";
import { plural } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { reconcileBadgeQuery } from "../shared/api.ts";

const t = app.review.reviewNotice;

/** A calm line on Home, only while entries from a replaced or restored engine wait for a decision. */
export function ReviewNotice() {
  const nav = useNav();
  const q = useQuery(reconcileBadgeQuery);
  const total = q.data?.total ?? 0;
  if (!total) return null;
  return (
    <p className="notice" role="status">
      <Icon name="info" />
      <span>{t.notice(plural(total, t.collectedItem, t.collectedItems), total)}<button type="button" className="link" onClick={() => nav.goPath("/review")}>{t.review}</button></span>
    </p>
  );
}
