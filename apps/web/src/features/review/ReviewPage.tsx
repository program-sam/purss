import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReconcileEntryDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { refreshPurss } from "../../api/queries.ts";
import { plural, shortDate } from "../../lib/format.ts";
import { safeHref } from "../../lib/items.ts";
import { useNav } from "../../nav.ts";
import { useToasts } from "../../state/toasts.tsx";
import { usePurss } from "../../state/purss.tsx";
import { fkeys, reconcileQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Page } from "../shared/bits.tsx";
import { MatchDialog } from "./MatchDialog.tsx";

const t = app.review.reviewPage;

type Action = "match" | "new" | "dismiss";
const SUGGESTION: Record<ReconcileEntryDTO["suggestion"], string> = t.suggestion;

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
      <Dialog title={t.acceptedTitle} size="sm" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{app.words.done}</Button>}>
        <p className="hint"><b>{plural(result.matched, app.words.entry, app.words.entries)}</b>{t.linked}{result.skipped ? t.leftToDecide(plural(result.skipped, app.words.entry, app.words.entries)) : ""}{result.remaining ? t.stillWaiting(result.remaining) : ""}</p>
      </Dialog>
    );
  }
  return (
    <Dialog title={t.acceptAllTitle} size="sm" onClose={onClose} initialFocus=".dlg-f .btn.primary"
      footer={<><Button onClick={onClose}>{app.words.cancel}</Button><Button variant="primary" disabled={busy} onClick={() => void go()}>{t.accept(plural(count, t.match, t.matches))}</Button></>}>
      <p className="hint">{t.acceptHint}</p>
      <p className="fine">{t.acceptFine}</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </Dialog>
  );
}

function Entry({ e, busy, onAct, onChoose }: { e: ReconcileEntryDTO; busy: boolean; onAct: (a: Action, itemId?: string) => void; onChoose: () => void }) {
  const ws = usePurss();
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
        <p className="fx-cand">{t.youHave}<button type="button" className="link" onClick={() => nav.openItem(c.itemId)}>{c.title}</button>{c.kept ? <span className="tag" style={{ marginLeft: 8 }}><Icon name="basket" />{app.words.kept}</span> : null}</p>
      ) : null}
      <div className="fx-acts-row">
        {c ? <Button variant={e.suggestion === "match" ? "primary" : "default"} disabled={busy} onClick={() => onAct("match", c.itemId)}>{t.matchButton}</Button> : <Button disabled={busy} onClick={onChoose}>{t.matchToItem}</Button>}
        <Button variant={!c && e.suggestion === "new" ? "primary" : "default"} disabled={busy} onClick={() => onAct("new")}>{t.addAsNew}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => onAct("dismiss")}>{app.words.dismiss}</Button>
        {c ? <button type="button" className="link" onClick={onChoose}>{t.chooseAnother}</button> : null}
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
    refreshPurss(qc);
  };

  async function act(e: ReconcileEntryDTO, action: Action, itemId?: string) {
    setBusy(e.id);
    try {
      await post(`/api/reconcile/${encodeURIComponent(e.id)}`, { action, ...(itemId ? { itemId } : {}) });
      refresh();
      toast(action === "match" ? t.linkedToast : action === "new" ? t.addedToast : app.words.dismissed);
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(null); }
  }

  return (
    <Page title={app.words.review} lead={t.lead}>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.listName} onRetry={() => void q.refetch()} /> : null}
      {d && !d.entries.length ? (
        <div className="empty card-like"><h2>{t.nothingTitle}</h2><p>{t.nothingText}</p></div>
      ) : null}
      {d?.entries.length ? (
        <>
          <div className="fx-bulk">
            <p>{t.waiting(plural(d.total, app.words.entry, app.words.entries), d.total > d.entries.length ? d.entries.length : null, plural(d.suggestedMatches, t.has, t.have))}</p>
            <Button variant="primary" disabled={!d.suggestedMatches} onClick={() => setAcceptAll(true)}>{t.acceptAll}</Button>
          </div>
          <ul className="fx-entries">{d.entries.map((e) => <Entry key={e.id} e={e} busy={busy === e.id} onAct={(a, id) => void act(e, a, id)} onChoose={() => setChoose(e)} />)}</ul>
        </>
      ) : null}
      {choose ? <MatchDialog entry={choose} onClose={() => setChoose(null)} onPick={(id) => { const e = choose; setChoose(null); void act(e, "match", id); }} /> : null}
      {acceptAll && d ? <AcceptAllDialog count={d.suggestedMatches} onClose={() => setAcceptAll(false)} onDone={refresh} /> : null}
    </Page>
  );
}
