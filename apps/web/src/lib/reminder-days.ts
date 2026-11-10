/*
 * Days for "Remind me" and Home's "Coming up". A reminder's day is a calendar date ("2026-12-12") in the
 * person's own time zone, never an instant, so these work on the date text and use UTC only as a neutral calendar.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): [number, number, number] {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Not a day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The calendar day an instant has in a time zone, "YYYY-MM-DD"; the device's own zone when none (or an unusable one) is given. */
export function dayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }); }
  const get = (type: string) => fmt.formatToParts(now).find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000);
}

/** "Today", "Tomorrow", or the weekday and date ("Fri 14 Nov", with the year when it is not this year). */
export function dayLabel(day: string, today: string, locale?: string): string {
  const diff = daysBetween(today, day);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const [y, m, d] = parts(day);
  const sameYear = y === parts(today)[0];
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
