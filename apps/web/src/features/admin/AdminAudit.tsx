import { useInfiniteQuery } from "@tanstack/react-query";
import type { AuditEventDTO } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Icon } from "@purss/ui";
import { get } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { shortId } from "./admin-model.ts";

const t = app.admin.adminAudit;

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
      <p className="fine">{t.newestFirst}</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.logName} onRetry={() => void q.refetch()} /> : null}
      {q.data && !events.length ? <p className="state">{t.empty}</p> : null}
      {events.length ? (
        <ul className="fx-rows">
          {events.map((e) => (
            <li key={e.id} className="fx-row">
              <div className="fx-grow">
                <b>{e.action.replace(/_/g, " ")}</b>
                <span className="fine">{shortId(e.actor)}{e.target ? ` → ${shortId(e.target)}` : ""} · <time dateTime={e.at} title={e.at}>{timeAgo(e.at) || app.words.justNow}</time></span>
                {e.detail ? <span className="fine">{e.detail}</span> : null}
              </div>
              <div className="fx-end"><span className={`tag fx-status ${e.outcome === "success" ? "ok" : "failed"}`}><Icon name={e.outcome === "success" ? "check" : "alert"} />{e.outcome === "success" ? t.succeeded : app.words.failed}</span></div>
            </li>
          ))}
        </ul>
      ) : null}
      {q.hasNextPage ? <div><Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? app.words.loading : t.showOlder}</Button></div> : null}
    </div>
  );
}
