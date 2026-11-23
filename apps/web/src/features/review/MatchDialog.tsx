import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReconcileEntryDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Dialog, Icon, TextInput } from "@purss/ui";
import { messageOf } from "../../api/client.ts";
import { searchQuery } from "../../api/queries.ts";
import { shortDate } from "../../lib/format.ts";
import { usePurss } from "../../state/purss.tsx";

const copy = app.review.matchDialog;

/** Pick which existing item an incoming entry is. Searches your own library. */
export function MatchDialog({ entry, onPick, onClose }: { entry: ReconcileEntryDTO; onPick: (itemId: string) => void; onClose: () => void }) {
  const ws = usePurss();
  const [text, setText] = useState(entry.entry.title);
  const [term, setTerm] = useState(entry.entry.title);
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ ...searchQuery(term), enabled: term.length > 0 });
  const items = q.data?.items ?? [];
  return (
    <Dialog title={copy.title} size="md" onClose={onClose} initialFocus="#mt-q" footer={<Button onClick={onClose}>{app.words.cancel}</Button>}>
      <p className="hint">{copy.findBefore}<b>{entry.entry.title}</b>{copy.findAfter}</p>
      <div className="field"><label htmlFor="mt-q">{copy.searchLabel}</label><TextInput id="mt-q" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" /></div>
      <div aria-live="polite" style={{ display: "grid", gap: 8 }}>
        {q.isFetching ? <p className="state"><span className="spin" aria-hidden="true" />{app.words.searching}</p> : null}
        {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
        {term && q.data && !items.length ? <p className="fine">{copy.noMatch}</p> : null}
        {items.length ? (
          <ul className="fx-rows fx-scroll">
            {items.map((it) => (
              <li key={it.id} className="fx-row">
                <div className="fx-grow"><b dir="auto">{it.title}</b><span className="fine" dir="auto">{[it.sourceTitle, it.publishedAt ? shortDate(it.publishedAt, Date.now(), ws.prefs.timezone) : null].filter(Boolean).join(" · ")}</span></div>
                <div className="fx-end"><Button onClick={() => onPick(it.id)} aria-label={`Use ${it.title}`}>{copy.useThis}</Button></div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
