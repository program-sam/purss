import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import { REMINDER_NOTE_MAX } from "@purss/domain";
import { Button, Icon, TextInput } from "@purss/ui";
import { del, messageOf, put } from "../api/client.ts";
import { itemReminderQuery, reminderKeys } from "../api/reminder-queries.ts";
import { addDays, dayIn, dayLabel } from "../lib/reminder-days.ts";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import "./reminders.css";

const t = app.components.itemReminder;

/**
 * "Remind me" on a kept item: a day, and a note if wanted. On that day the bell says so (and email, when it
 * is set up and chosen), and Home's "Coming up" lists it beforehand. Shown only for items that are kept.
 */
export function ItemReminder({ itemId }: { itemId: string }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const q = useQuery(itemReminderQuery(itemId));
  const [editing, setEditing] = useState(false);
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tz = ws.prefs.timezone;
  const today = dayIn(tz);
  const current = q.data ?? null;
  useEffect(() => { setEditing(false); setError(""); }, [itemId]);

  function begin() {
    setDay(current?.remindOn ?? addDays(today, 7));
    setNote(current?.note ?? "");
    setError("");
    setEditing(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !day) return;
    setBusy(true); setError("");
    try {
      const out = await put<{ reminder: NonNullable<typeof current> }>(`/api/items/${encodeURIComponent(itemId)}/reminder`, { remindOn: day, note: note.trim() || null });
      qc.setQueryData(reminderKeys.item(itemId), out.reminder);
      void qc.invalidateQueries({ queryKey: reminderKeys.comingUp });
      setEditing(false);
      toast(t.willRemind(dayLabel(day, today).toLowerCase()));
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await del(`/api/items/${encodeURIComponent(itemId)}/reminder`);
      qc.setQueryData(reminderKeys.item(itemId), null);
      void qc.invalidateQueries({ queryKey: reminderKeys.comingUp });
      setEditing(false);
      toast(t.removed);
    } catch (err) { toast(messageOf(err), { tone: "error" }); } finally { setBusy(false); }
  }

  if (q.isPending) return null;
  const n = ws.prefs.notifications;
  const quiet = !n.include.reminders;
  if (!editing) {
    return current ? (
      <p className="p-remind" role="group" aria-label="Reminder">
        <Icon name="cal" size="sm" />
        <span>{t.reminder}<b>{dayLabel(current.remindOn, today).toLowerCase()}</b>{current.note ? <> · <bdi dir="auto">{current.note}</bdi></> : null}</span>
        <button type="button" className="link" onClick={begin}>{t.change}</button>
        <button type="button" className="link" disabled={busy} onClick={() => void remove()}>{app.words.remove}</button>
      </p>
    ) : (
      <div className="p-remind"><button type="button" className="mbtn" onClick={begin}><Icon name="cal" />{t.remindMe}</button></div>
    );
  }
  return (
    <form className="p-remind form" onSubmit={save} aria-label="Remind me">
      <div className="rm-row">
        <label className="rm-f">{t.remindMeOn}
          <input className="in" type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} required />
        </label>
        <span className="rm-q" role="group" aria-label="Quick choices">
          <button type="button" className="link" onClick={() => setDay(addDays(today, 1))}>{app.words.tomorrow}</button>
          <button type="button" className="link" onClick={() => setDay(addDays(today, 7))}>{t.inAWeek}</button>
          <button type="button" className="link" onClick={() => setDay(addDays(today, 30))}>{t.inAMonth}</button>
        </span>
      </div>
      <label className="rm-f">{app.words.noteOptional}
        <TextInput value={note} maxLength={REMINDER_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={t.notePlaceholder} dir="auto" />
      </label>
      {quiet ? <p className="fine">{t.quiet}</p> : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="rm-acts">
        <Button variant="primary" type="submit" disabled={busy || !day}>{busy ? app.words.saving : t.save}</Button>
        <Button onClick={() => setEditing(false)}>{app.words.cancel}</Button>
      </div>
    </form>
  );
}
