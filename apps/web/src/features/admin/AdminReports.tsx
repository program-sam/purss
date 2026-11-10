import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { REPORT_REASON_LABELS } from "@purss/domain";
import type { ShareReportDTO } from "@purss/domain";
import { Button, Dialog, Field, Icon, Segmented } from "@purss/ui";
import { get, messageOf, post } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { adminReportsQuery } from "../shared/api.ts";
import type { ReportFilter } from "../shared/api.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { neutraliseLinks } from "../sharing/preview-html.ts";

type Pub = ShareReportDTO["share"];

/** The reported page as visitors saw it, in a sandboxed frame; take it down with a reason its owner will see, or restore it. */
function PageDialog({ pub, onClose }: { pub: Pub; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const q = useQuery({ queryKey: ["feature", "admin", "reported-page", pub.id], queryFn: () => get<{ html: string }>(`/api/admin/shares/${encodeURIComponent(pub.id)}/page`), gcTime: 0, staleTime: 0 });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "takedown" | "restore") {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<{ ok: true }>(`/api/admin/shares/${encodeURIComponent(pub.id)}/${action}`, action === "takedown" ? { reason: reason.trim() } : {}));
      if (out) {
        void qc.invalidateQueries({ queryKey: ["feature", "admin", "reports"] });
        toast(action === "takedown" ? `Took down ${pub.title}` : `Restored ${pub.title}`);
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  const canTakeDown = !pub.takenDown && reason.trim().length >= 5;
  return (
    <>
      <Dialog title={`Reported page: ${pub.title}`} size="lg" onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            {pub.takenDown
              ? <Button variant="primary" disabled={busy} onClick={() => void act("restore")}>Restore</Button>
              : <Button variant="danger" disabled={busy || !canTakeDown} onClick={() => void act("takedown")}>Take down</Button>}
          </>
        }>
        <p className="hint">Collected by <b dir="auto">{pub.curatorName}</b>. This is the page as visitors {pub.takenDown || pub.status !== "published" ? "saw it" : "see it now"}; links are switched off.</p>
        {q.isPending ? <Loading /> : null}
        {q.isError ? <LoadFailed error={q.error} what="the page" onRetry={() => void q.refetch()} /> : null}
        {q.data ? <iframe className="fx-frame" title={`The reported page ${pub.title}`} sandbox="" srcDoc={neutraliseLinks(q.data.html)} /> : null}
        {pub.takenDown
          ? <p className="fine">Taken down {timeAgo(pub.takenDown.at) || "just now"}: <span dir="auto">{pub.takenDown.reason}</span> Restoring lets its owner publish it again; it stays paused until they do.</p>
          : (
            <Field label="Reason the owner will see" htmlFor="td-reason" hint="Taking it down stops the page and feed at once and closes its open reports. The owner keeps the collection but can't publish it until you restore it.">
              <textarea id="td-reason" className="in fx-textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

function Row({ report, busy, onDismiss, onOpen }: { report: ShareReportDTO; busy: boolean; onDismiss: () => void; onOpen: () => void }) {
  const pub = report.share;
  const outcome = report.resolution === "taken_down" ? "Taken down" : report.resolution === "dismissed" ? "Dismissed" : "Open";
  return (
    <li className="fx-row wrap">
      <div className="fx-grow">
        <b dir="auto">{pub.title}</b>
        <span className="fine">{REPORT_REASON_LABELS[report.reason]} · reported {timeAgo(report.createdAt) || "just now"}{pub.openReports > 1 ? ` · ${pub.openReports} open reports about this page` : ""}</span>
        <span className="fx-pub-note" dir="auto">{report.details}</span>
        {report.contact ? <span className="fine">Reporter: <span dir="auto">{report.contact}</span></span> : null}
      </div>
      <div className="fx-end">
        <span className={`tag fx-status ${report.resolution ? "draft" : "failed"}`}>{outcome}</span>
        <Button onClick={onOpen}>View page…</Button>
        {!report.resolution ? <Button disabled={busy} onClick={onDismiss} aria-label={`Dismiss the report about ${pub.title}`}>Dismiss</Button> : null}
      </div>
    </li>
  );
}

/** Reports visitors sent about shared pages. Only the reported public page is shown, never anything private. */
export function AdminReportsPanel() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [filter, setFilter] = useState<ReportFilter>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Pub | null>(null);
  const q = useQuery(adminReportsQuery(filter));

  async function dismiss(r: ShareReportDTO) {
    setBusy(r.id);
    try {
      await post(`/api/admin/reports/${encodeURIComponent(r.id)}/dismiss`);
      void qc.invalidateQueries({ queryKey: ["feature", "admin", "reports"] });
      toast("Report dismissed");
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(null); }
  }
  return (
    <div className="fx-stack">
      <Segmented<ReportFilter> label="Show reports" value={filter} onChange={setFilter} buttonStyle={{ height: 30, padding: "0 14px" }}
        options={[{ value: "open", label: "Open" }, { value: "taken_down", label: "Taken down" }, { value: "all", label: "Recent" }]} />
      <p className="fine">Visitors can report any public shared page. Reporters' contact details are only what they chose to type; their addresses aren't kept.</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="reports" onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? <p className="state">{filter === "open" ? "No open reports." : filter === "taken_down" ? "No page is taken down." : "No reports yet."}</p> : null}
      {q.data?.length ? <ul className="fx-rows">{q.data.map((r) => <Row key={r.id} report={r} busy={busy === r.id} onDismiss={() => void dismiss(r)} onOpen={() => setOpen(r.share)} />)}</ul> : null}
      {open ? <PageDialog pub={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
