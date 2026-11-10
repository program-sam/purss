import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, TextInput } from "@purss/ui";
import { messageOf, patch } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";

/** Change the title of a link kept by hand, in place of the heading. The title is the person's own record of the link. */
export function RenameTitle({ itemId, title, onDone }: { itemId: string; title: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) { setError("A title can't be empty."); return; }
    if (draft.trim() === title) { onDone(); return; }
    setBusy(true); setError("");
    try {
      await patch(`/api/items/${encodeURIComponent(itemId)}/title`, { title: draft.trim() });
      refreshWorkspace(qc);
      onDone();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  const keys = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };

  return (
    <form onSubmit={(e) => void save(e)} onKeyDown={keys} style={{ display: "grid", gap: 8 }}>
      <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={300} aria-label="Title" autoFocus dir="auto" autoComplete="off" />
      {error ? <p className="fine" role="alert">{error}</p> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save title"}</Button>
        <Button type="button" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
