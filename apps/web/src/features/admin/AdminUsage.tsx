import { useState } from "react";
import type { UsageReport } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { bytesLabel, plural, timeAgo } from "../../lib/format.ts";
import { Note } from "../shared/bits.tsx";
import { shortId } from "./admin-model.ts";

const t = app.admin.adminUsage;

/** Compare each account's usage ledger with what it really stores. The check only reports; it changes nothing. */
export function AdminUsagePanel() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setError("");
    try { setReport(await post<UsageReport>("/api/admin/usage/reconcile")); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <div className="fx-stack">
      <p>{t.intro}</p>
      <div className="fx-acts-row"><Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? app.words.checking : t.run}</Button></div>
      {error ? <Note>{error}</Note> : null}
      {report ? (
        <>
          <p className="state" role="status"><Icon name={report.mismatched ? "alert" : "check"} />
            {report.mismatched ? t.differs(plural(report.mismatched, app.words.accountLower), report.accounts.length, report.mismatched) : t.allMatch(plural(report.accounts.length, app.words.accountLower))}{t.checked(timeAgo(report.checkedAt) || app.words.justNow)}</p>
          <ul className="fx-rows">
            {report.accounts.map((a) => (
              <li key={a.accountId} className="fx-row">
                <div className="fx-grow"><b>{t.accountId(shortId(a.accountId))}</b><span className="fine">{t.ledger(bytesLabel(a.ledgerBytes), bytesLabel(a.objectBytes))}</span></div>
                <div className="fx-end"><span className={`tag fx-status ${a.differenceBytes ? "failed" : "ok"}`}>{a.differenceBytes ? `${a.differenceBytes > 0 ? "+" : "−"}${bytesLabel(Math.abs(a.differenceBytes))}` : t.matches}</span></div>
              </li>
            ))}
          </ul>
          {report.mismatched ? <p className="fine">{t.disagree}</p> : null}
        </>
      ) : null}
    </div>
  );
}
