import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { REPORT_REASON_LABELS } from "@purss/domain";
import type { ShareReportDTO } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Dialog, Field, Icon, Segmented } from "@purss/ui";
import { get, messageOf, post } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { adminReportsQuery } from "../shared/api.ts";
import type { ReportFilter } from "../shared/api.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { neutraliseLinks } from "../sharing/preview-html.ts";

const t = app.admin.adminReports;

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
        toast(action === "takedown" ? t.tookDown(pub.title) : t.restored(pub.title));
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  const canTakeDown = !pub.takenDown && reason.trim().length >= 5;
  return (
    <>
      <Dialog title={t.dialogTitle(pub.title)} size="lg" onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>{t.close}</Button>
            {pub.takenDown
              ? <Button variant="primary" disabled={busy} onClick={() => void act("restore")}>{t.restore}</Button>
              : <Button variant="danger" disabled={busy || !canTakeDown} onClick={() => void act("takedown")}>{t.takeDown}</Button>}
          </>
        }>
        <p className="hint">{t.collectedBy}<b dir="auto">{pub.curatorName}</b>{t.pageAsVisitors(pub.takenDown || pub.status !== "published" ? t.sawIt : t.seeItNow)}</p>
        {q.isPending ? <Loading /> : null}
        {q.isError ? <LoadFailed error={q.error} what={t.pageName} onRetry={() => void q.refetch()} /> : null}
        {q.data ? <iframe className="fx-frame" title={t.frameTitle(pub.title)} sandbox="" srcDoc={neutraliseLinks(q.data.html)} /> : null}
        {pub.takenDown
          ? <p className="fine">{t.takenDownAt(timeAgo(pub.takenDown.at) || t.justNow)}<span dir="auto">{pub.takenDown.reason}</span>{t.restoringNote}</p>
          : (
            <Field label={t.reasonLabel} htmlFor="td-reason" hint={t.reasonHint}>
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
  const outcome = report.resolution === "taken_down" ? t.outcome.takenDown : report.resolution === "dismissed" ? t.outcome.dismissed : t.outcome.open;
  return (
    <li className="fx-row wrap">
      <div className="fx-grow">
        <b dir="auto">{pub.title}</b>
        <span className="fine">{t.summary(REPORT_REASON_LABELS[report.reason], timeAgo(report.createdAt) || t.justNow, pub.openReports)}</span>
        <span className="fx-pub-note" dir="auto">{report.details}</span>
        {report.contact ? <span className="fine">{t.reporter}<span dir="auto">{report.contact}</span></span> : null}
      </div>
      <div className="fx-end">
        <span className={`tag fx-status ${report.resolution ? "draft" : "failed"}`}>{outcome}</span>
        <Button onClick={onOpen}>{t.viewPage}</Button>
        {!report.resolution ? <Button disabled={busy} onClick={onDismiss} aria-label={`Dismiss the report about ${pub.title}`}>{t.dismiss}</Button> : null}
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
      toast(t.dismissed);
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(null); }
  }
  return (
    <div className="fx-stack">
      <Segmented<ReportFilter> label="Show reports" value={filter} onChange={setFilter} buttonStyle={{ height: 30, padding: "0 14px" }}
        options={[{ value: "open", label: t.filters.open }, { value: "taken_down", label: t.filters.takenDown }, { value: "all", label: t.filters.all }]} />
      <p className="fine">{t.intro}</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.reportsName} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? <p className="state">{filter === "open" ? t.noOpen : filter === "taken_down" ? t.noTakenDown : t.none}</p> : null}
      {q.data?.length ? <ul className="fx-rows">{q.data.map((r) => <Row key={r.id} report={r} busy={busy === r.id} onDismiss={() => void dismiss(r)} onOpen={() => setOpen(r.share)} />)}</ul> : null}
      {open ? <PageDialog pub={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
