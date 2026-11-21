/*
 * Dates on list pages: ISO forms, English and Dutch month names, numeric day-first and month-first
 * forms, month and year only, a day without a year, and relative expressions ("3 hours ago").
 * Also which of these PHP's strtotime reads the same way, because the bridge that runs a page-list
 * recipe parses the date text with it.
 */

export type DatePrecision = "time" | "day" | "month" | "relative" | "noYear";

export type ParsedDate = {
  /** `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` or `YYYY-MM`. */
  iso: string;
  precision: DatePrecision;
  kind: "absolute" | "relative";
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  januari: 1, februari: 2, maart: 3, mrt: 3, mei: 5, juni: 6, juli: 7, augustus: 8, oktober: 10, okt: 10,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_RE = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|ma|di|wo|do|vr|za|zo)";
const WEEKDAY_FULL = new RegExp(`^${WEEKDAY_RE}$`);
const DAYFIRST_LANGS = new Set(["nl", "de", "fr", "es", "it", "pt", "pl", "sv", "da", "nb", "no"]);
const DAYFIRST_REGIONS = new Set(["en-gb", "en-au", "en-nz", "en-ie", "en-in"]);

const ISO_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?(?:\[[^\]]+\])?/g;
const YMD_SLASH_RE = /(?<!\d)(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?!\d)/g;
const NUM_RE = /(?<![\d/.-])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d/.-])/g;
const MY_SLASH_RE = /(?<![\d/.])(\d{1,2})\/(\d{2})(?![\d/.])/g;
const DMY_NAME_RE = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|e|ste|de)?\\.?\\s*(?:of\\s+)?(${MONTH_RE})\\b\\.?,?\\s*(\\d{4}|\\d{2}\\b)?`, "gi");
const MDY_NAME_RE = new RegExp(`\\b(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?`, "gi");
const MY_NAME_RE = new RegExp(`\\b(${MONTH_RE})\\b\\.?,?\\s+(\\d{4})\\b`, "gi");
const REL_RE = /\b(?:(\d+|an?|one|een|1)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|h|days?|d|weeks?|w|months?|years?|seconden|minuten?|uur|uren|dagen|dag|weken|week|maanden|maand|jaren|jaar)\s*(?:ago|geleden)\b)/i;
const REL_WORD_RE = /\b(just now|yesterday|today|gisteren|vandaag|eergisteren|nu zojuist|zojuist)\b/i;
const TIME_RE = /(?<!\d)(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|AM|PM)?/g;

type Found = ParsedDate & { start: number };

function isDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(2000 + (y % 400), m, 0)).getUTCDate();
  return d <= last;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function mk(y: number, m: number, d: number, start: number, precision: DatePrecision = "day"): Found | null {
  if (!isDate(y, m, d)) return null;
  return { iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, precision, kind: "absolute", start };
}

function year2(y: number): number {
  return y < 70 ? 2000 + y : 1900 + y;
}

function inferYear(m: number, d: number, now: Date): number {
  let best: { gap: number; year: number } | null = null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    if (!isDate(y, m, d)) continue;
    const gap = Math.abs(Date.UTC(y, m - 1, d) - today);
    if (best === null || gap < best.gap) best = { gap, year: y };
  }
  return best ? best.year : now.getUTCFullYear();
}

function timeIn(text: string, from: number): string | null {
  TIME_RE.lastIndex = from;
  const m = TIME_RE.exec(text.slice(0, from + 24));
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const ap = (m[3] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

function parseRelative(text: string, now: Date): ParsedDate | null {
  const stamp = (t: Date) => `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  const m = REL_RE.exec(text);
  if (m) {
    const word = m[1]!.toLowerCase();
    const n = ["a", "an", "one", "een"].includes(word) ? 1 : Number(word);
    const u = m[2]!.toLowerCase();
    const minute = 60_000;
    const ms = u.startsWith("sec") || u === "s" ? 1000
      : u.startsWith("min") || u === "m" ? minute
      : u === "h" || u === "hr" || u === "hrs" || u.startsWith("hour") || u === "uur" || u === "uren" ? 60 * minute
      : u === "d" || u.startsWith("day") || u === "dag" || u === "dagen" ? 1440 * minute
      : u === "w" || u.startsWith("week") ? 10_080 * minute
      : u.startsWith("month") || u.startsWith("maand") ? 43_200 * minute
      : 525_600 * minute;
    return { iso: stamp(new Date(now.getTime() - n * ms)), precision: "relative", kind: "relative" };
  }
  const w = REL_WORD_RE.exec(text);
  if (w) {
    const word = w[1]!.toLowerCase();
    const back = word === "yesterday" || word === "gisteren" ? 1 : word === "eergisteren" ? 2 : 0;
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    const t = timeIn(text, w.index + w[0].length);
    return { iso: `${pad(day.getUTCFullYear(), 4)}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}${t ? `T${t}` : ""}`, precision: "relative", kind: "relative" };
  }
  return null;
}

/** Whether a day-before-month reading is the local convention for this page language. */
function dayFirst(lang: string): boolean {
  const l = lang.toLowerCase();
  return DAYFIRST_LANGS.has(l.split("-")[0]!) || DAYFIRST_REGIONS.has(l);
}

function parseAbsolute(text: string, lang: string, now: Date): ParsedDate | null {
  // Every absolute form has a digit; most text on a page has none worth reading as a date.
  if (!/\d/.test(text)) return null;
  const t = text.replace(/\u00a0/g, " ");
  const df = dayFirst(lang);
  const found: Found[] = [];
  for (const m of t.matchAll(ISO_RE)) {
    const r = mk(Number(m[1]), Number(m[2]), Number(m[3]), m.index);
    if (!r) continue;
    if (m[4]) {
      r.iso += `T${m[4]}:${m[5]}`;
      r.precision = "time";
    }
    found.push(r);
  }
  for (const m of t.matchAll(YMD_SLASH_RE)) {
    const r = mk(Number(m[1]), Number(m[2]), Number(m[3]), m.index);
    if (r) found.push(r);
  }
  for (const m of t.matchAll(DMY_NAME_RE)) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2]!.toLowerCase()]!;
    const ys = m[3];
    const r = ys ? mk(ys.length === 4 ? Number(ys) : year2(Number(ys)), mo, d, m.index) : mk(inferYear(mo, d, now), mo, d, m.index, "noYear");
    if (!r) continue;
    const tm = timeIn(t, m.index + m[0].length);
    if (tm && r.precision === "day") {
      r.iso += `T${tm}`;
      r.precision = "time";
    }
    found.push(r);
  }
  for (const m of t.matchAll(MDY_NAME_RE)) {
    const mo = MONTHS[m[1]!.toLowerCase()]!;
    const d = Number(m[2]);
    const ys = m[3];
    const r = ys ? mk(Number(ys), mo, d, m.index) : mk(inferYear(mo, d, now), mo, d, m.index, "noYear");
    if (!r) continue;
    const tm = timeIn(t, m.index + m[0].length);
    if (tm && r.precision === "day") {
      r.iso += `T${tm}`;
      r.precision = "time";
    }
    found.push(r);
  }
  for (const m of t.matchAll(NUM_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const ys = m[3]!;
    const y = ys.length === 4 ? Number(ys) : year2(Number(ys));
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : df ? [a, b] : [b, a];
    const r = mk(y, mo, d, m.index);
    if (!r) continue;
    const tm = timeIn(t, m.index + m[0].length);
    if (tm) {
      r.iso += `T${tm}`;
      r.precision = "time";
    }
    found.push(r);
  }
  if (!found.length) {
    for (const m of t.matchAll(MY_NAME_RE)) {
      found.push({ iso: `${pad(Number(m[2]), 4)}-${pad(MONTHS[m[1]!.toLowerCase()]!)}`, precision: "month", kind: "absolute", start: m.index });
    }
  }
  if (!found.length) {
    for (const m of t.matchAll(MY_SLASH_RE)) {
      const mo = Number(m[1]);
      const yy = Number(m[2]);
      if (mo >= 1 && mo <= 12 && yy >= 20) found.push({ iso: `${pad(year2(yy), 4)}-${pad(mo)}`, precision: "month", kind: "absolute", start: m.index });
    }
  }
  if (!found.length) return null;
  const first = found.reduce((best, r) => (r.start < best.start ? r : best));
  return { iso: first.iso, precision: first.precision, kind: first.kind };
}

/** The first absolute date in the text, or null. `lang` is the page's language (`en-US`, `nl`). */
export function parseAbsoluteDate(text: string, lang: string, now: Date): ParsedDate | null {
  return parseAbsolute(text, lang, now);
}

/** An absolute date first, then a relative expression. */
export function parseDate(text: string, lang: string, now: Date): ParsedDate | null {
  if (!text || !text.trim()) return null;
  return parseAbsolute(text, lang, now) ?? parseRelative(text, now);
}

const FILLER = new Set(["at", "om", "uur", "utc", "gmt", "cet", "cest", "am", "pm", "ago", "geleden", "posted", "updated", "published", "on", "op", "by", "of", "the", "st", "nd", "rd", "th",
  "min", "mins", "minutes", "hours", "hour", "days", "day", "h", "d", "m", "s", "w", "yesterday", "today", "gisteren", "vandaag", "week", "weken", "just", "now", "z", "t", "e", "u", "j", "k", "n", "r",
  "gepubliceerd", "datum", "date", "minuten"]);

/** True when the text is essentially only a date, so an element holding it is a date element. */
export function looksLikeDateOnly(text: string, lang: string, now: Date = new Date()): boolean {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  if (!parseDate(t, lang, now)) return false;
  for (const w of t.replace(/[^\p{L}]+/gu, " ").match(/\p{L}+/gu) ?? []) {
    const lw = w.toLowerCase();
    if (lw in MONTHS || WEEKDAY_FULL.test(lw) || FILLER.has(lw)) continue;
    return false;
  }
  return true;
}

// ---- what PHP's strtotime reads

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EN_MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const EN_WEEKDAY = "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const EN_CLOCK = String.raw`(?:[ ,]+\d{1,2}:\d{2}(?::\d{2})?(?: ?(?:am|pm))?(?: ?(?:utc|gmt|z|[+-]\d{2}:?\d{2}))?)?`;
const EN_DMY = new RegExp(String.raw`^(?:(${EN_WEEKDAY}),? )?(\d{1,2})(?:st|nd|rd|th)? (${EN_MONTH})\.?,? (\d{4})${EN_CLOCK}$`, "i");
const EN_MDY = new RegExp(String.raw`^(?:(${EN_WEEKDAY}),? )?(${EN_MONTH})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})${EN_CLOCK}$`, "i");
const DASH_DMY = /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/;
const SLASH_MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const SLASH_YMD = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/**
 * Whether PHP's strtotime reads this text as the date the page means. Only forms it is known to read the same
 * way count: ISO, English month names with a year, `d-m-Y` and `d.m.Y`, `m/d/Y` and `Y/m/d`. A date without a
 * year, a Dutch month name, a day-first date with slashes and a relative expression are not among them.
 */
export function strtotimeReadsAs(text: string, parsed: ParsedDate | null): boolean {
  if (!parsed || parsed.kind !== "absolute" || (parsed.precision !== "day" && parsed.precision !== "time")) return false;
  const t = text.trim();
  const ymd = parsed.iso.slice(0, 10);
  const same = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}` === ymd;
  if (STRICT_ISO.test(t)) return t.slice(0, 10) === ymd;
  // A weekday that is not the date's weekday makes PHP move to the next such weekday, so it must agree.
  const weekdayAgrees = (name: string | undefined) => !name || ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${ymd}T00:00:00Z`).getUTCDay()] === name.slice(0, 3).toLowerCase();
  let m = EN_DMY.exec(t);
  if (m) return weekdayAgrees(m[1]) && same(Number(m[4]), MONTHS[monthKey(m[3]!)]!, Number(m[2]));
  m = EN_MDY.exec(t);
  if (m) return weekdayAgrees(m[1]) && same(Number(m[4]), MONTHS[monthKey(m[2]!)]!, Number(m[3]));
  m = DASH_DMY.exec(t);
  if (m) return same(Number(m[3]), Number(m[2]), Number(m[1]));
  m = SLASH_MDY.exec(t);
  if (m) return same(Number(m[3]), Number(m[1]), Number(m[2]));
  m = SLASH_YMD.exec(t);
  if (m) return same(Number(m[1]), Number(m[2]), Number(m[3]));
  return false;
}

function monthKey(name: string): string {
  const k = name.toLowerCase().replace(/\.$/, "");
  return k in MONTHS ? k : (Object.keys(MONTHS).find((x) => x.length >= 3 && k.startsWith(x)) ?? k);
}

/** Whether an attribute value is a date PHP's strtotime reads without doubt (`YYYY-MM-DD`, optionally with a time and zone). */
export function isStrictIsoDate(value: string): boolean {
  return STRICT_ISO.test(value.trim());
}
