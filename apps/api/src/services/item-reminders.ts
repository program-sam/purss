import { COMING_UP_DAYS, appUrl, newId } from "@purss/domain";
import type { ComingUp, ItemKind, ItemReminderDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { badRequest, notFound, nowIso } from "../http.ts";
import { sendLater } from "../mail/mailer.ts";
import { reminderMail } from "../mail/templates.ts";
import { getPreferences } from "./preferences.ts";
import { addDays, localDate, validTimezone, ymdString } from "./reminders.ts";

/*
 * "Remind me" on a kept item (plan/34): one day, and an optional note, per item. The day is the person's
 * own calendar day in their time zone. On that day the bell says so (and an email, when the person
 * allowed reminders by email and the account has a confirmed address), and Home's "Coming up" lists the
 * next seven days. A reminder belongs to the keeping of the item: while it is in no basket the reminder
 * is not shown and not announced, and it comes back with the keep. Not to be confused with the
 * anniversary notes ("On this day", reminders.ts), which the person never sets.
 *
 * Titles and notes stay out of notifications and email unless the person turned on titles in
 * notifications and the item isn't from a private source, like every other notification.
 */

/** A day this far back, or older, was missed (the server was off); it is marked handled without telling anyone. */
const STALE_DAYS = 3;
/** The furthest ahead a reminder can be set. */
const MAX_YEARS_AHEAD = 5;

type Row = { id: string; item_id: string; remind_on: string; note: string | null; title: string; kind: ItemKind; source_title: string | null; is_private: number | null };

const SELECT = `SELECT r.id, r.item_id, r.remind_on, r.note, i.title, i.kind, s.title AS source_title, s.is_private
  FROM item_reminders r JOIN items i ON i.id = r.item_id LEFT JOIN sources s ON s.id = i.source_id`;
const KEPT = "EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = r.item_id)";

const dto = (r: Row): ItemReminderDTO => ({ id: r.id, itemId: r.item_id, remindOn: r.remind_on, note: r.note, title: r.title, sourceTitle: r.source_title ?? "Saved link", kind: r.kind });

/** The person's calendar day for an instant, "YYYY-MM-DD", in the time zone they chose. */
export function todayFor(app: App, workspaceId: string, now: Date): string {
  return ymdString(localDate(now, validTimezone(getPreferences(app, workspaceId).timezone)));
}

/** A real calendar day written "YYYY-MM-DD" (not "2026-02-30"). */
function isCalendarDay(v: string): boolean {
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function ownItem(app: App, p: Principal, itemId: string): void {
  if (!app.db.get("SELECT 1 FROM items WHERE id = ? AND workspace_id = ?", itemId, p.workspaceId)) throw notFound("That item");
}

export function getItemReminder(app: App, p: Principal, itemId: string): ItemReminderDTO | null {
  ownItem(app, p, itemId);
  const row = app.db.get<Row>(`${SELECT} WHERE r.workspace_id = ? AND r.item_id = ?`, p.workspaceId, itemId);
  return row ? dto(row) : null;
}

/** Set or change the reminder on a kept item. A new day is announced again; the same day with a new note is not. */
export function setItemReminder(app: App, p: Principal, itemId: string, input: { remindOn: string; note: string | null }, now: Date = new Date()): ItemReminderDTO {
  ownItem(app, p, itemId);
  if (!app.db.get("SELECT 1 FROM basket_items WHERE item_id = ? AND workspace_id = ?", itemId, p.workspaceId)) {
    throw badRequest("Keep this item in a basket first. A reminder is for something you kept.", "not_kept");
  }
  if (!isCalendarDay(input.remindOn)) throw badRequest("That isn't a date.", "bad_date");
  const today = todayFor(app, p.workspaceId, now);
  if (input.remindOn < today) throw badRequest("Pick today or a day to come.", "past_date");
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (input.remindOn > ymdString({ y: y + MAX_YEARS_AHEAD, m, d })) throw badRequest(`Pick a day within ${MAX_YEARS_AHEAD} years.`, "far_date");
  const note = input.note?.trim() ? input.note.trim() : null;
  app.db.run(
    `INSERT INTO item_reminders (id, account_id, workspace_id, item_id, remind_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, item_id) DO UPDATE SET
       notified_at = CASE WHEN remind_on = excluded.remind_on THEN notified_at ELSE NULL END,
       remind_on = excluded.remind_on, note = excluded.note`,
    newId("irm"), p.accountId, p.workspaceId, itemId, input.remindOn, note, nowIso());
  return getItemReminder(app, p, itemId)!;
}

export function removeItemReminder(app: App, p: Principal, itemId: string): { ok: true } {
  ownItem(app, p, itemId);
  app.db.run("DELETE FROM item_reminders WHERE workspace_id = ? AND item_id = ?", p.workspaceId, itemId);
  return { ok: true };
}

/** Reminders for today and the days to come (`days` in all), soonest first; those of items that are no longer kept are left out. */
export function comingUp(app: App, p: Principal, now: Date = new Date(), days: number = COMING_UP_DAYS): ComingUp {
  const first = localDate(now, validTimezone(getPreferences(app, p.workspaceId).timezone));
  const today = ymdString(first);
  const last = ymdString(addDays(first, days - 1));
  const rows = app.db.all<Row>(
    `${SELECT} WHERE r.workspace_id = ? AND r.remind_on >= ? AND r.remind_on <= ? AND ${KEPT} ORDER BY r.remind_on, r.created_at, r.id`, p.workspaceId, today, last);
  return { today, days, reminders: rows.map(dto) };
}

/**
 * Tell about the reminders whose day has come, once each: the bell, and email when allowed. Marking them told and
 * recording the notification happen in one transaction, so a failure leaves them to be told on the next run and a
 * second run never repeats them. Days missed by more than STALE_DAYS (the server was off) are marked without telling.
 * With notifications off, or the Reminders choice off, nobody is told either. Returns how many were told about.
 */
export function runItemReminders(app: App, workspaceId: string, accountId: string, now: Date = new Date()): number {
  const prefs = getPreferences(app, workspaceId);
  const first = localDate(now, validTimezone(prefs.timezone));
  const today = ymdString(first);
  const stale = ymdString(addDays(first, -STALE_DAYS));
  const iso = now.toISOString();
  const told = app.db.tx(() => {
    const due = app.db.all<Row>(
      `${SELECT} WHERE r.workspace_id = ? AND r.notified_at IS NULL AND r.remind_on <= ? AND ${KEPT} ORDER BY r.remind_on, r.id`, workspaceId, today);
    if (!due.length) return null;
    for (const r of due) app.db.run("UPDATE item_reminders SET notified_at = ? WHERE id = ?", iso, r.id);
    const current = due.filter((r) => r.remind_on >= stale);
    if (!current.length || prefs.notifications.frequency === "off" || !prefs.notifications.include.reminders) return null;
    const single = current.length === 1 ? current[0]! : null;
    // Titles and notes only when the person turned titles on, and never for a private source.
    const showText = prefs.notifications.previews && !!single && !single.is_private;
    const title = single ? (showText ? `Reminder: ${single.title}` : "A reminder you set is due") : `${current.length} reminders you set are due`;
    const made = app.db.run(
      "INSERT OR IGNORE INTO notifications (id, workspace_id, kind, title, body, item_id, dedup_key, created_at) VALUES (?, ?, 'reminder', ?, ?, ?, ?, ?)",
      newId("ntf"), workspaceId, title, showText ? single!.note : null, single?.item_id ?? null, `remind:${current[0]!.id}:${today}`, iso).changes;
    return made ? { current, showText } : null;
  });
  if (!told) return 0;
  emit(app, accountId, { type: "notification" });
  emailReminders(app, workspaceId, accountId, told.current, told.showText);
  return told.current.length;
}

/** Also email them, when the person allowed it, outgoing email is set up and the account's address is confirmed. */
function emailReminders(app: App, workspaceId: string, accountId: string, due: Row[], showText: boolean): void {
  if (!getPreferences(app, workspaceId).notifications.emailReminders) return;
  const account = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
  if (!account?.email || !account.email_verified_at) return;
  const link = (itemId: string) => `${app.config.publicOrigin}${appUrl("/")}?item=${encodeURIComponent(itemId)}`;
  sendLater(app, "reminder", accountId, reminderMail(account.email, {
    items: due.map((r) => ({ title: showText ? r.title : null, note: showText ? r.note : null, link: link(r.item_id) })),
  }));
}

/** A reminder is of no use 30 days after its day: delete those. */
export function pruneItemReminders(app: App, workspaceId: string, now: Date = new Date()): number {
  const cutoff = ymdString(addDays(localDate(now, validTimezone(getPreferences(app, workspaceId).timezone)), -30));
  return app.db.run("DELETE FROM item_reminders WHERE workspace_id = ? AND remind_on < ?", workspaceId, cutoff).changes;
}
