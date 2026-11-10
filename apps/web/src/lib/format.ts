/** Small, pure formatting helpers. Everything takes `now` and a time zone so results are testable. */

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/**
 * Intl formatters are slow to build (about a millisecond each) and lists format a date on every row, so each
 * language and option set is built once. An unknown locale or time zone still throws, and is not kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>();
function cached<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(kind: string, locale: string | undefined, options: object, make: () => T): T {
  const key = `${kind}|${locale ?? ""}|${JSON.stringify(options)}`;
  let f = formatters.get(key) as T | undefined;
  if (!f) { f = make(); formatters.set(key, f); }
  return f;
}
export function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  return cached("d", locale, options, () => new Intl.DateTimeFormat(locale, options));
}
function relativeFormat(locale: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached("r", locale, options, () => new Intl.RelativeTimeFormat(locale, options));
}

/** A count in the browser's language, with its thousands separator ("21,413", "21.413"). */
export function formatCount(n: number, locale = browserLocale()): string {
  try { return cached("n", locale, {}, () => new Intl.NumberFormat(locale)).format(n); } catch { return String(n); }
}

export function plural(n: number, word: string, many = `${word}s`, locale?: string): string {
  return `${formatCount(n, locale)} ${n === 1 ? word : many}`;
}

/** The browser's language, for the look of numbers. */
export function browserLocale(): string {
  try { return (typeof navigator !== "undefined" && navigator.language) || "en-GB"; } catch { return "en-GB"; }
}

/**
 * The language of the words in dates and relative times. The app's own words are English, so these read as English
 * whatever the browser is set to ("5 min. ago", never "5 min. geleden" in the middle of an English sentence); an
 * English browser keeps its own style ("Nov 6" for en-US, "6 Nov" for en-GB).
 */
export function interfaceLocale(): string {
  const l = browserLocale();
  return /^en(-|$)/i.test(l) ? l : "en-GB";
}

/**
 * "now", "5 min. ago", "3 hr. ago", "yesterday", "4 days ago", then a short date, in the interface
 * language. Days are calendar days in the PURSS time zone: "yesterday" is only ever yesterday,
 * so an item from the day before yesterday reads "2 days ago" even when it is under 48 hours old.
 */
export function timeAgo(iso: string | null, now = Date.now(), timeZone?: string, locale = interfaceLocale()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = now - t;
  const rtf = relativeFormat(locale, { numeric: "auto", style: "short" });
  if (d < MIN) return rtf.format(0, "second");
  if (d < HOUR) return rtf.format(-Math.floor(d / MIN), "minute");
  const days = dayNumber(dayKey(new Date(now).toISOString(), timeZone)) - dayNumber(dayKey(iso, timeZone));
  if (days <= 0) return rtf.format(-Math.floor(d / HOUR), "hour");
  if (days === 1 && d < 12 * HOUR) return rtf.format(-Math.floor(d / HOUR), "hour");
  if (days < 14) return rtf.format(-days, "day");
  return shortDate(iso, now, timeZone, locale);
}

/** "12 Mar", or "12 Mar 2024" for other years, in the interface language. */
export function shortDate(iso: string, now = Date.now(), timeZone?: string, locale = interfaceLocale()): string {
  const d = new Date(iso);
  const sameYear = yearOf(d, timeZone) === yearOf(new Date(now), timeZone);
  return dateFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone }).format(d);
}

/** Exact date and time, for provenance lines: "5 Nov 2026, 14:03". */
export function dateTime(iso: string | null, timeZone?: string, locale = interfaceLocale()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return dateFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(t));
}

function yearOf(d: Date, timeZone?: string): string {
  return dateFormat("en-GB", { year: "numeric", timeZone }).format(d);
}

/** Calendar day of an instant in a time zone as YYYY-MM-DD. */
export function dayKey(iso: string, timeZone?: string): string {
  return dateFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(iso));
}

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

/** "Today", "Yesterday", or "Monday 3 November", in the interface language. */
export function dayLabel(iso: string, now = Date.now(), timeZone?: string, locale = interfaceLocale()): string {
  const diff = dayNumber(dayKey(new Date(now).toISOString(), timeZone)) - dayNumber(dayKey(iso, timeZone));
  if (diff === 0 || diff === 1) {
    const word = relativeFormat(locale, { numeric: "auto" }).format(-diff, "day");
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
  }
  return dateFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date(iso));
}

export type DayGroup<T> = { key: string; label: string; items: T[] };

/** Group already-ordered items into consecutive calendar days. */
export function groupByDay<T>(items: readonly T[], when: (item: T) => string, now = Date.now(), timeZone?: string, locale = interfaceLocale()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const iso = when(item);
    const key = dayKey(iso, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(iso, now, timeZone, locale), items: [item] });
  }
  return groups;
}

/** 4:05 or 1:02:03 for a length in seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, "")} ${units[i]}`;
}
