import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminJob } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Segmented } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { adminJobsQuery } from "../shared/api.ts";
import type { JobFilter } from "../shared/api.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { shortId } from "./admin-model.ts";

const t = app.admin.adminJobs;

const STATUS_LABEL: Record<string, string> = t.status;

function Row({ job, busy, onAct }: { job: AdminJob; busy: boolean; onAct: (a: "retry" | "cancel") => void }) {
  const canRetry = job.status === "failed" || job.status === "cancelled";
  const canCancel = job.status === "queued" || job.status === "failed";
  return (
    <li className="fx-row wrap fx-job">
      <div className="fx-grow">
        <b><code>{job.kind}</code></b>
        <span className="fine">{t.summary(job.attempts, timeAgo(job.updatedAt) || app.words.justNow, job.account ? shortId(job.account) : null)}</span>
        {job.lastError ? <span className="fx-err">{job.lastError}</span> : null}
      </div>
      <div className="fx-end">
        <span className={`tag fx-status ${job.status}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
        {canRetry ? <Button disabled={busy} onClick={() => onAct("retry")} aria-label={`Retry ${job.kind}`}>{t.retry}</Button> : null}
        {canCancel ? <Button disabled={busy} onClick={() => onAct("cancel")} aria-label={`Cancel ${job.kind}`}>{app.words.cancel}</Button> : null}
      </div>
    </li>
  );
}

export function AdminJobsPanel() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [filter, setFilter] = useState<JobFilter>("failed");
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery(adminJobsQuery(filter));

  async function act(job: AdminJob, action: "retry" | "cancel") {
    setBusy(job.id);
    try {
      await post(`/api/admin/jobs/${encodeURIComponent(job.id)}/${action}`);
      void qc.invalidateQueries({ queryKey: ["feature", "admin"] });
      toast(action === "retry" ? t.queuedAgain : t.cancelled);
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(null); }
  }
  return (
    <div className="fx-stack">
      <Segmented<JobFilter> label="Show jobs" value={filter} onChange={setFilter} buttonStyle={{ height: 30, padding: "0 14px" }}
        options={[{ value: "failed", label: app.words.failed }, { value: "queued", label: app.words.waiting }, { value: "leased", label: app.words.running }, { value: "all", label: app.words.recent }]} />
      <p className="fine">{t.redacted}</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.jobsName} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? <p className="state">{filter === "failed" ? t.noFailed : t.nothingHere}</p> : null}
      {q.data?.length ? <ul className="fx-rows">{q.data.map((j) => <Row key={j.id} job={j} busy={busy === j.id} onAct={(a) => void act(j, a)} />)}</ul> : null}
    </div>
  );
}
