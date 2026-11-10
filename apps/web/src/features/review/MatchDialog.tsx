import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReconcileEntryDTO } from "@purss/domain";
import { Button, Dialog, Icon, TextInput } from "@purss/ui";
import { messageOf } from "../../api/client.ts";
import { searchQuery } from "../../api/queries.ts";
import { shortDate } from "../../lib/format.ts";
import { useWorkspace } from "../../state/workspace.tsx";

/** Pick which existing item an incoming entry is. Searches your own library. */
export function MatchDialog({ entry, onPick, onClose }: { entry: ReconcileEntryDTO; onPick: (itemId: string) => void; onClose: () => void }) {
  const ws = useWorkspace();
  const [text, setText] = useState(entry.entry.title);
  const [term, setTerm] = useState(entry.entry.title);
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ ...searchQuery(term), enabled: term.length > 0 });
  const items = q.data?.items ?? [];
  return (
    <Dialog title="Match to an item" size="md" onClose={onClose} initialFocus="#mt-q" footer={<Button onClick={onClose}>Cancel</Button>}>
      <p className="hint">Find the item in your PURSS that <b>{entry.entry.title}</b> is. The entry is linked to it; nothing new is added.</p>
      <div className="field"><label htmlFor="mt-q">Search your items</label><TextInput id="mt-q" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" /></div>
      <div aria-live="polite" style={{ display: "grid", gap: 8 }}>
        {q.isFetching ? <p className="state"><span className="spin" aria-hidden="true" />Searching…</p> : null}
        {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
        {term && q.data && !items.length ? <p className="fine">No items match that. Try fewer words.</p> : null}
        {items.length ? (
          <ul className="fx-rows fx-scroll">
            {items.map((it) => (
              <li key={it.id} className="fx-row">
                <div className="fx-grow"><b dir="auto">{it.title}</b><span className="fine" dir="auto">{[it.sourceTitle, it.publishedAt ? shortDate(it.publishedAt, Date.now(), ws.prefs.timezone) : null].filter(Boolean).join(" · ")}</span></div>
                <div className="fx-end"><Button onClick={() => onPick(it.id)} aria-label={`Use ${it.title}`}>Use this one</Button></div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
