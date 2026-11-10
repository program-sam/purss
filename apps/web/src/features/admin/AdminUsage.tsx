import { useState } from "react";
import type { UsageReport } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { bytesLabel, plural, timeAgo } from "../../lib/format.ts";
import { Note } from "../shared/bits.tsx";
import { shortId } from "./admin-model.ts";

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
      <p>Compares each account's recorded usage with what it actually stores. It only reports differences and changes nothing.</p>
      <div className="fx-acts-row"><Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? "Checking…" : "Run usage check"}</Button></div>
      {error ? <Note>{error}</Note> : null}
      {report ? (
        <>
          <p className="state" role="status"><Icon name={report.mismatched ? "alert" : "check"} />
            {report.mismatched ? `${plural(report.mismatched, "account")} of ${report.accounts.length} ${report.mismatched === 1 ? "differs" : "differ"}.` : `All ${plural(report.accounts.length, "account")} match.`} Checked {timeAgo(report.checkedAt) || "just now"}.</p>
          <ul className="fx-rows">
            {report.accounts.map((a) => (
              <li key={a.accountId} className="fx-row">
                <div className="fx-grow"><b>Account {shortId(a.accountId)}</b><span className="fine">Ledger {bytesLabel(a.ledgerBytes)} · stored {bytesLabel(a.objectBytes)}</span></div>
                <div className="fx-end"><span className={`tag fx-status ${a.differenceBytes ? "failed" : "ok"}`}>{a.differenceBytes ? `${a.differenceBytes > 0 ? "+" : "−"}${bytesLabel(Math.abs(a.differenceBytes))}` : "Matches"}</span></div>
              </li>
            ))}
          </ul>
          {report.mismatched ? <p className="fine">A difference means recorded usage and stored items disagree. Nothing was changed.</p> : null}
        </>
      ) : null}
    </div>
  );
}
