import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReconcileEntryDTO } from "@purss/domain";
import { Button, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { plural, shortDate } from "../../lib/format.ts";
import { safeHref } from "../../lib/items.ts";
import { useNav } from "../../nav.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { fkeys, reconcileQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Page } from "../shared/bits.tsx";
import { MatchDialog } from "./MatchDialog.tsx";

type Action = "match" | "new" | "dismiss";
const SUGGESTION: Record<ReconcileEntryDTO["suggestion"], string> = {
  match: "Looks like an item you have",
  new: "Looks new",
  review: "Needs your decision",
};

function AcceptAllDialog({ count, onClose, onDone }: { count: number; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ matched: number; skipped: number; remaining: number } | null>(null);
  async function go() {
    setBusy(true); setError("");
    try { setResult(await post<{ matched: number; skipped: number; remaining: number }>("/api/reconcile/accept-suggested", {})); onDone(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  if (result) {
    return (
      <Dialog title="Matches accepted" size="sm" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="hint"><b>{plural(result.matched, "entry", "entries")}</b> linked to the items you already have.{result.skipped ? ` ${plural(result.skipped, "entry", "entries")} left for you to decide.` : ""}{result.remaining ? ` ${result.remaining} still waiting.` : ""}</p>
      </Dialog>
    );
  }
  return (
    <Dialog title="Accept all clear matches?" size="sm" onClose={onClose} initialFocus=".dlg-f .btn.primary"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void go()}>Accept {plural(count, "match", "matches")}</Button></>}>
      <p className="hint">Each entry with one clear match is linked to the item you already have, so it doesn't show up twice. Nothing new is added, and nothing is deleted or merged.</p>
      <p className="fine">Entries that look new, or that could be several items, stay here for you to decide.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

function Entry({ e, busy, onAct, onChoose }: { e: ReconcileEntryDTO; busy: boolean; onAct: (a: Action, itemId?: string) => void; onChoose: () => void }) {
  const ws = useWorkspace();
  const nav = useNav();
  const tz = ws.prefs.timezone;
  const href = safeHref(e.entry.url);
  const c = e.candidate;
  return (
    <li className={`fx-entry ${e.suggestion}`}>
      <div className="fx-entry-h">
        <span className="tag">{SUGGESTION[e.suggestion]}</span>
        <span className="fine">{[e.sourceTitle, e.entry.publishedAt ? shortDate(e.entry.publishedAt, Date.now(), tz) : null, e.entry.author].filter(Boolean).join(" · ")}</span>
      </div>
      <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{e.entry.title}</a> : e.entry.title}</h3>
      {e.entry.summary ? <p className="fine">{e.entry.summary}</p> : null}
      <p className="fx-why"><Icon name="info" size="sm" /><span>{e.reason}</span></p>
      {c ? (
        <p className="fx-cand">You already have: <button type="button" className="link" onClick={() => nav.openItem(c.itemId)}>{c.title}</button>{c.kept ? <span className="tag" style={{ marginLeft: 8 }}><Icon name="basket" />Kept</span> : null}</p>
      ) : null}
      <div className="fx-acts-row">
        {c ? <Button variant={e.suggestion === "match" ? "primary" : "default"} disabled={busy} onClick={() => onAct("match", c.itemId)}>Match</Button> : <Button disabled={busy} onClick={onChoose}>Match to an item…</Button>}
        <Button variant={!c && e.suggestion === "new" ? "primary" : "default"} disabled={busy} onClick={() => onAct("new")}>Add as new</Button>
        <Button variant="ghost" disabled={busy} onClick={() => onAct("dismiss")}>Dismiss</Button>
        {c ? <button type="button" className="link" onClick={onChoose}>Choose another item…</button> : null}
      </div>
    </li>
  );
}

export function ReviewPage() {
  const q = useQuery(reconcileQuery);
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [busy, setBusy] = useState<string | null>(null);
  const [choose, setChoose] = useState<ReconcileEntryDTO | null>(null);
  const [acceptAll, setAcceptAll] = useState(false);
  const d = q.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: fkeys.reconcile });
    void qc.invalidateQueries({ queryKey: fkeys.reconcileBadge });
    refreshWorkspace(qc);
  };

  async function act(e: ReconcileEntryDTO, action: Action, itemId?: string) {
    setBusy(e.id);
    try {
      await post(`/api/reconcile/${encodeURIComponent(e.id)}`, { action, ...(itemId ? { itemId } : {}) });
      refresh();
      toast(action === "match" ? "Linked to your existing item" : action === "new" ? "Added as a new item" : "Dismissed");
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(null); }
  }

  return (
    <Page title="Review" lead="Some entries couldn't be matched to items you already have, usually after a restore. Nothing is added, merged or deleted until you decide.">
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="the review list" onRetry={() => void q.refetch()} /> : null}
      {d && !d.entries.length ? (
        <div className="empty card-like"><h2>Nothing to review</h2><p>Entries that can't be matched on their own appear here.</p></div>
      ) : null}
      {d?.entries.length ? (
        <>
          <div className="fx-bulk">
            <p>{plural(d.total, "entry", "entries")} waiting{d.total > d.entries.length ? `, showing the first ${d.entries.length}` : ""}. {plural(d.suggestedMatches, "has", "have")} one clear match.</p>
            <Button variant="primary" disabled={!d.suggestedMatches} onClick={() => setAcceptAll(true)}>Accept all clear matches</Button>
          </div>
          <ul className="fx-entries">{d.entries.map((e) => <Entry key={e.id} e={e} busy={busy === e.id} onAct={(a, id) => void act(e, a, id)} onChoose={() => setChoose(e)} />)}</ul>
        </>
      ) : null}
      {choose ? <MatchDialog entry={choose} onClose={() => setChoose(null)} onPick={(id) => { const e = choose; setChoose(null); void act(e, "match", id); }} /> : null}
      {acceptAll && d ? <AcceptAllDialog count={d.suggestedMatches} onClose={() => setAcceptAll(false)} onDone={refresh} /> : null}
    </Page>
  );
}
