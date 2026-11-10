/** One clock formatter per time zone: building a formatter is far slower than using one. */
const clocks = new Map<string, Intl.DateTimeFormat>();
function clock(timeZone: string): Intl.DateTimeFormat {
  let f = clocks.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }); clocks.set(timeZone, f); }
  return f;
}

/**
 * Whether `now` falls inside the quiet window (HH:MM, may cross midnight) in the given time zone. The one rule
 * for quiet hours: browser alerts in the web app and phone notifications sent by the server both use it.
 */
export function inQuietHours(now: Date, start: string | null, end: string | null, timeZone: string): boolean {
  if (!start || !end || start === end) return false;
  const parts = clock(timeZone).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const cur = h * 60 + m;
  const s = toMinutes(start), e = toMinutes(end);
  if (s === null || e === null) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

function toMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < 24 * 60 ? v : null;
}
