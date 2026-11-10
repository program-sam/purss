import { newId } from "@purss/domain";
import type { ReminderDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { notFound } from "../http.ts";
import { getPreferences } from "./preferences.ts";
import { usableAccountSql } from "./deletion.ts";

/*
 * Personal rediscovery (plan/09): "On this day" reminders over items the owner kept in a
 * basket on this month and day in an earlier year, using the recorded keep date only.
 * No remote fetch is made; an unavailable original still shows its retained snapshot.
 *
 * Reminders are persisted (one row per item per local date) so a restart or a second
 * request never creates the same reminder again. A hidden reminder stays hidden. A snoozed
 * reminder returns on the next local day and is shown only on that day.
 */

type Ymd = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA zone name; anything else falls back to UTC. */
export function validTimezone(tz: string | null | undefined): string {
  const name = tz && tz.trim() ? tz.trim() : "UTC";
  if (formatters.has(name)) return name;
  try {
    formatters.set(name, new Intl.DateTimeFormat("en-CA", { timeZone: name, year: "numeric", month: "2-digit", day: "2-digit" }));
    return name;
  } catch {
    return "UTC";
  }
}

/** The calendar date an instant has in a time zone. */
export function localDate(instant: Date | number | string, tz: string): Ymd {
  const zone = validTimezone(tz);
  const fmt = formatters.get(zone)!;
  const when = instant instanceof Date ? instant : new Date(instant);
  const parts = fmt.formatToParts(when);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const ymdString = (v: Ymd) => `${pad(v.y, 4)}-${pad(v.m)}-${pad(v.d)}`;

export function addDays(v: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Does an item kept on `kept` (its local date when kept) have its anniversary on `today`?
 * Only earlier years count. A leap-day keep returns on February 29 in leap years and on
 * February 28 in the other years.
 */
export function isAnniversary(kept: Ymd, today: Ymd): boolean {
  if (kept.y >= today.y) return false;
  let m = kept.m;
  let d = kept.d;
  if (m === 2 && d === 29 && !isLeapYear(today.y)) d = 28;
  return m === today.m && d === today.d;
}

/** UTC month-day strings ("MM-DD") a matching keep could have, allowing for the zone offset. */
function candidateMonthDays(today: Ymd): string[] {
  const targets: [number, number][] = [[today.m, today.d]];
  if (today.m === 2 && today.d === 28 && !isLeapYear(today.y)) targets.push([2, 29]);
  const out = new Set<string>();
  for (const [m, d] of targets) {
    for (const shift of [-1, 0, 1]) {
      const t = new Date(Date.UTC(2000, m - 1, d + shift)); // 2000 is a leap year, so Feb 29 exists
      out.add(`${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
    }
  }
  return [...out];
}

type Candidate = {
  basket_id: string; item_id: string; kept_at: string; title: string; source_title: string | null; basket_name: string;
  version_has_content: number; has_fulltext: number;
};

const CAPTURE_LABEL = {
  metadata: "Saved details (title, link and summary)",
  feed: "Feed content saved",
  fulltext: "Full text captured",
} as const;

function captureLabel(c: { version_has_content: number; has_fulltext: number }): string {
  return c.has_fulltext ? CAPTURE_LABEL.fulltext : c.version_has_content ? CAPTURE_LABEL.feed : CAPTURE_LABEL.metadata;
}

/**
 * Today's reminders for a PURSS, creating any that are missing. Safe to call any number
 * of times; returns [] when reminders are switched off.
 */
export function remindersForToday(app: App, workspaceId: string, accountId: string, now: Date = new Date()): ReminderDTO[] {
  const prefs = getPreferences(app, workspaceId);
  if (!prefs.reminders) return [];
  const tz = validTimezone(prefs.timezone);
  const today = localDate(now, tz);
  const forDate = ymdString(today);
  const ts = now.toISOString();

  const days = candidateMonthDays(today);
  const candidates = app.db.all<Candidate>(
    `SELECT b.basket_id, b.item_id, b.kept_at, i.title, s.title AS source_title, k.name AS basket_name,
            (v.content_html IS NOT NULL) AS version_has_content,
            EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status = 'done' AND c.quality IS NOT 'partial') AS has_fulltext
     FROM basket_items b
     JOIN items i ON i.id = b.item_id
     JOIN item_state st ON st.item_id = i.id
     JOIN baskets k ON k.id = b.basket_id
     JOIN item_versions v ON v.id = b.version_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE b.workspace_id = ? AND st.workflow <> 'ignored' AND substr(b.kept_at, 6, 5) IN (${days.map(() => "?").join(",")})
     ORDER BY b.kept_at, b.basket_id`,
    workspaceId, ...days,
  );

  const firstPerItem = new Map<string, Candidate>();
  for (const c of candidates) {
    if (firstPerItem.has(c.item_id)) continue;
    if (isAnniversary(localDate(c.kept_at, tz), today)) firstPerItem.set(c.item_id, c);
  }

  app.db.tx(() => {
    for (const c of firstPerItem.values()) {
      app.db.run(
        "INSERT OR IGNORE INTO reminders (id, workspace_id, item_id, basket_id, kept_at, for_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        newId("rem"), workspaceId, c.item_id, c.basket_id, c.kept_at, forDate, ts,
      );
    }
  });

  // Shown reminders for today plus snoozed ones that return today; never ignored, removed or unkept items.
  const rows = app.db.all<{ id: string; status: string; item_id: string; basket_id: string; kept_at: string; title: string; source_title: string | null; basket_name: string; version_has_content: number; has_fulltext: number }>(
    `SELECT r.id, r.status, r.item_id, r.basket_id, r.kept_at, i.title, s.title AS source_title, k.name AS basket_name,
            (v.content_html IS NOT NULL) AS version_has_content,
            EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status = 'done' AND c.quality IS NOT 'partial') AS has_fulltext
     FROM reminders r
     JOIN items i ON i.id = r.item_id
     JOIN item_state st ON st.item_id = i.id
     JOIN basket_items b ON b.basket_id = r.basket_id AND b.item_id = r.item_id
     JOIN baskets k ON k.id = r.basket_id
     JOIN item_versions v ON v.id = b.version_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE r.workspace_id = ? AND st.workflow <> 'ignored'
       AND ((r.for_date = ? AND r.status = 'shown') OR (r.status = 'snoozed' AND r.snoozed_until = ?))
     ORDER BY r.kept_at, r.id`,
    workspaceId, forDate, forDate,
  );
  const seen = new Set<string>();
  const out: ReminderDTO[] = [];
  for (const r of rows) {
    if (seen.has(r.item_id)) continue; // a returning snooze and a fresh match for the same item
    // A reminder created under another time zone only counts if the keep date still matches today here.
    if (r.status === "shown" && !isAnniversary(localDate(r.kept_at, tz), today)) continue;
    seen.add(r.item_id);
    out.push({
      id: r.id, itemId: r.item_id, title: r.title, sourceTitle: r.source_title ?? "Saved link", basketName: r.basket_name,
      keptAt: r.kept_at, captureLabel: captureLabel(r),
    });
  }

  if (out.length && prefs.notifications.frequency !== "off" && prefs.notifications.include.reminders) {
    // Private sources' titles never go into notifications (they can show on a lock screen).
    const single = out.length === 1 ? out[0]! : null;
    const isPrivate = single ? !!app.db.get("SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.is_private = 1", single.itemId) : false;
    const body = prefs.notifications.previews && single && !isPrivate ? single.title : null;
    const created = app.db.run(
      "INSERT OR IGNORE INTO notifications (id, workspace_id, kind, title, body, dedup_key, created_at) VALUES (?, ?, 'reminder', ?, ?, ?, ?)",
      newId("ntf"), workspaceId, out.length === 1 ? "On this day: 1 thing you kept" : `On this day: ${out.length} things you kept`, body, `reminder:${forDate}`, ts,
    ).changes;
    if (created) emit(app, accountId, { type: "notification" });
  }
  return out;
}

export function listReminders(app: App, p: Principal, now: Date = new Date()): ReminderDTO[] {
  return remindersForToday(app, p.workspaceId, p.accountId, now);
}

/** Hide ends this reminder for good; snooze brings it back on the next local day. */
export function reminderAction(app: App, p: Principal, id: string, action: "hide" | "snooze", now: Date = new Date()): { ok: true } {
  const row = app.db.get<{ id: string }>("SELECT id FROM reminders WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!row) throw notFound("That reminder");
  if (action === "hide") {
    app.db.run("UPDATE reminders SET status = 'hidden', snoozed_until = NULL WHERE id = ?", id);
  } else {
    const tz = validTimezone(getPreferences(app, p.workspaceId).timezone);
    const tomorrow = ymdString(addDays(localDate(now, tz), 1));
    app.db.run("UPDATE reminders SET status = 'snoozed', snoozed_until = ? WHERE id = ?", tomorrow, id);
  }
  return { ok: true };
}

/** Maintenance pass for the periodic tick: creates today's reminders (and their one daily notification) for every PURSS. */
export function runReminderPass(app: App, now: Date = new Date()): number {
  const rows = app.db.all<{ id: string; account_id: string }>(`SELECT w.id, w.account_id FROM workspaces w WHERE ${usableAccountSql("w.account_id")}`);
  let n = 0;
  for (const w of rows) n += remindersForToday(app, w.id, w.account_id, now).length;
  return n;
}
