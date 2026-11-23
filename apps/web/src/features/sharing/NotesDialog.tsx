import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShareDTO, ShareItemDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Dialog, Icon } from "@purss/ui";
import { get, messageOf, put } from "../../api/client.ts";
import { shortDate } from "../../lib/format.ts";
import { useWorkspace } from "../../state/workspace.tsx";
import { fkeys } from "../shared/api.ts";

const t = app.sharing.notesDialog;

/** What a public note exposes, said where it is written. */
function noteWarning(share: ShareDTO): string {
  return share.status === "published" && !share.takenDown
    ? t.warningPublic(share.curatorName)
    : t.warningNotYet(share.curatorName);
}

function NoteEditor({ share, item, onDone, onNotice }: { share: ShareDTO; item: ShareItemDTO; onDone: () => void; onNotice: (n: string) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(item.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try {
      const out = await put<{ notice: string | null }>(`/api/shares/${encodeURIComponent(share.id)}/items/${encodeURIComponent(item.itemId)}/note`, { note: text.trim() || null });
      if (out.notice) onNotice(out.notice);
      await qc.invalidateQueries({ queryKey: fkeys.shares });
      onDone();
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  const id = `note-${item.itemId}`;
  return (
    <div className="fx-note-edit">
      <label className="lbl" htmlFor={id}>{t.publicNote}</label>
      <p className="p-warn" role="note"><Icon name="alert" /><span>{noteWarning(share)}{t.privateStay}</span></p>
      <textarea id={id} className="in fx-textarea" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} autoFocus dir="auto" placeholder={t.placeholder} />
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="fx-acts-row"><Button variant="primary" disabled={busy} onClick={() => void save()}>{t.save}</Button><Button onClick={onDone}>{app.words.cancel}</Button></div>
    </div>
  );
}

/** The items a shared page shows now, each with an optional public note. */
export function NotesDialog({ share, onClose }: { share: ShareDTO; onClose: () => void }) {
  const ws = useWorkspace();
  const q = useQuery({ queryKey: [...fkeys.shares, "items", share.id], queryFn: () => get<ShareItemDTO[]>(`/api/shares/${encodeURIComponent(share.id)}/items`), staleTime: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const items = q.data ?? [];
  return (
    <Dialog title={t.title(share.title)} size="lg" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{app.words.done}</Button>}>
      <p className="hint">{t.addNote}{noteWarning(share)}</p>
      {notice ? <p className="state note" role="status"><Icon name="info" /><span>{notice}</span></p> : null}
      {q.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{app.words.loading}</p> : null}
      {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
      {q.data && !items.length ? <p className="state">{t.nothing}</p> : null}
      {items.length ? (
        <ul className="fx-rows fx-scroll">
          {items.map((it) => (
            <li key={it.itemId} className="fx-row wrap">
              <div className="fx-grow">
                <b dir="auto">{it.title}</b>
                <span className="fine" dir="auto">{[it.ownLink ? t.savedByYou : it.sourceTitle, it.publishedAt ? shortDate(it.publishedAt, Date.now(), ws.prefs.timezone) : null].filter(Boolean).join(" · ")}</span>
                {it.note && editing !== it.itemId ? <span className="fx-pub-note" dir="auto">{it.note}</span> : null}
              </div>
              <div className="fx-end">
                {editing !== it.itemId ? <Button aria-label={`${it.note ? "Edit the public note on" : "Add a public note to"} ${it.title}`} onClick={() => setEditing(it.itemId)}>{it.note ? t.editNote : t.addNoteButton}</Button> : null}
              </div>
              {editing === it.itemId ? <NoteEditor share={share} item={it} onDone={() => { setEditing(null); void q.refetch(); }} onNotice={setNotice} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
