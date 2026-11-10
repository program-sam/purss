import { useInfiniteQuery } from "@tanstack/react-query";
import type { AuditEventDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { get } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { shortId } from "./admin-model.ts";

type Page = { events: AuditEventDTO[]; nextBefore: string | null };

/** The audit log reads who did what and when; it never carries item content. */
export function AdminAuditPanel() {
  const q = useInfiniteQuery({
    queryKey: ["feature", "admin", "audit-pages"],
    queryFn: ({ pageParam }) => get<Page>("/api/admin/audit", { limit: 50, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 5_000,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <div className="fx-stack">
      <p className="fine">Newest first. Details are redacted.</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="the audit log" onRetry={() => void q.refetch()} /> : null}
      {q.data && !events.length ? <p className="state">Nothing has been recorded yet.</p> : null}
      {events.length ? (
        <ul className="fx-rows">
          {events.map((e) => (
            <li key={e.id} className="fx-row">
              <div className="fx-grow">
                <b>{e.action.replace(/_/g, " ")}</b>
                <span className="fine">{shortId(e.actor)}{e.target ? ` → ${shortId(e.target)}` : ""} · <time dateTime={e.at} title={e.at}>{timeAgo(e.at) || "just now"}</time></span>
                {e.detail ? <span className="fine">{e.detail}</span> : null}
              </div>
              <div className="fx-end"><span className={`tag fx-status ${e.outcome === "success" ? "ok" : "failed"}`}><Icon name={e.outcome === "success" ? "check" : "alert"} />{e.outcome === "success" ? "Succeeded" : "Failed"}</span></div>
            </li>
          ))}
        </ul>
      ) : null}
      {q.hasNextPage ? <div><Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Show older"}</Button></div> : null}
    </div>
  );
}
